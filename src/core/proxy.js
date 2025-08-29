const http = require('http');
const https = require('https');
const Helpers = require('../utils/helpers');

class ProxyCore {
  constructor(configManager, loadBalancer, authMiddleware, usageService, logger) {
    this.configManager = configManager;
    this.loadBalancer = loadBalancer;
    this.authMiddleware = authMiddleware;
    this.usageService = usageService;
    this.logger = logger;
    this.config = configManager.getServerConfig().proxy;
  }

  async handleRequest(req, res) {
    const requestId = Helpers.generateRequestId();
    req.requestId = requestId;
    const startTime = Date.now();
    
    this.logger.requestStart(requestId, req);
    
    try {
      // 收集请求体
      const requestBody = await this.collectRequestBody(req);
      
      // 认证和授权
      const authResult = await this.authMiddleware.authenticate(req, requestBody);
      if (!authResult.success) {
        return this.sendErrorResponse(res, authResult, requestId);
      }

      // 跳过认证的请求（如健康检查）
      if (authResult.skipAuth) {
        return this.handleSpecialRoutes(req, res, requestId);
      }

      const { tenant, model } = authResult;
      
      // 检查限额（如果有模型信息）
      if (model) {
        const usage = Helpers.extractTokenUsage(requestBody);
        if (usage) {
          const limitCheck = await this.usageService.checkLimitsExceeded(tenant.id, model, usage);
          if (limitCheck.exceeded) {
            this.logger.limitExceeded(requestId, tenant, model, limitCheck.exceededTypes);
            return this.sendErrorResponse(res, {
              success: false,
              error: 'limit_exceeded',
              message: limitCheck.message,
              statusCode: 429
            }, requestId);
          }
        }
      }

      // 选择上游服务器
      const upstream = this.loadBalancer.selectUpstream(requestId);
      
      // 执行代理请求
      await this.proxyRequest(req, res, upstream, requestBody, {
        requestId,
        tenant,
        model,
        startTime
      });

    } catch (error) {
      this.logger.proxyError(requestId, error);
      this.sendErrorResponse(res, {
        success: false,
        error: 'internal_error',
        message: '内部服务器错误',
        statusCode: 500
      }, requestId);
    }
  }

  async collectRequestBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let body = '';
      
      req.on('data', chunk => {
        chunks.push(chunk);
        body += chunk.toString();
      });

      req.on('end', () => {
        req.chunks = chunks; // 保存原始chunks用于转发
        resolve(body);
      });

      req.on('error', (error) => {
        this.logger.error('请求体收集错误', { error: error.message });
        resolve('');
      });
    });
  }

  async proxyRequest(req, res, upstream, requestBody, context) {
    const { requestId, tenant, model, startTime } = context;
    
    return new Promise((resolve) => {
      try {
        // 处理路径重写
        const originalUrl = req.url;
        const rewrittenUrl = this.rewriteUrl(originalUrl, upstream);
        
        // 创建代理选项，使用重写后的URL
        const options = Helpers.createProxyOptions(upstream, req, rewrittenUrl);
        options.headers = Helpers.setupProxyHeaders(options.headers, upstream, req);
        
        this.logger.proxyRequest(requestId, upstream, options);

        // 选择HTTP模块
        const proxyModule = options.isHttps ? https : http;
        
        const proxyReq = proxyModule.request(options, (proxyRes) => {
          this.logger.proxyResponse(requestId, proxyRes.statusCode, proxyRes.headers, upstream);
          
          // 收集响应数据用于用量统计
          let responseBody = '';
          const responseChunks = [];
          
          // 转发响应状态和头部
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          
          proxyRes.on('data', (chunk) => {
            responseChunks.push(chunk);
            responseBody += chunk.toString();
            res.write(chunk);
          });
          
          proxyRes.on('end', async () => {
            const duration = Date.now() - startTime;
            res.end();
            
            // 记录用量（如果有租户信息）
            if (tenant) {
              await this.recordUsage(requestId, tenant, model, requestBody, responseBody, {
                duration,
                statusCode: proxyRes.statusCode,
                upstream: upstream.id,
                userAgent: req.headers['user-agent'],
                clientIP: Helpers.getClientIP(req)
              });
            }
            
            this.logger.requestEnd(requestId, proxyRes.statusCode, duration, responseBody.length);
            resolve();
          });
        });

        // 错误处理
        proxyReq.on('error', (error) => {
          this.logger.proxyError(requestId, error, upstream);
          
          if (!res.headersSent) {
            const errorResponse = Helpers.createErrorResponse(
              'upstream_error',
              '上游服务器错误: ' + error.message,
              502,
              requestId
            );
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorResponse, null, 2));
          }
          resolve();
        });

        // 超时处理
        proxyReq.setTimeout(this.config.timeout, () => {
          this.logger.proxyError(requestId, new Error('请求超时'), upstream);
          proxyReq.destroy();
        });

        // 发送请求体
        if (req.chunks && req.chunks.length > 0) {
          req.chunks.forEach(chunk => proxyReq.write(chunk));
        }
        proxyReq.end();

      } catch (error) {
        this.logger.proxyError(requestId, error, upstream);
        resolve();
      }
    });
  }

  // 路径重写函数
  rewriteUrl(originalUrl, upstream) {
    // 如果请求路径以 /anthropic 开头，进行路径重写
    if (originalUrl.startsWith('/anthropic')) {
      // 移除 /anthropic 前缀，保留后面的路径
      const pathAfterAnthropicPrefix = originalUrl.slice(10); // "/anthropic".length = 10
      
      // 根据上游服务器的URL构造新路径
      const upstreamUrl = new URL(upstream.url);
      
      // 如果上游URL有路径（如 http://b.com/api），则拼接
      if (upstreamUrl.pathname && upstreamUrl.pathname !== '/') {
        return upstreamUrl.pathname + pathAfterAnthropicPrefix;
      } else {
        // 如果上游URL没有路径（如 http://a.com），直接使用原路径去掉anthropic前缀
        return pathAfterAnthropicPrefix || '/';
      }
    }
    
    // 非 /anthropic 路径直接返回原路径
    return originalUrl;
  }

  async recordUsage(requestId, tenant, model, requestBody, responseBody, metadata) {
    try {
      // 从请求体提取模型（如果之前没有）
      if (!model) {
        model = Helpers.extractModelFromBody(requestBody);
      }
      
      // 从响应体提取token使用量
      const tokenUsage = Helpers.extractTokenUsage(responseBody);
      
      const usage = {
        requestId,
        model: model || 'unknown',
        inputTokens: tokenUsage?.inputTokens || 0,
        outputTokens: tokenUsage?.outputTokens || 0,
        cacheCreationTokens: tokenUsage?.cacheCreationTokens || 0,
        cacheReadTokens: tokenUsage?.cacheReadTokens || 0,
        duration: metadata.duration,
        statusCode: metadata.statusCode,
        upstream: metadata.upstream,
        userAgent: metadata.userAgent,
        clientIP: metadata.clientIP,
        metadata: {
          hasRequestBody: !!requestBody,
          requestBodySize: requestBody ? requestBody.length : 0,
          responseBodySize: responseBody ? responseBody.length : 0
        }
      };

      await this.usageService.recordUsage(tenant.id, usage);
      this.logger.usageRecorded(requestId, tenant, usage);
      
    } catch (error) {
      this.logger.error('用量记录失败', {
        requestId,
        tenantId: tenant.id,
        error: error.message
      });
    }
  }

  handleSpecialRoutes(req, res, requestId) {
    // 健康检查
    if (req.url === '/health') {
      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        upstreams: this.loadBalancer.getUpstreamStats(),
        requestId
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    // 默认404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'not_found',
      message: '路径未找到',
      requestId
    }, null, 2));
  }

  sendErrorResponse(res, authResult, requestId = null) {
    const errorResponse = this.authMiddleware.generateErrorResponse(authResult);
    errorResponse.body = JSON.parse(errorResponse.body);
    
    if (requestId) {
      errorResponse.body.requestId = requestId;
    }
    
    res.writeHead(errorResponse.statusCode, errorResponse.headers);
    res.end(JSON.stringify(errorResponse.body, null, 2));
  }

  // 重新加载配置
  reload() {
    this.config = this.configManager.getServerConfig().proxy;
    this.loadBalancer.reload();
    console.log('🔄 代理核心配置已重新加载');
  }
}

module.exports = ProxyCore;
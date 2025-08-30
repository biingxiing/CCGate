const http = require('http');
const fs = require('fs');
const path = require('path');
const ConfigManager = require('./config');
const LoadBalancer = require('./core/loadBalancer');
const AuthMiddleware = require('./core/auth');
const ProxyCore = require('./core/proxy');
const OpenAICompatLayer = require('./core/openaiCompat');
const TenantService = require('./services/tenantService');
const UsageService = require('./services/usageService');
const UsageRoutes = require('./routes/usageRoutes');
const Logger = require('./utils/logger');
const Helpers = require('./utils/helpers');

class CCGateApp {
  constructor() {
    this.server = null;
    this.setupComponents();
  }

  setupComponents() {
    // 初始化配置管理器
    this.configManager = ConfigManager;
    
    // 初始化日志系统
    this.logger = new Logger(this.configManager);
    
    // 初始化负载均衡器
    this.loadBalancer = new LoadBalancer(this.configManager);
    
    // 初始化认证中间件
    this.authMiddleware = new AuthMiddleware(this.configManager);
    
    // 初始化服务
    this.tenantService = new TenantService(this.configManager);
    this.usageService = new UsageService(this.configManager);
    
    // 初始化代理核心
    this.proxyCore = new ProxyCore(
      this.configManager,
      this.loadBalancer,
      this.authMiddleware,
      this.usageService,
      this.logger
    );
    
    // 初始化用量查询路由
    this.usageRoutes = new UsageRoutes(
      this.configManager,
      this.usageService,
      this.loadBalancer,
      this.logger
    );
    
    // 初始化OpenAI兼容层
    this.openaiCompatLayer = new OpenAICompatLayer(
      this.configManager,
      this.proxyCore,
      this.logger
    );
    
    console.log('✅ 所有组件初始化完成');
  }

  createServer() {
    this.server = http.createServer(async (req, res) => {
      const startTime = Date.now();
      
      try {
        // 设置CORS头（如果需要）
        this.setCorsHeaders(res);
        
        // 处理OPTIONS请求
        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }
        
        // 路由分发
        if (req.url === '/dashboard' || req.url === '/' || req.url === '/usage.html') {
          // 提供用量查询页面
          await this.serveUsagePage(req, res);
        } else if (req.url.startsWith('/usage')) {
          await this.usageRoutes.handleUsageRequest(req, res);
        } else if (req.url === '/health') {
          // 健康检查
          await this.handleHealthCheck(req, res);
        } else if (req.url.startsWith('/openai/v1/chat/completions')) {
          // OpenAI兼容层处理
          await this.openaiCompatLayer.handleOpenAICompatRequest(req, res);
        } else if (req.url.startsWith('/anthropic')) {
          // 统一的 Anthropic API 路径处理
          await this.proxyCore.handleRequest(req, res);
        } else {
          await this.proxyCore.handleRequest(req, res);
        }
        
        // 记录访问日志
        const duration = Date.now() - startTime;
        this.logger.access(req, res, duration);
        
      } catch (error) {
        this.logger.error('请求处理错误', {
          error: error.message,
          stack: error.stack,
          url: req.url,
          method: req.method
        });
        
        if (!res.headersSent) {
          const errorResponse = Helpers.createErrorResponse(
            'internal_error',
            '内部服务器错误',
            500
          );
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse, null, 2));
        }
      }
    });

    // 服务器错误处理
    this.server.on('error', (error) => {
      this.logger.error('服务器错误', { error: error.message });
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ 端口 ${this.getPort()} 已被占用`);
        process.exit(1);
      }
    });

    // 优雅关闭处理
    this.setupGracefulShutdown();
    
    return this.server;
  }

  setCorsHeaders(res) {
    // 始终设置CORS头部，支持前端访问
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // 提供用量查询页面
  async serveUsagePage(req, res) {
    try {
      const htmlPath = path.join(__dirname, '..', 'public', 'usage.html');
      const htmlContent = await fs.promises.readFile(htmlPath, 'utf8');
      
      res.writeHead(200, { 
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(htmlContent);
      
    } catch (error) {
      this.logger.error('提供用量页面失败', { error: error.message });
      
      // 如果文件不存在，返回简单的HTML页面
      const fallbackHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>CCGate 用量查询</title>
</head>
<body>
    <h1>CCGate 用量查询</h1>
    <p>用量查询页面暂不可用，请联系管理员。</p>
</body>
</html>`;
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fallbackHtml);
    }
  }

  // 健康检查处理
  async handleHealthCheck(req, res) {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
  }

  setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach(signal => {
      process.on(signal, () => {
        console.log(`\n🛑 收到 ${signal} 信号，开始优雅关闭...`);
        this.gracefulShutdown();
      });
    });

    process.on('uncaughtException', (error) => {
      this.logger.error('未捕获的异常', {
        error: error.message,
        stack: error.stack
      });
      console.error('💥 未捕获的异常:', error);
      this.gracefulShutdown(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('未处理的Promise拒绝', {
        reason: reason?.message || reason,
        stack: reason?.stack
      });
      console.error('💥 未处理的Promise拒绝:', reason);
      this.gracefulShutdown(1);
    });
  }

  async gracefulShutdown(exitCode = 0) {
    console.log('⏳ 正在关闭服务器...');
    
    try {
      // 关闭HTTP服务器
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
        console.log('✅ HTTP服务器已关闭');
      }
      
      // 销毁负载均衡器
      if (this.loadBalancer) {
        this.loadBalancer.destroy();
        console.log('✅ 负载均衡器已销毁');
      }
      
      // 这里可以添加更多清理逻辑
      // 比如关闭数据库连接、清理临时文件等
      
      console.log('✅ 优雅关闭完成');
      process.exit(exitCode);
      
    } catch (error) {
      console.error('❌ 优雅关闭时出错:', error);
      process.exit(1);
    }
  }

  start() {
    const serverConfig = this.configManager.getServerConfig().server;
    const port = serverConfig.port;
    const host = serverConfig.host;
    
    this.createServer();
    
    this.server.listen(port, host, () => {
      this.displayStartupMessage(port, host);
      this.logger.info('CCGate服务器启动', {
        port,
        host,
        upstreams: this.loadBalancer.getUpstreamStats().total,
        tenants: this.tenantService.getTenantStats().total
      });
    });
  }

  displayStartupMessage(port, host) {
    const upstreamStats = this.loadBalancer.getUpstreamStats();
    const tenantStats = this.tenantService.getTenantStats();
    
    const message = `
╔══════════════════════════════════════╗
║           🚀 CCGate 已启动            ║
╠══════════════════════════════════════╣
║ 🌐 服务地址: http://${host}:${port.toString().padEnd(12)} ║
║ 🎯 上游服务: ${upstreamStats.total.toString().padStart(2)} 个 (${upstreamStats.healthy} 健康)        ║  
║ 👥 租户数量: ${tenantStats.total.toString().padStart(2)} 个 (${tenantStats.enabled} 启用)        ║
║ ❤️  健康检查: /health                  ║
║ 📊 用量查询: /dashboard                ║
╚══════════════════════════════════════╝
`;
    
    console.log(message);
    
    // 显示配置摘要
    if (upstreamStats.upstreams.length > 0) {
      console.log('📋 上游服务列表:');
      upstreamStats.upstreams.forEach(upstream => {
        const status = upstream.healthy ? '✅' : '❌';
        const weight = upstream.weight || 100;
        console.log(`   ${status} ${upstream.name} - ${upstream.url} (权重: ${weight})`);
      });
    }
    
    console.log('\n💡 用量查询功能:');
    const adminConfig = this.configManager.getServerConfig().admin;
    if (adminConfig.enabled) {
      console.log(`   管理员用户名: ${adminConfig.username}`);
      console.log(`   管理员密码: ${adminConfig.password === 'changeme' ? '⚠️  请修改默认密码!' : '***'}`);
      console.log('   🔗 访问地址: http://' + host + ':' + port + '/dashboard');
    } else {
      console.log('   ⚠️  管理员查询已禁用，仅支持租户查询');
    }
    
    console.log('\n🔄 使用 Ctrl+C 优雅关闭服务器');
    console.log('');
  }

  getPort() {
    return this.configManager.getServerConfig().server.port;
  }

  // 重新加载配置
  reload() {
    console.log('🔄 重新加载应用配置...');
    
    this.configManager.reloadConfig();
    this.proxyCore.reload();
    this.openaiCompatLayer.reload();
    
    console.log('✅ 配置重新加载完成');
  }
}

module.exports = CCGateApp;
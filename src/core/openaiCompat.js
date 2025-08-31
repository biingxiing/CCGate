const FormatConverter = require('../utils/formatConverter');

class OpenAICompatLayer {
  constructor(configManager, proxyCore, logger) {
    this.configManager = configManager;
    this.proxyCore = proxyCore;
    this.logger = logger;
    this.formatConverter = new FormatConverter();
    this.config = configManager.getServerConfig().openai;
  }

  async handleOpenAICompatRequest(req, res) {
    const requestId = req.requestId || require('../utils/helpers').generateRequestId();
    const startTime = Date.now();
    
    try {
      // 检查OpenAI兼容层是否启用
      if (!this.config || !this.config.enabled) {
        return this.sendErrorResponse(res, {
          error: 'service_unavailable',
          message: 'OpenAI 兼容层未启用',
          statusCode: 503
        }, requestId);
      }


      // 收集OpenAI格式请求体
      const openaiBody = await this.collectRequestBody(req);
      let openaiRequest;

      try {
        openaiRequest = JSON.parse(openaiBody);
      } catch (parseError) {
        return this.sendErrorResponse(res, {
          error: 'invalid_request_error',
          message: '请求体JSON格式错误',
          statusCode: 400
        }, requestId);
      }


      // 转换为Claude格式
      const claudeRequest = this.formatConverter.convertOpenAIToClaude(
        openaiRequest, 
        this.config.models || {},
        this.config.defaultModel
      );


      // 如果是流式请求，需要特殊处理响应转换
      if (claudeRequest.stream) {
        return await this.handleStreamingRequest(req, res, claudeRequest, requestId, startTime);
      } else {
        return await this.handleNonStreamingRequest(req, res, claudeRequest, requestId, startTime);
      }

    } catch (error) {
      this.logger.error('OpenAI兼容请求处理错误', {
        requestId,
        error: error.message,
        stack: error.stack
      });

      return this.sendErrorResponse(res, {
        error: 'internal_error',
        message: '内部服务器错误',
        statusCode: 500
      }, requestId);
    }
  }

  async handleNonStreamingRequest(req, res, claudeRequest, requestId, startTime) {
    // 修改请求路径和body，走现有代理流程
    const originalUrl = req.url;
    req.url = '/anthropic/v1/messages';
    
    // 重新构建请求体chunks
    const claudeBodyString = JSON.stringify(claudeRequest);
    req.chunks = [Buffer.from(claudeBodyString)];
    
    // 更新Content-Length头部
    req.headers['content-length'] = claudeBodyString.length;
    
    // 保持原始requestId
    req.requestId = requestId;

    this.logger.info('转发到Claude API', {
      requestId,
      originalUrl,
      newUrl: req.url,
      model: claudeRequest.model,
      maxTokens: claudeRequest.max_tokens,
      requestBodySize: claudeBodyString.length
    });

    // 拦截响应以进行格式转换
    const originalWrite = res.write;
    const originalEnd = res.end;
    let responseData = '';

    res.write = function(chunk) {
      responseData += chunk.toString();
      return true;
    };

    const self = this;
    res.end = function(data) {
      if (data) {
        responseData += data.toString();
      }

      // 转换Claude响应为OpenAI格式
      try {
        const openaiResponse = self.formatConverter.convertClaudeToOpenAI(responseData, false);
        
        res.write = originalWrite;
        res.end = originalEnd;
        
        // 检查响应头是否已经发送，避免重复设置
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
        }

        res.end(JSON.stringify(openaiResponse, null, 2));
      } catch (convertError) {
        self.logger.error('响应格式转换失败', {
          requestId,
          error: convertError.message,
          rawResponse: responseData.substring(0, 500)
        });

        res.write = originalWrite;
        res.end = originalEnd;
        
        // 检查响应是否已经发送，避免重复发送
        if (!res.headersSent) {
          const errorResponse = self.formatConverter.convertErrorResponse({
            message: '响应格式转换失败',
            type: 'internal_error'
          }, requestId);

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse, null, 2));
        } else {
          // 如果头部已发送，只能结束响应，不能再发送新内容
          originalEnd.call(res);
        }
      }
    };

    // 调用现有代理核心处理
    await this.proxyCore.handleRequest(req, res);
  }

  async handleStreamingRequest(req, res, claudeRequest, requestId, startTime) {
    // 修改请求路径和body
    const originalUrl = req.url;
    req.url = '/anthropic/v1/messages';
    
    const claudeBodyString = JSON.stringify(claudeRequest);
    req.chunks = [Buffer.from(claudeBodyString)];
    
    // 更新Content-Length头部
    req.headers['content-length'] = claudeBodyString.length;
    
    // 保持原始requestId
    req.requestId = requestId;


    // 拦截流式响应并转换格式
    const originalWrite = res.write;
    const originalEnd = res.end;
    const originalWriteHead = res.writeHead;
    
    let isFirstChunk = true;
    let totalChunks = 0;
    let hasResponseStarted = false;
    
    // 拦截writeHead以确保正确的响应头
    res.writeHead = (statusCode, headers) => {
      hasResponseStarted = true;
      return originalWriteHead.call(res, statusCode || 200, {
        ...headers,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
    };
    
    res.write = (chunk) => {
      try {
        const chunkStr = chunk.toString();
        totalChunks++;
        
        
        const convertedChunk = this.formatConverter.convertStreamingResponse(chunkStr);
        
        if (convertedChunk) {
          isFirstChunk = false;
          return originalWrite.call(res, convertedChunk);
        }
        return true;
      } catch (error) {
        this.logger.error('流式响应转换错误', {
          requestId,
          error: error.message,
          stack: error.stack,
          chunk: chunk.toString().substring(0, 200)
        });
        return originalWrite.call(res, chunk);
      }
    };

    res.end = (data) => {
      const duration = Date.now() - startTime;

      if (data) {
        res.write(data);
      }
      
      // 发送最后的 [DONE] 消息
      const doneMessage = 'data: [DONE]\n\n';
      originalWrite.call(res, doneMessage);
      
      originalEnd.call(res);
    };

    // 调用现有代理核心处理
    await this.proxyCore.handleRequest(req, res);
  }

  async collectRequestBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let body = '';
      
      req.on('data', chunk => {
        chunks.push(chunk);
        body += chunk.toString();
      });

      req.on('end', () => {
        resolve(body);
      });

      req.on('error', (error) => {
        this.logger.error('请求体收集错误', { error: error.message });
        reject(error);
      });
    });
  }

  sendErrorResponse(res, error, requestId = null) {
    const openaiError = this.formatConverter.convertErrorResponse(error, requestId);
    
    res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openaiError, null, 2));
  }

  // 重新加载配置
  reload() {
    this.config = this.configManager.getServerConfig().openai;
  }
}

module.exports = OpenAICompatLayer;
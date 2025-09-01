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
    
    
    try {
      // 检查OpenAI兼容层是否启用
      if (!this.config || !this.config.enabled) {
        this.logger.warn('OpenAI兼容层未启用', { requestId, config: this.config });
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
        this.logger.error('请求体JSON解析错误', {
          requestId,
          error: parseError.message,
          bodyPreview: openaiBody.substring(0, 500)
        });
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
        return await this.handleStreamingRequest(req, res, claudeRequest, requestId);
      } else {
        return await this.handleNonStreamingRequest(req, res, claudeRequest, requestId);
      }

    } catch (error) {
      this.logger.error('OpenAI兼容请求处理错误', {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      return this.sendErrorResponse(res, {
        error: 'internal_error',
        message: '内部服务器错误',
        statusCode: 500
      }, requestId);
    }
  }

  async handleNonStreamingRequest(req, res, claudeRequest, requestId) {
    // 统一化请求头部，避免上游服务器差异化处理
    this.normalizeRequestHeaders(req);
    
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
    const originalWriteHead = res.writeHead;
    let responseData = '';
    let responseChunks = [];

    // 拦截writeHead以阻止代理核心设置响应头
    res.writeHead = function() {
      // 暂时不设置响应头，等待完整响应收集完成后再设置
      return true;
    };

    res.write = function(chunk) {
      // 收集响应数据，但不实际写入到客户端
      const chunkStr = chunk.toString();
      responseData += chunkStr;
      responseChunks.push(chunk);
      
      
      return true; // 不调用原始write，完全拦截响应
    };

    const self = this;
    res.end = function(data) {
      // 收集最后的数据块
      if (data) {
        const dataStr = data.toString();
        responseData += dataStr;
        responseChunks.push(data);
      }


      // 转换Claude响应为OpenAI格式
      try {
        const openaiResponse = self.formatConverter.convertClaudeToOpenAI(responseData, false);
        
        // 恢复原始方法
        res.write = originalWrite;
        res.end = originalEnd;
        res.writeHead = originalWriteHead;
        
        const responseBody = JSON.stringify(openaiResponse, null, 2);
        
        
        // 直接设置响应头并发送完整响应
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(responseBody, 'utf8')
        });
        res.end(responseBody);
        
      } catch (convertError) {
        self.logger.error('响应格式转换失败', {
          requestId,
          error: convertError.message,
          stack: convertError.stack,
          rawResponseSize: responseData.length
        });

        // 恢复原始方法
        res.write = originalWrite;
        res.end = originalEnd;
        res.writeHead = originalWriteHead;
        
        // 发送错误响应
        const errorResponse = self.formatConverter.convertErrorResponse({
          message: '响应格式转换失败',
          type: 'internal_error'
        }, requestId);

        const errorBody = JSON.stringify(errorResponse, null, 2);
        res.writeHead(500, { 
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(errorBody, 'utf8')
        });
        res.end(errorBody);
      }
    };

    // 调用现有代理核心处理
    await this.proxyCore.handleRequest(req, res);
  }

  async handleStreamingRequest(req, res, claudeRequest, requestId) {
    // 统一化请求头部，避免上游服务器差异化处理
    this.normalizeRequestHeaders(req);
    
    // 修改请求路径和body
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
    
    let totalChunks = 0;
    
    // 拦截writeHead以确保正确的响应头
    res.writeHead = (statusCode, headers) => {
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

  normalizeRequestHeaders(req) {
    // 移除浏览器特有的安全头部，这些头部可能导致上游服务器拒绝请求
    const headersToRemove = [
      'referer',
      'origin', 
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform'
    ];
    
    headersToRemove.forEach(header => {
      delete req.headers[header];
    });
    
    // 统一User-Agent为成功客户端的标识
    req.headers['user-agent'] = 'CCGate-OpenAI-Compat/1.0 (compatible; NextChat)';
    
  }

  sendErrorResponse(res, error, requestId = null) {
    const openaiError = this.formatConverter.convertErrorResponse(error, requestId);
    
    // 打印错误响应详情
    this.logger.error('发送错误响应', {
      requestId,
      statusCode: error.statusCode || 500,
      errorType: error.error,
      errorMessage: error.message,
    });
    
    const errorBody = JSON.stringify(openaiError, null, 2);
    res.writeHead(error.statusCode || 500, { 
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(errorBody, 'utf8')
    });
    res.end(errorBody);
  }

  // 重新加载配置
  reload() {
    this.config = this.configManager.getServerConfig().openai;
  }
}

module.exports = OpenAICompatLayer;
const crypto = require('crypto');
const url = require('url');

class Helpers {
  // 生成请求ID
  static generateRequestId() {
    return crypto.randomBytes(8).toString('hex');
  }

  // 解析请求体
  static parseRequestBody(body) {
    try {
      return typeof body === 'string' ? JSON.parse(body) : body;
    } catch (error) {
      return null;
    }
  }

  // 获取客户端IP
  static getClientIP(req) {
    return req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           req.headers['x-forwarded-for'] || 
           'unknown';
  }

  // 提取模型信息
  static extractModelFromBody(body) {
    try {
      const parsed = this.parseRequestBody(body);
      return parsed?.model || null;
    } catch {
      return null;
    }
  }

  // 提取token使用量
  static extractTokenUsage(responseBody) {
    try {
      // 如果是普通JSON响应
      const parsed = this.parseRequestBody(responseBody);
      if (parsed?.usage) {
        const usage = parsed.usage;
        return {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationTokens: usage.cache_creation_input_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0
        };
      }
      
      // 如果是SSE流响应，解析message_start和message_delta事件
      if (typeof responseBody === 'string' && (responseBody.includes('event: message_start') || responseBody.includes('event: message_delta'))) {
        const lines = responseBody.split('\n');
        let totalUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0
        };
        
        let currentEvent = null;
        let eventData = '';
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          
          // 检测事件类型
          if (trimmedLine.startsWith('event: ')) {
            // 处理之前的事件数据
            if (currentEvent && eventData) {
              const usage = this.parseSSEUsageData(currentEvent, eventData);
              if (usage) {
                // 累加token使用量，message_delta会覆盖message_start的数据
                if (currentEvent === 'message_start' || currentEvent === 'message_delta') {
                  totalUsage = usage;
                }
              }
            }
            
            currentEvent = trimmedLine.substring(7); // 移除 'event: '
            eventData = '';
          } else if (trimmedLine.startsWith('data: ')) {
            eventData = trimmedLine.substring(6); // 移除 'data: '
          }
        }
        
        // 处理最后一个事件
        if (currentEvent && eventData) {
          const usage = this.parseSSEUsageData(currentEvent, eventData);
          if (usage) {
            totalUsage = usage;
          }
        }
        
        // 如果找到了有效的usage数据
        if (totalUsage.inputTokens > 0 || totalUsage.outputTokens > 0 || 
            totalUsage.cacheCreationTokens > 0 || totalUsage.cacheReadTokens > 0) {
          return totalUsage;
        }
      }
      
      return null;
    } catch {
      return null;
    }
  }

  // 解析SSE事件中的usage数据
  static parseSSEUsageData(eventType, eventData) {
    try {
      if (eventType === 'message_start') {
        const messageStart = JSON.parse(eventData);
        const usage = messageStart.message?.usage;
        
        if (usage) {
          return {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0
          };
        }
      } else if (eventType === 'message_delta') {
        const messageDelta = JSON.parse(eventData);
        const usage = messageDelta.usage;
        
        if (usage) {
          return {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0
          };
        }
      }
      
      return null;
    } catch {
      return null;
    }
  }

  // 创建错误响应
  static createErrorResponse(error, message, statusCode = 500, requestId = null) {
    return {
      error: {
        type: error,
        message: message,
        requestId: requestId,
        timestamp: new Date().toISOString()
      }
    };
  }

  // 解析URL
  static parseURL(urlString) {
    try {
      return new URL(urlString);
    } catch (error) {
      throw new Error(`无效的URL格式: ${urlString}`);
    }
  }

  // 创建代理选项
  static createProxyOptions(upstream, originalReq, customPath = null) {
    const targetUrl = this.parseURL(upstream.url);
    const isHttps = targetUrl.protocol === 'https:';
    
    return {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: customPath || originalReq.url,
      method: originalReq.method,
      headers: { ...originalReq.headers },
      protocol: targetUrl.protocol,
      isHttps
    };
  }

  // 设置代理头部
  static setupProxyHeaders(headers, upstream, originalReq) {
    const targetUrl = this.parseURL(upstream.url);
    
    // 设置目标主机
    headers.host = targetUrl.host;
    
    // 密钥替换：如果配置了上游密钥，直接替换
    if (upstream.key) {
      headers.authorization = `Bearer ${upstream.key}`;
      // 移除客户端可能的其他认证头
      delete headers['x-api-key'];
    }
    
    // 清理可能引起问题的头部
    delete headers['content-length']; // 会由Node.js自动设置
    
    return headers;
  }

  // 验证JSON格式
  static isValidJSON(str) {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  // 安全地截断字符串用于日志
  static truncateForLog(str, maxLength = 2000) {
    if (typeof str !== 'string') {
      return str;
    }
    
    if (str.length <= maxLength) {
      return str;
    }
    
    return str.substring(0, maxLength) + '...[截断]';
  }

  // 格式化字节大小
  static formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // 格式化持续时间
  static formatDuration(ms) {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }

  // 延迟函数
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 重试机制
  static async retry(fn, maxAttempts = 3, delayMs = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (attempt < maxAttempts) {
          await this.delay(delayMs * attempt);
        }
      }
    }
    
    throw lastError;
  }

  // 深度克隆对象
  static deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (obj instanceof Date) {
      return new Date(obj);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.deepClone(item));
    }
    
    const cloned = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = this.deepClone(obj[key]);
      }
    }
    
    return cloned;
  }

  // 合并对象
  static mergeDeep(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
          result[key] = this.mergeDeep(result[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    
    return result;
  }

  // 验证配置完整性
  static validateConfig(config, requiredFields) {
    const missing = [];
    
    requiredFields.forEach(field => {
      const fieldPath = field.split('.');
      let current = config;
      
      for (const path of fieldPath) {
        if (current && current.hasOwnProperty(path)) {
          current = current[path];
        } else {
          missing.push(field);
          break;
        }
      }
    });
    
    if (missing.length > 0) {
      throw new Error(`缺少必需的配置字段: ${missing.join(', ')}`);
    }
  }

  // 生成随机字符串
  static generateRandomString(length = 32, charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return result;
  }

  // 计算对象哈希
  static calculateHash(obj, algorithm = 'sha256') {
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    return crypto.createHash(algorithm).update(str).digest('hex');
  }

  // 检查端口是否可用
  static async isPortAvailable(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
      const server = require('net').createServer();
      
      server.listen(port, host, () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      
      server.on('error', () => resolve(false));
    });
  }


  // 清理敏感信息
  static sanitizeForLog(obj, sensitiveFields = ['key', 'token', 'password', 'secret']) {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    const sanitized = { ...obj };
    
    sensitiveFields.forEach(field => {
      if (sanitized[field]) {
        const value = sanitized[field];
        if (typeof value === 'string' && value.length > 8) {
          sanitized[field] = value.substring(0, 4) + '***' + value.substring(value.length - 4);
        } else {
          sanitized[field] = '***';
        }
      }
    });
    
    return sanitized;
  }

  // 通配符匹配函数
  static matchPattern(pattern, text) {
    if (!pattern || !text) {
      return false;
    }

    // 完全匹配
    if (pattern === '*') {
      return true;
    }

    // 精确匹配
    if (pattern === text) {
      return true;
    }

    // 转换通配符模式为正则表达式
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
      .replace(/\*/g, '.*'); // 将 * 替换为 .*

    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(text);
    } catch (error) {
      console.warn(`通配符模式无效 '${pattern}':`, error.message);
      return false;
    }
  }

  // 在数组中查找匹配的模式
  static findMatchingPattern(patterns, text) {
    if (!Array.isArray(patterns) || !text) {
      return null;
    }

    for (const pattern of patterns) {
      if (this.matchPattern(pattern, text)) {
        return pattern;
      }
    }

    return null;
  }

  // 根据通配符模式查找匹配的限制配置
  static findMatchingLimits(limitsConfig, modelName) {
    if (!limitsConfig || !modelName) {
      return null;
    }

    // 首先尝试精确匹配
    if (limitsConfig[modelName]) {
      return limitsConfig[modelName];
    }

    // 然后尝试通配符匹配
    for (const pattern of Object.keys(limitsConfig)) {
      if (this.matchPattern(pattern, modelName)) {
        return limitsConfig[pattern];
      }
    }

    return null;
  }
}

module.exports = Helpers;
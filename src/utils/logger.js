const fs = require('fs');
const path = require('path');

class Logger {
  constructor(configManager) {
    this.configManager = configManager;
    this.config = configManager.getServerConfig().logging;
    this.logDir = path.resolve(this.config.directory);
    this.combinedLog = path.join(this.logDir, 'combined.log');
    this.errorLog = path.join(this.logDir, 'error.log');
    this.accessLog = path.join(this.logDir, 'access.log');
    
    this.ensureLogDirectory();
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  rotateLogIfNeeded(logFile) {
    try {
      const stats = fs.statSync(logFile);
      const maxSize = this.parseSize(this.config.maxFileSize);
      
      if (stats.size > maxSize) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rotatedFile = `${logFile}.${timestamp}`;
        fs.renameSync(logFile, rotatedFile);
        
        this.cleanupOldLogs(logFile);
      }
    } catch (error) {
      // 文件不存在或其他错误，忽略
    }
  }

  cleanupOldLogs(logFile) {
    try {
      const logDir = path.dirname(logFile);
      const baseName = path.basename(logFile);
      const logFiles = fs.readdirSync(logDir)
        .filter(file => file.startsWith(baseName) && file !== baseName)
        .sort()
        .reverse();
      
      if (logFiles.length > this.config.maxFiles) {
        logFiles.slice(this.config.maxFiles).forEach(file => {
          fs.unlinkSync(path.join(logDir, file));
        });
      }
    } catch (error) {
      console.warn('清理旧日志文件失败:', error.message);
    }
  }

  parseSize(sizeStr) {
    const match = sizeStr.match(/^(\d+)(MB|GB|KB)?$/i);
    if (!match) return 100 * 1024 * 1024; // 默认100MB
    
    const size = parseInt(match[1]);
    const unit = (match[2] || 'MB').toLowerCase();
    
    switch (unit) {
      case 'kb': return size * 1024;
      case 'mb': return size * 1024 * 1024;
      case 'gb': return size * 1024 * 1024 * 1024;
      default: return size * 1024 * 1024;
    }
  }

  formatLogEntry(level, message, data = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data
    };
  }

  writeToFile(logFile, entry) {
    try {
      this.rotateLogIfNeeded(logFile);
      const logLine = JSON.stringify(entry) + '\n';
      fs.appendFileSync(logFile, logLine);
    } catch (error) {
      console.error(`写入日志文件失败 ${logFile}:`, error.message);
    }
  }

  writeToConsole(entry) {
    if (!this.config.enableConsole) return;
    
    const timestamp = entry.timestamp;
    const message = entry.message;
    const data = { ...entry };
    delete data.timestamp;
    delete data.level;
    delete data.message;

    const hasData = Object.keys(data).length > 0;
    const dataStr = hasData ? JSON.stringify(data) : '';

    switch (entry.level) {
      case 'error':
        console.error(`[${timestamp}] ERROR: ${message}`, hasData ? data : '');
        break;
      case 'warn':
        console.warn(`[${timestamp}] WARN: ${message}`, hasData ? data : '');
        break;
      case 'info':
      default:
        console.log(`[${timestamp}] INFO: ${message}`, hasData ? data : '');
        break;
    }
  }

  log(level, message, data = {}) {
    const entry = this.formatLogEntry(level, message, data);
    
    // 写入综合日志
    this.writeToFile(this.combinedLog, entry);
    
    // 错误日志单独写入
    if (level === 'error') {
      this.writeToFile(this.errorLog, entry);
    }
    
    // 输出到控制台
    this.writeToConsole(entry);
  }

  info(message, data = {}) {
    this.log('info', message, data);
  }

  warn(message, data = {}) {
    this.log('warn', message, data);
  }

  error(message, data = {}) {
    this.log('error', message, data);
  }

  // 访问日志记录
  access(req, res, duration, authResult = null) {
    const clientIP = req.connection.remoteAddress || 
                     req.socket.remoteAddress || 
                     req.headers['x-forwarded-for'] || 
                     'unknown';

    const accessEntry = this.formatLogEntry('access', '请求访问', {
      method: req.method,
      url: req.url,
      userAgent: req.headers['user-agent'] || 'unknown',
      clientIP,
      statusCode: res.statusCode,
      duration,
      contentLength: req.headers['content-length'] || 0,
      tenantId: authResult?.tenant?.id || null,
      requestId: req.requestId || null
    });

    this.writeToFile(this.accessLog, accessEntry);
  }

  // 请求开始日志
  requestStart(requestId, req) {
    this.info('请求开始', {
      requestId,
      method: req.method,
      url: req.url,
      clientIP: req.connection.remoteAddress || 
                req.socket.remoteAddress || 
                req.headers['x-forwarded-for'] || 
                'unknown',
      hasAuth: !!(req.headers.authorization || req.headers['x-api-key']),
      contentLength: req.headers['content-length'] || 0
    });
  }

  // 请求结束日志
  requestEnd(requestId, statusCode, duration, bytesWritten = 0) {
    this.info('请求完成', {
      requestId,
      statusCode,
      duration,
      bytesWritten
    });
  }

  // 代理请求日志
  proxyRequest(requestId, upstream, proxyOptions) {
    this.info('代理请求', {
      requestId,
      upstream: upstream.name,
      target: `${proxyOptions.protocol}//${proxyOptions.hostname}:${proxyOptions.port}${proxyOptions.path}`,
      method: proxyOptions.method,
      hasUpstreamKey: !!upstream.key,
      authHeader: proxyOptions.headers.authorization ? 
        proxyOptions.headers.authorization.substring(0, 12) + '***' : 'none'
    });
  }

  // 代理响应日志
  proxyResponse(requestId, statusCode, headers, upstream) {
    const level = statusCode >= 400 ? 'warn' : 'info';
    const message = statusCode >= 400 ? '上游错误响应' : '上游响应';
    
    this.log(level, message, {
      requestId,
      upstream: upstream.name,
      statusCode,
      contentType: headers['content-type'],
      contentLength: headers['content-length']
    });
  }

  // 代理错误日志
  proxyError(requestId, error, upstream) {
    this.error('代理请求错误', {
      requestId,
      upstream: upstream?.name || 'unknown',
      upstreamId: upstream?.id || 'unknown',
      errorName: error.name,
      errorMessage: error.message,
      errorCode: error.code,
      errorStack: error.stack
    });
  }

  // 认证日志
  authSuccess(requestId, tenant) {
    this.info('认证成功', {
      requestId,
      tenantId: tenant.id,
      tenantName: tenant.name
    });
  }

  authFailure(requestId, error, clientIP) {
    this.warn('认证失败', {
      requestId,
      error,
      clientIP
    });
  }

  // 限额检查日志
  limitExceeded(requestId, tenant, model, exceededTypes) {
    this.warn('超出限额', {
      requestId,
      tenantId: tenant.id,
      tenantName: tenant.name,
      model,
      exceededTypes
    });
  }

  // 用量记录日志
  usageRecorded(requestId, tenant, usage) {
    this.info('用量已记录', {
      requestId,
      tenantId: tenant.id,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens
    });
  }

}

module.exports = Logger;
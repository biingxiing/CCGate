class AuthMiddleware {
  constructor(configManager) {
    this.configManager = configManager;
    this.helpers = require('../utils/helpers');
  }

  // 从请求中提取认证信息
  extractAuthInfo(req) {
    // 尝试从 Authorization header 获取
    const authHeader = req.headers.authorization;
    if (authHeader) {
      // 支持 Bearer token 格式
      const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      if (bearerMatch) {
        return {
          type: 'bearer',
          token: bearerMatch[1]
        };
      }
      
      // 支持 API-Key 格式
      const apiKeyMatch = authHeader.match(/^API-Key\s+(.+)$/i);
      if (apiKeyMatch) {
        return {
          type: 'api-key',
          token: apiKeyMatch[1]
        };
      }
    }

    // 尝试从 x-api-key header 获取
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader) {
      return {
        type: 'api-key',
        token: apiKeyHeader
      };
    }

    // 尝试从查询参数获取
    const urlParts = require('url').parse(req.url, true);
    if (urlParts.query.api_key) {
      return {
        type: 'api-key',
        token: urlParts.query.api_key
      };
    }

    return null;
  }

  // 验证租户认证
  authenticateTenant(req) {
    const authInfo = this.extractAuthInfo(req);
    
    if (!authInfo) {
      return {
        success: false,
        error: 'missing_auth',
        message: '缺少认证信息',
        statusCode: 401
      };
    }

    // 查找租户
    const tenant = this.configManager.getTenantByKey(authInfo.token);
    
    if (!tenant) {
      return {
        success: false,
        error: 'invalid_key',
        message: '无效的API密钥',
        statusCode: 401
      };
    }

    if (!tenant.enabled) {
      return {
        success: false,
        error: 'tenant_disabled',
        message: '租户已禁用',
        statusCode: 403
      };
    }

    return {
      success: true,
      tenant: tenant,
      authInfo: authInfo
    };
  }

  // 检查模型权限
  checkModelPermission(tenant, model) {
    if (!tenant.allowedModels || !Array.isArray(tenant.allowedModels)) {
      return {
        success: false,
        error: 'no_model_config',
        message: '租户未配置允许的模型'
      };
    }

    // 使用通配符匹配检查模型权限
    const matchedPattern = this.helpers.findMatchingPattern(tenant.allowedModels, model);
    
    if (!matchedPattern) {
      return {
        success: false,
        error: 'model_not_allowed',
        message: `模型 ${model} 不在允许列表中`
      };
    }

    return {
      success: true,
      matchedPattern: matchedPattern
    };
  }

  // 提取请求中的模型信息
  extractModelFromRequest(req, body) {
    try {
      // 尝试从请求体中获取模型
      if (body && typeof body === 'object' && body.model) {
        return body.model;
      }

      // 尝试从URL路径中推断模型
      const urlPath = req.url;
      const modelMatch = urlPath.match(/\/v1\/chat\/completions/);
      if (modelMatch) {
        // 默认返回通用模型标识，需要从请求体中获取具体模型
        return null;
      }

      return null;
    } catch (error) {
      console.warn('提取模型信息时出错:', error.message);
      return null;
    }
  }

  // 完整的认证中间件
  async authenticate(req, requestBody) {
    // 健康检查和管理接口跳过认证
    if (req.url === '/health' || req.url.startsWith('/admin')) {
      return {
        success: true,
        skipAuth: true
      };
    }

    // 认证租户
    const authResult = this.authenticateTenant(req);
    if (!authResult.success) {
      return authResult;
    }

    const { tenant } = authResult;

    // 提取模型信息
    let model = null;
    if (requestBody) {
      try {
        const parsedBody = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
        model = this.extractModelFromRequest(req, parsedBody);
      } catch (error) {
        console.warn('解析请求体失败:', error.message);
      }
    }

    // 如果能提取到模型，检查模型权限
    if (model) {
      const modelCheck = this.checkModelPermission(tenant, model);
      if (!modelCheck.success) {
        return {
          success: false,
          error: modelCheck.error,
          message: modelCheck.message,
          statusCode: 403
        };
      }
    }

    return {
      success: true,
      tenant: tenant,
      model: model,
      authInfo: authResult.authInfo
    };
  }

  // 生成错误响应
  generateErrorResponse(authResult) {
    const errorResponse = {
      error: {
        type: authResult.error,
        message: authResult.message,
        timestamp: new Date().toISOString()
      }
    };

    // 根据错误类型添加不同的 WWW-Authenticate header
    const headers = {
      'Content-Type': 'application/json'
    };

    if (authResult.statusCode === 401) {
      headers['WWW-Authenticate'] = 'Bearer realm="CCGate API", charset="UTF-8"';
    }

    return {
      statusCode: authResult.statusCode,
      headers: headers,
      body: JSON.stringify(errorResponse, null, 2)
    };
  }
}

module.exports = AuthMiddleware;
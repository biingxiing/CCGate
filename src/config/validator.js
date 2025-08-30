class ConfigValidator {
  validateServerConfig(config) {
    if (!config.server) {
      throw new Error('缺少 server 配置');
    }
    if (!config.server.port || typeof config.server.port !== 'number') {
      throw new Error('server.port 必须是数字');
    }
    if (config.server.port < 1 || config.server.port > 65535) {
      throw new Error('server.port 必须在 1-65535 范围内');
    }

    // 验证OpenAI配置（可选）
    if (config.openai) {
      this.validateOpenAIConfig(config.openai);
    }
  }

  validateOpenAIConfig(openaiConfig) {
    if (typeof openaiConfig.enabled !== 'boolean') {
      throw new Error('openai.enabled 必须是布尔值');
    }
    
    if (openaiConfig.enabled) {
      if (!openaiConfig.models || typeof openaiConfig.models !== 'object') {
        throw new Error('openai.models 必须是对象');
      }
      
      // 验证模型映射
      Object.keys(openaiConfig.models).forEach(openaiModel => {
        const claudeModel = openaiConfig.models[openaiModel];
        if (typeof claudeModel !== 'string' || claudeModel.trim() === '') {
          throw new Error(`openai.models.${openaiModel} 必须是非空字符串`);
        }
      });
    }
  }

  validateUpstreamsConfig(config) {
    if (!config.upstreams || !Array.isArray(config.upstreams)) {
      throw new Error('upstreams 必须是数组');
    }
    if (config.upstreams.length === 0) {
      throw new Error('至少需要配置一个上游服务');
    }
    
    config.upstreams.forEach((upstream, index) => {
      this.validateUpstream(upstream, `upstreams[${index}]`);
    });

    if (!config.loadBalancer) {
      throw new Error('缺少 loadBalancer 配置');
    }
  }

  validateUpstream(upstream, prefix = 'upstream') {
    if (!upstream.id) {
      throw new Error(`${prefix}.id 是必填项`);
    }
    if (!upstream.url) {
      throw new Error(`${prefix}.url 是必填项`);
    }
    
    try {
      new URL(upstream.url);
    } catch (error) {
      throw new Error(`${prefix}.url 格式不正确`);
    }

    if (upstream.weight !== undefined) {
      if (typeof upstream.weight !== 'number' || upstream.weight < 0) {
        throw new Error(`${prefix}.weight 必须是非负数`);
      }
    }
  }

  validateTenantsConfig(config) {
    if (!config.tenants || !Array.isArray(config.tenants)) {
      throw new Error('tenants 必须是数组');
    }
    
    const ids = new Set();
    const keys = new Set();
    
    config.tenants.forEach((tenant, index) => {
      this.validateTenant(tenant, `tenants[${index}]`);
      
      if (ids.has(tenant.id)) {
        throw new Error(`租户 ID 重复: ${tenant.id}`);
      }
      ids.add(tenant.id);
      
      if (keys.has(tenant.key)) {
        throw new Error(`租户密钥重复: ${tenant.key}`);
      }
      keys.add(tenant.key);
    });
  }

  validateTenant(tenant, prefix = 'tenant') {
    if (!tenant.id) {
      throw new Error(`${prefix}.id 是必填项`);
    }
    if (!tenant.name) {
      throw new Error(`${prefix}.name 是必填项`);
    }
    if (!tenant.key) {
      throw new Error(`${prefix}.key 是必填项`);
    }
    
    if (!tenant.allowedModels || !Array.isArray(tenant.allowedModels)) {
      throw new Error(`${prefix}.allowedModels 必须是数组`);
    }
    
    if (tenant.limits && tenant.limits.daily) {
      Object.keys(tenant.limits.daily).forEach(model => {
        const limits = tenant.limits.daily[model];
        ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'].forEach(field => {
          if (limits[field] !== undefined && (typeof limits[field] !== 'number' || limits[field] < 0)) {
            throw new Error(`${prefix}.limits.daily.${model}.${field} 必须是非负数`);
          }
        });
      });
    }
  }
}

module.exports = new ConfigValidator();
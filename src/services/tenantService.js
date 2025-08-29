const crypto = require('crypto');

class TenantService {
  constructor(configManager) {
    this.configManager = configManager;
  }

  // 获取所有租户
  getAllTenants() {
    const config = this.configManager.getTenantsConfig();
    return config.tenants.map(tenant => this.sanitizeTenant(tenant));
  }

  // 获取单个租户
  getTenant(tenantId) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }
    return this.sanitizeTenant(tenant);
  }

  // 通过密钥获取租户
  getTenantByKey(key) {
    const tenant = this.configManager.getTenantByKey(key);
    if (!tenant) {
      throw new Error('无效的API密钥');
    }
    return this.sanitizeTenant(tenant);
  }

  // 创建新租户
  createTenant(tenantData) {
    // 验证必填字段
    if (!tenantData.name) {
      throw new Error('租户名称是必填项');
    }

    // 生成唯一ID和密钥
    const tenantId = tenantData.id || this.generateTenantId();
    const apiKey = tenantData.key || this.generateApiKey();

    // 检查ID和密钥是否重复
    if (this.configManager.getTenant(tenantId)) {
      throw new Error(`租户ID ${tenantId} 已存在`);
    }

    if (this.configManager.getTenantByKey(apiKey)) {
      throw new Error('API密钥已存在，请重新生成');
    }

    const newTenant = {
      id: tenantId,
      name: tenantData.name,
      key: apiKey,
      enabled: tenantData.enabled !== false, // 默认启用
      allowedModels: tenantData.allowedModels || ['claude-3-haiku'],
      limits: tenantData.limits || this.getDefaultLimits(),
      description: tenantData.description || '',
      metadata: tenantData.metadata || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const createdTenant = this.configManager.addTenant(newTenant);
    console.log(`✅ 租户创建成功: ${createdTenant.name} (${createdTenant.id})`);
    
    return this.sanitizeTenant(createdTenant);
  }

  // 更新租户
  updateTenant(tenantId, updates) {
    const existingTenant = this.configManager.getTenant(tenantId);
    if (!existingTenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    // 如果更新密钥，检查是否重复
    if (updates.key && updates.key !== existingTenant.key) {
      if (this.configManager.getTenantByKey(updates.key)) {
        throw new Error('API密钥已存在');
      }
    }

    // 验证允许的模型列表
    if (updates.allowedModels) {
      if (!Array.isArray(updates.allowedModels)) {
        throw new Error('allowedModels 必须是数组');
      }
    }

    const updatedTenant = this.configManager.updateTenant(tenantId, updates);
    console.log(`✅ 租户更新成功: ${updatedTenant.name} (${updatedTenant.id})`);
    
    return this.sanitizeTenant(updatedTenant);
  }

  // 删除租户
  deleteTenant(tenantId) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    // 检查是否为默认租户
    if (tenant.id === 'default') {
      throw new Error('不能删除默认租户');
    }

    const deletedTenant = this.configManager.deleteTenant(tenantId);
    console.log(`✅ 租户删除成功: ${deletedTenant.name} (${deletedTenant.id})`);
    
    return this.sanitizeTenant(deletedTenant);
  }

  // 启用/禁用租户
  toggleTenantStatus(tenantId, enabled) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    const updatedTenant = this.configManager.updateTenant(tenantId, { enabled });
    const status = enabled ? '启用' : '禁用';
    console.log(`✅ 租户${status}成功: ${updatedTenant.name} (${updatedTenant.id})`);
    
    return this.sanitizeTenant(updatedTenant);
  }

  // 重新生成API密钥
  regenerateApiKey(tenantId) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    const newApiKey = this.generateApiKey();
    const updatedTenant = this.configManager.updateTenant(tenantId, { key: newApiKey });
    console.log(`✅ API密钥重新生成成功: ${updatedTenant.name} (${updatedTenant.id})`);
    
    return this.sanitizeTenant(updatedTenant);
  }

  // 更新租户限制
  updateTenantLimits(tenantId, limits) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    // 验证限制格式
    this.validateLimits(limits);

    const updatedTenant = this.configManager.updateTenant(tenantId, { limits });
    console.log(`✅ 租户限制更新成功: ${updatedTenant.name} (${updatedTenant.id})`);
    
    return this.sanitizeTenant(updatedTenant);
  }

  // 添加/移除允许的模型
  updateAllowedModels(tenantId, models) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    if (!Array.isArray(models)) {
      throw new Error('models 必须是数组');
    }

    const updatedTenant = this.configManager.updateTenant(tenantId, { allowedModels: models });
    console.log(`✅ 允许模型更新成功: ${updatedTenant.name} (${updatedTenant.id})`);
    
    return this.sanitizeTenant(updatedTenant);
  }

  // 获取租户统计信息
  getTenantStats() {
    const tenants = this.configManager.getTenantsConfig().tenants;
    
    return {
      total: tenants.length,
      enabled: tenants.filter(t => t.enabled).length,
      disabled: tenants.filter(t => !t.enabled).length,
      models: this.getUniqueModels(tenants),
      createdToday: tenants.filter(t => {
        const created = new Date(t.createdAt);
        const today = new Date();
        return created.toDateString() === today.toDateString();
      }).length
    };
  }

  // 搜索租户
  searchTenants(query, options = {}) {
    const tenants = this.configManager.getTenantsConfig().tenants;
    const { enabled, model, limit = 50, offset = 0 } = options;
    
    let results = tenants.filter(tenant => {
      // 名称搜索
      const nameMatch = !query || tenant.name.toLowerCase().includes(query.toLowerCase());
      
      // 状态过滤
      const statusMatch = enabled === undefined || tenant.enabled === enabled;
      
      // 模型过滤
      const modelMatch = !model || (tenant.allowedModels && tenant.allowedModels.includes(model));
      
      return nameMatch && statusMatch && modelMatch;
    });

    // 排序
    results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      tenants: results.map(tenant => this.sanitizeTenant(tenant)),
      total,
      offset,
      limit,
      hasMore: offset + limit < total
    };
  }

  // 生成租户ID
  generateTenantId() {
    return 'tenant_' + crypto.randomBytes(8).toString('hex');
  }

  // 生成API密钥
  generateApiKey() {
    return 'ccg_' + crypto.randomBytes(32).toString('hex');
  }

  // 获取默认限制配置
  getDefaultLimits() {
    return {
      daily: {
        'claude-3-haiku': {
          inputTokens: 1000000,
          outputTokens: 100000,
          cacheCreationTokens: 100000,
          cacheReadTokens: 1000000
        },
        'claude-3-sonnet': {
          inputTokens: 500000,
          outputTokens: 50000,
          cacheCreationTokens: 50000,
          cacheReadTokens: 500000
        },
        'claude-3-opus': {
          inputTokens: 100000,
          outputTokens: 10000,
          cacheCreationTokens: 10000,
          cacheReadTokens: 100000
        }
      }
    };
  }

  // 验证限制配置
  validateLimits(limits) {
    if (!limits || typeof limits !== 'object') {
      throw new Error('limits 必须是对象');
    }

    if (limits.daily && typeof limits.daily === 'object') {
      Object.keys(limits.daily).forEach(model => {
        const modelLimits = limits.daily[model];
        if (typeof modelLimits !== 'object') {
          throw new Error(`模型 ${model} 的限制配置必须是对象`);
        }
        
        ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'].forEach(field => {
          if (modelLimits[field] !== undefined && 
              (typeof modelLimits[field] !== 'number' || modelLimits[field] < 0)) {
            throw new Error(`模型 ${model} 的 ${field} 必须是非负数`);
          }
        });
      });
    }
  }

  // 获取所有唯一模型
  getUniqueModels(tenants) {
    const allModels = new Set();
    tenants.forEach(tenant => {
      if (tenant.allowedModels && Array.isArray(tenant.allowedModels)) {
        tenant.allowedModels.forEach(model => allModels.add(model));
      }
    });
    return Array.from(allModels);
  }

  // 清理租户信息（移除敏感信息）
  sanitizeTenant(tenant) {
    const sanitized = { ...tenant };
    
    // 可选择性地隐藏完整的API密钥
    if (sanitized.key) {
      sanitized.keyPreview = sanitized.key.substring(0, 8) + '...' + sanitized.key.substring(sanitized.key.length - 4);
    }
    
    return sanitized;
  }

  // 验证租户密钥格式
  isValidApiKey(key) {
    return typeof key === 'string' && key.length >= 8 && /^ccg_[a-f0-9]{64}$/.test(key);
  }
}

module.exports = TenantService;
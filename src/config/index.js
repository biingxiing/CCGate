const fs = require('fs');
const path = require('path');
const validator = require('./validator');

class ConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, '../../config');
    this.serverConfig = null;
    this.upstreamsConfig = null;
    this.tenantsConfig = null;
    this.loadAllConfigs();
  }

  loadAllConfigs() {
    this.loadServerConfig();
    this.loadUpstreamsConfig();
    this.loadTenantsConfig();
  }

  loadServerConfig() {
    try {
      const configFile = path.join(this.configPath, 'server.json');
      const data = fs.readFileSync(configFile, 'utf8');
      this.serverConfig = JSON.parse(data);
      validator.validateServerConfig(this.serverConfig);
      console.log('✅ 服务器配置加载成功');
    } catch (error) {
      console.error('❌ 服务器配置加载失败:', error.message);
      process.exit(1);
    }
  }

  loadUpstreamsConfig() {
    try {
      const configFile = path.join(this.configPath, 'upstreams.json');
      const data = fs.readFileSync(configFile, 'utf8');
      this.upstreamsConfig = JSON.parse(data);
      
      // 为每个上游服务添加 healthCheck 默认值
      this.upstreamsConfig.upstreams.forEach(upstream => {
        if (!upstream.healthCheck) {
          upstream.healthCheck = {
            enabled: true,
            interval: 30000,
            timeout: 5000,
            path: '/health'
          };
        } else {
          // 为已存在的 healthCheck 填充缺失的默认值
          upstream.healthCheck.enabled = upstream.healthCheck.enabled !== undefined ? upstream.healthCheck.enabled : true;
          upstream.healthCheck.interval = upstream.healthCheck.interval || 30000;
          upstream.healthCheck.timeout = upstream.healthCheck.timeout || 5000;
          upstream.healthCheck.path = upstream.healthCheck.path || '/health';
        }
      });
      
      validator.validateUpstreamsConfig(this.upstreamsConfig);
      console.log(`✅ 上游配置加载成功，共 ${this.upstreamsConfig.upstreams.length} 个上游服务`);
    } catch (error) {
      console.error('❌ 上游配置加载失败:', error.message);
      process.exit(1);
    }
  }

  loadTenantsConfig() {
    try {
      const configFile = path.join(this.configPath, 'tenants.json');
      const data = fs.readFileSync(configFile, 'utf8');
      this.tenantsConfig = JSON.parse(data);
      validator.validateTenantsConfig(this.tenantsConfig);
      console.log(`✅ 租户配置加载成功，共 ${this.tenantsConfig.tenants.length} 个租户`);
    } catch (error) {
      console.error('❌ 租户配置加载失败:', error.message);
      process.exit(1);
    }
  }

  // 重新加载配置
  reloadConfig() {
    console.log('🔄 重新加载配置...');
    this.loadAllConfigs();
  }

  // 保存配置
  saveServerConfig() {
    try {
      const configFile = path.join(this.configPath, 'server.json');
      fs.writeFileSync(configFile, JSON.stringify(this.serverConfig, null, 2));
      console.log('✅ 服务器配置保存成功');
    } catch (error) {
      console.error('❌ 服务器配置保存失败:', error.message);
      throw error;
    }
  }

  saveUpstreamsConfig() {
    try {
      const configFile = path.join(this.configPath, 'upstreams.json');
      fs.writeFileSync(configFile, JSON.stringify(this.upstreamsConfig, null, 2));
      console.log('✅ 上游配置保存成功');
    } catch (error) {
      console.error('❌ 上游配置保存失败:', error.message);
      throw error;
    }
  }

  saveTenantsConfig() {
    try {
      const configFile = path.join(this.configPath, 'tenants.json');
      fs.writeFileSync(configFile, JSON.stringify(this.tenantsConfig, null, 2));
      console.log('✅ 租户配置保存成功');
    } catch (error) {
      console.error('❌ 租户配置保存失败:', error.message);
      throw error;
    }
  }

  // Getter 方法
  getServerConfig() {
    return this.serverConfig;
  }

  getUpstreamsConfig() {
    return this.upstreamsConfig;
  }

  getTenantsConfig() {
    return this.tenantsConfig;
  }

  // 租户管理方法
  getTenant(tenantId) {
    return this.tenantsConfig.tenants.find(tenant => tenant.id === tenantId);
  }

  getTenantByKey(key) {
    return this.tenantsConfig.tenants.find(tenant => tenant.key === key);
  }

  addTenant(tenant) {
    tenant.id = tenant.id || require('crypto').randomUUID();
    tenant.createdAt = new Date().toISOString();
    tenant.updatedAt = new Date().toISOString();
    
    validator.validateTenant(tenant);
    this.tenantsConfig.tenants.push(tenant);
    this.saveTenantsConfig();
    return tenant;
  }

  updateTenant(tenantId, updates) {
    const tenantIndex = this.tenantsConfig.tenants.findIndex(t => t.id === tenantId);
    if (tenantIndex === -1) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    const updatedTenant = { ...this.tenantsConfig.tenants[tenantIndex], ...updates };
    updatedTenant.updatedAt = new Date().toISOString();
    
    validator.validateTenant(updatedTenant);
    this.tenantsConfig.tenants[tenantIndex] = updatedTenant;
    this.saveTenantsConfig();
    return updatedTenant;
  }

  deleteTenant(tenantId) {
    const tenantIndex = this.tenantsConfig.tenants.findIndex(t => t.id === tenantId);
    if (tenantIndex === -1) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    const deletedTenant = this.tenantsConfig.tenants.splice(tenantIndex, 1)[0];
    this.saveTenantsConfig();
    return deletedTenant;
  }

  // 上游管理方法
  getUpstream(upstreamId) {
    return this.upstreamsConfig.upstreams.find(upstream => upstream.id === upstreamId);
  }

  getEnabledUpstreams() {
    return this.upstreamsConfig.upstreams.filter(upstream => upstream.enabled);
  }

  addUpstream(upstream) {
    upstream.id = upstream.id || require('crypto').randomUUID();
    
    // 添加 healthCheck 默认值
    if (!upstream.healthCheck) {
      upstream.healthCheck = {
        enabled: true,
        interval: 30000,
        timeout: 5000,
        path: '/health'
      };
    } else {
      // 为已存在的 healthCheck 填充缺失的默认值
      upstream.healthCheck.enabled = upstream.healthCheck.enabled !== undefined ? upstream.healthCheck.enabled : true;
      upstream.healthCheck.interval = upstream.healthCheck.interval || 30000;
      upstream.healthCheck.timeout = upstream.healthCheck.timeout || 5000;
      upstream.healthCheck.path = upstream.healthCheck.path || '/health';
    }
    
    validator.validateUpstream(upstream);
    this.upstreamsConfig.upstreams.push(upstream);
    this.saveUpstreamsConfig();
    return upstream;
  }

  updateUpstream(upstreamId, updates) {
    const upstreamIndex = this.upstreamsConfig.upstreams.findIndex(u => u.id === upstreamId);
    if (upstreamIndex === -1) {
      throw new Error(`上游服务 ${upstreamId} 不存在`);
    }

    const updatedUpstream = { ...this.upstreamsConfig.upstreams[upstreamIndex], ...updates };
    
    // 如果更新中包含 healthCheck，为其添加默认值
    if (updatedUpstream.healthCheck) {
      updatedUpstream.healthCheck.enabled = updatedUpstream.healthCheck.enabled !== undefined ? updatedUpstream.healthCheck.enabled : true;
      updatedUpstream.healthCheck.interval = updatedUpstream.healthCheck.interval || 30000;
      updatedUpstream.healthCheck.timeout = updatedUpstream.healthCheck.timeout || 5000;
      updatedUpstream.healthCheck.path = updatedUpstream.healthCheck.path || '/health';
    }
    
    validator.validateUpstream(updatedUpstream);
    this.upstreamsConfig.upstreams[upstreamIndex] = updatedUpstream;
    this.saveUpstreamsConfig();
    return updatedUpstream;
  }

  deleteUpstream(upstreamId) {
    const upstreamIndex = this.upstreamsConfig.upstreams.findIndex(u => u.id === upstreamId);
    if (upstreamIndex === -1) {
      throw new Error(`上游服务 ${upstreamId} 不存在`);
    }

    const deletedUpstream = this.upstreamsConfig.upstreams.splice(upstreamIndex, 1)[0];
    this.saveUpstreamsConfig();
    return deletedUpstream;
  }
}

module.exports = new ConfigManager();
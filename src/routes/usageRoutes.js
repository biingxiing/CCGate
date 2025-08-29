const url = require('url');
const TenantService = require('../services/tenantService');

class UsageRoutes {
  constructor(configManager, usageService, loadBalancer, logger) {
    this.configManager = configManager;
    this.usageService = usageService;
    this.loadBalancer = loadBalancer;
    this.logger = logger;
    this.tenantService = new TenantService(configManager);
    this.adminConfig = configManager.getServerConfig().admin;
  }

  // 处理用量查询请求
  async handleUsageRequest(req, res) {
    const requestId = require('../utils/helpers').generateRequestId();
    
    try {
      const urlParts = url.parse(req.url, true);
      const path = urlParts.pathname;
      const method = req.method;

      // 用量查询接口
      if (path === '/usage' && method === 'POST') {
        return this.handleUsageQuery(req, res, requestId);
      }

      // 404
      this.send404(res);
    } catch (error) {
      this.logger.error('用量查询错误', {
        requestId,
        error: error.message,
        stack: error.stack
      });
      this.sendError(res, '内部服务器错误', 500);
    }
  }

  // 处理用量查询
  async handleUsageQuery(req, res, requestId) {
    try {
      const body = await this.collectRequestBody(req);
      const queryData = JSON.parse(body);
      
      if (queryData.type === 'admin') {
        // 管理员查询
        if (!this.adminConfig.enabled) {
          return this.sendError(res, '管理后台未启用', 403);
        }
        
        if (queryData.username === this.adminConfig.username && 
            queryData.password === this.adminConfig.password) {
          
          const [limitResponse, systemResponse, upstreamResponse] = await Promise.all([
            this.getSystemLimits(),
            this.getSystemStats(),
            this.getUpstreams()
          ]);
          
          return this.sendJSON(res, {
            success: true,
            type: 'admin',
            data: {
              usage: limitResponse,
              system: systemResponse,
              upstreams: upstreamResponse
            }
          });
        } else {
          return this.sendError(res, '用户名或密码错误', 401);
        }
        
      } else if (queryData.type === 'tenant') {
        // 租户查询
        try {
          const tenant = this.tenantService.getTenantByKey(queryData.apiKey);
          const limitStatus = await this.usageService.getCurrentLimitStatus(tenant.id);
          
          return this.sendJSON(res, {
            success: true,
            type: 'tenant',
            data: {
              usage: limitStatus,
              tenant: {
                id: tenant.id,
                name: tenant.name
              }
            }
          });
          
        } catch (error) {
          return this.sendError(res, 'API Key 验证失败', 401);
        }
      } else {
        return this.sendError(res, '无效的查询类型', 400);
      }
      
    } catch (error) {
      this.logger.error('用量查询处理错误', {
        requestId,
        error: error.message,
        stack: error.stack
      });
      return this.sendError(res, '查询处理失败', 500);
    }
  }

  // 获取系统限制
  async getSystemLimits() {
    const today = new Date().toISOString().split('T')[0];
    const tenants = this.configManager.getTenantsConfig().tenants;
    const tenantsUsage = await Promise.all(
      tenants.map(async (tenant) => {
        try {
          const usage = await this.usageService.getDailyUsage(tenant.id, today);
          const limits = await this.usageService.getCurrentLimitStatus(tenant.id);
          return {
            tenantId: tenant.id,
            tenantName: tenant.name,
            usage,
            limits: limits.limits
          };
        } catch (error) {
          console.warn(`获取租户 ${tenant.id} 用量失败:`, error.message);
          return null;
        }
      })
    );
    
    const validUsages = tenantsUsage.filter(t => t !== null);
    const aggregatedUsage = {
      totalRequests: validUsages.reduce((sum, t) => sum + (t.usage.totalRequests || 0), 0),
      totalTokens: validUsages.reduce((sum, t) => sum + (t.usage.totalTokens || 0), 0),
      totalCost: validUsages.reduce((sum, t) => sum + (t.usage.totalCost || 0), 0),
      errorRate: validUsages.length > 0 ? Math.round(validUsages.reduce((sum, t) => sum + (t.usage.errorRate || 0), 0) / validUsages.length) : 0,
      byModel: {}
    };
    
    // 聚合按模型的统计
    validUsages.forEach(tenant => {
      if (tenant.usage.byModel) {
        Object.keys(tenant.usage.byModel).forEach(model => {
          if (!aggregatedUsage.byModel[model]) {
            aggregatedUsage.byModel[model] = {
              totalRequests: 0,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              totalCost: 0
            };
          }
          const modelUsage = tenant.usage.byModel[model];
          aggregatedUsage.byModel[model].totalRequests += modelUsage.totalRequests || 0;
          aggregatedUsage.byModel[model].totalTokens += modelUsage.totalTokens || 0;
          aggregatedUsage.byModel[model].inputTokens += modelUsage.inputTokens || 0;
          aggregatedUsage.byModel[model].outputTokens += modelUsage.outputTokens || 0;
          aggregatedUsage.byModel[model].cacheCreationTokens += modelUsage.cacheCreationTokens || 0;
          aggregatedUsage.byModel[model].cacheReadTokens += modelUsage.cacheReadTokens || 0;
          aggregatedUsage.byModel[model].totalCost += modelUsage.totalCost || 0;
        });
      }
    });
    
    return {
      todayUsage: aggregatedUsage,
      limits: null,
      tenants: validUsages
    };
  }

  // 获取系统统计
  async getSystemStats() {
    const today = new Date().toISOString().split('T')[0];
    const tenants = this.configManager.getTenantsConfig().tenants;
    
    let systemStats = {
      totalRequests: 0,
      totalCost: 0,
      activeTenants: 0,
      totalUpstreams: this.loadBalancer.getUpstreamStats().total,
      healthyUpstreams: this.loadBalancer.getUpstreamStats().healthy
    };
    
    try {
      const tenantsUsage = await Promise.all(
        tenants.map(async (tenant) => {
          try {
            const usage = await this.usageService.getDailyUsage(tenant.id, today);
            return {
              tenantId: tenant.id,
              requests: usage.totalRequests || 0,
              cost: usage.totalCost || 0
            };
          } catch (error) {
            return { tenantId: tenant.id, requests: 0, cost: 0 };
          }
        })
      );
      
      systemStats.totalRequests = tenantsUsage.reduce((sum, t) => sum + t.requests, 0);
      systemStats.totalCost = tenantsUsage.reduce((sum, t) => sum + t.cost, 0);
      systemStats.activeTenants = tenantsUsage.filter(t => t.requests > 0).length;
      
    } catch (error) {
      console.warn('获取系统统计失败:', error.message);
    }
    
    return systemStats;
  }

  // 获取上游信息
  getUpstreams() {
    return this.loadBalancer.getUpstreamStats();
  }

  // 辅助方法
  async collectRequestBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
    });
  }

  sendJSON(res, data, statusCode = 200) {
    res.writeHead(statusCode, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'http://localhost:3000',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Allow-Credentials': 'true'
    });
    res.end(JSON.stringify(data, null, 2));
  }

  sendError(res, message, statusCode = 400) {
    this.sendJSON(res, { error: message }, statusCode);
  }

  send404(res) {
    this.sendError(res, '路径未找到', 404);
  }
}

module.exports = UsageRoutes;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// 导入模型价格配置
const pricingConfig = require('../../config/pricing.json');
const MODEL_PRICING = pricingConfig.modelPricing;

class UsageService {
  constructor(configManager) {
    this.configManager = configManager;
    this.helpers = require('../utils/helpers');
    this.dataDir = path.join(__dirname, '../../data/usage');
    this.ensureDataDirectory();
  }

  // 根据模型和用量计算成本（美元）
  calculateCost(model, usage) {
    // 查找匹配的价格配置
    const pricing = this.helpers.findMatchingLimits(MODEL_PRICING, model);
    if (!pricing) {
      console.warn(`模型 ${model} 未找到价格配置，使用默认价格`);
      return {
        inputCost: 0,
        outputCost: 0,
        cacheCreationCost: 0,
        cacheReadCost: 0,
        totalCost: 0
      };
    }

    // 计算各类型token的成本（价格是每1K tokens）
    const inputCost = (usage.inputTokens || 0) / 1000 * pricing.input;
    const outputCost = (usage.outputTokens || 0) / 1000 * pricing.output;
    const cacheCreationCost = (usage.cacheCreationTokens || 0) / 1000 * pricing.cacheCreation;
    const cacheReadCost = (usage.cacheReadTokens || 0) / 1000 * pricing.cacheRead;
    const totalCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

    return {
      inputCost: Math.round(inputCost * 1000000) / 1000000,  // 精确到6位小数
      outputCost: Math.round(outputCost * 1000000) / 1000000,
      cacheCreationCost: Math.round(cacheCreationCost * 1000000) / 1000000,
      cacheReadCost: Math.round(cacheReadCost * 1000000) / 1000000,
      totalCost: Math.round(totalCost * 1000000) / 1000000
    };
  }

  async ensureDataDirectory() {
    try {
      await fs.access(this.dataDir);
    } catch (error) {
      await fs.mkdir(this.dataDir, { recursive: true });
    }
  }

  // 记录用量
  async recordUsage(tenantId, usage) {
    const requestId = usage.requestId || crypto.randomBytes(8).toString('hex');
    const now = new Date();
    const dateStr = this.formatDate(now);
    const monthStr = this.formatMonth(now);

    // 计算成本
    const cost = this.calculateCost(usage.model, usage);

    // 创建用量记录
    const usageRecord = {
      requestId,
      tenantId,
      timestamp: now.toISOString(),
      model: usage.model,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cacheCreationTokens: usage.cacheCreationTokens || 0,
      cacheReadTokens: usage.cacheReadTokens || 0,
      totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0) + 
                   (usage.cacheCreationTokens || 0) + (usage.cacheReadTokens || 0),
      // 成本信息
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      cacheCreationCost: cost.cacheCreationCost,
      cacheReadCost: cost.cacheReadCost,
      totalCost: cost.totalCost,
      duration: usage.duration || 0,
      statusCode: usage.statusCode || 200,
      errorType: usage.errorType || null,
      upstream: usage.upstream || null,
      userAgent: usage.userAgent || null,
      clientIP: usage.clientIP || null,
      metadata: usage.metadata || {}
    };

    try {
      // 确保租户目录存在
      const tenantDir = path.join(this.dataDir, tenantId);
      await this.ensureDirectory(tenantDir);

      // 确保月份目录存在
      const monthDir = path.join(tenantDir, monthStr);
      await this.ensureDirectory(monthDir);

      // 写入日用量文件
      const dailyFile = path.join(monthDir, `${dateStr}.json`);
      await this.appendToUsageFile(dailyFile, usageRecord);

      console.log(`📊 用量记录成功: 租户 ${tenantId}, 请求 ${requestId}, 模型 ${usage.model}`);
      return usageRecord;
    } catch (error) {
      console.error('用量记录失败:', error.message);
      throw error;
    }
  }

  // 获取租户日用量
  async getDailyUsage(tenantId, date) {
    const dateStr = typeof date === 'string' ? date : this.formatDate(new Date(date));
    const monthStr = dateStr.substring(0, 7); // YYYY-MM
    const dailyFile = path.join(this.dataDir, tenantId, monthStr, `${dateStr}.json`);

    try {
      const content = await fs.readFile(dailyFile, 'utf8');
      const records = content.trim().split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));

      return this.aggregateUsageRecords(records);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return this.getEmptyUsageAggregation();
      }
      throw error;
    }
  }

  // 获取租户周用量
  async getWeeklyUsage(tenantId, startDate) {
    const start = new Date(startDate);
    const weeklyUsage = [];
    
    for (let i = 0; i < 7; i++) {
      const currentDate = new Date(start);
      currentDate.setDate(start.getDate() + i);
      
      try {
        const dailyUsage = await this.getDailyUsage(tenantId, currentDate);
        dailyUsage.date = this.formatDate(currentDate);
        weeklyUsage.push(dailyUsage);
      } catch (error) {
        console.warn(`获取 ${tenantId} 在 ${this.formatDate(currentDate)} 的用量失败:`, error.message);
        weeklyUsage.push({
          date: this.formatDate(currentDate),
          ...this.getEmptyUsageAggregation()
        });
      }
    }

    return {
      weeklyUsage,
      summary: this.aggregateUsageArray(weeklyUsage)
    };
  }

  // 获取租户月用量
  async getMonthlyUsage(tenantId, year, month) {
    const monthStr = `${year}-${month.toString().padStart(2, '0')}`;
    const monthDir = path.join(this.dataDir, tenantId, monthStr);
    
    try {
      const files = await fs.readdir(monthDir);
      const dailyUsages = [];
      
      for (const file of files.filter(f => f.endsWith('.json'))) {
        const dateStr = file.replace('.json', '');
        try {
          const dailyUsage = await this.getDailyUsage(tenantId, dateStr);
          dailyUsage.date = dateStr;
          dailyUsages.push(dailyUsage);
        } catch (error) {
          console.warn(`读取日用量文件失败 ${file}:`, error.message);
        }
      }

      // 按日期排序
      dailyUsages.sort((a, b) => a.date.localeCompare(b.date));

      return {
        monthlyUsage: dailyUsages,
        summary: this.aggregateUsageArray(dailyUsages)
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          monthlyUsage: [],
          summary: this.getEmptyUsageAggregation()
        };
      }
      throw error;
    }
  }

  // 获取租户当前限额使用情况
  async getCurrentLimitStatus(tenantId) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`租户 ${tenantId} 不存在`);
    }

    const today = new Date();
    const todayUsage = await this.getDailyUsage(tenantId, today);
    
    const limitStatus = {};

    if (tenant.limits && tenant.limits.daily && tenant.limits.daily.maxUSD) {
      // 只支持美元限制模式
      limitStatus.usd = {
        used: todayUsage.totalCost || 0,
        limit: tenant.limits.daily.maxUSD,
        percentage: Math.round((todayUsage.totalCost || 0) / tenant.limits.daily.maxUSD * 100),
        exceeded: (todayUsage.totalCost || 0) >= tenant.limits.daily.maxUSD
      };
    }

    return {
      tenantId,
      date: this.formatDate(today),
      limits: limitStatus,
      todayUsage
    };
  }

  // 检查是否超出限额（预测性检查，用于请求前判断）
  async checkLimitsExceeded(tenantId, model, tokensToAdd = {}) {
    const tenant = this.configManager.getTenant(tenantId);
    if (!tenant || !tenant.limits || !tenant.limits.daily || !tenant.limits.daily.maxUSD) {
      return { exceeded: false, message: `租户 ${tenantId} 无限制配置` };
    }

    // 获取当前用量
    const today = new Date();
    const todayUsage = await this.getDailyUsage(tenantId, today);

    // 只检查美元限制
    const currentCost = todayUsage.totalCost || 0;
    const additionalCost = this.calculateCost(model, tokensToAdd);
    const newTotalCost = currentCost + additionalCost.totalCost;

    if (newTotalCost > tenant.limits.daily.maxUSD) {
      return {
        exceeded: true,
        costExceeded: {
          currentCost,
          additionalCost: additionalCost.totalCost,
          newTotalCost,
          limit: tenant.limits.daily.maxUSD,
          excess: newTotalCost - tenant.limits.daily.maxUSD
        },
        message: `请求成本 $${additionalCost.totalCost.toFixed(6)}，总计 $${newTotalCost.toFixed(6)} 将超出日限额 $${tenant.limits.daily.maxUSD}`
      };
    }

    return {
      exceeded: false,
      message: `当前成本 $${currentCost.toFixed(6)}，增加 $${additionalCost.totalCost.toFixed(6)}，总计 $${newTotalCost.toFixed(6)}，未超出限额`
    };
  }

  // 获取系统整体用量统计
  async getSystemUsage(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const systemUsage = {
      totalRequests: 0,
      totalTokens: 0,
      byTenant: {},
      byModel: {},
      byDate: {},
      errorRate: 0,
      avgDuration: 0
    };

    try {
      const tenantDirs = await fs.readdir(this.dataDir);
      
      for (const tenantId of tenantDirs) {
        const tenantPath = path.join(this.dataDir, tenantId);
        const stat = await fs.stat(tenantPath);
        
        if (!stat.isDirectory()) continue;

        const tenantUsage = await this.getTenantUsageInRange(tenantId, start, end);
        systemUsage.byTenant[tenantId] = tenantUsage;
        
        // 聚合到系统统计
        systemUsage.totalRequests += tenantUsage.totalRequests;
        systemUsage.totalTokens += tenantUsage.totalTokens;

        // 按模型聚合
        Object.keys(tenantUsage.byModel).forEach(model => {
          if (!systemUsage.byModel[model]) {
            systemUsage.byModel[model] = this.getEmptyUsageAggregation();
          }
          this.mergeUsageAggregation(systemUsage.byModel[model], tenantUsage.byModel[model]);
        });
      }

      // 计算错误率和平均时长
      if (systemUsage.totalRequests > 0) {
        const errorCount = Object.values(systemUsage.byTenant)
          .reduce((sum, tenant) => sum + (tenant.errorCount || 0), 0);
        systemUsage.errorRate = Math.round((errorCount / systemUsage.totalRequests) * 100);

        const totalDuration = Object.values(systemUsage.byTenant)
          .reduce((sum, tenant) => sum + (tenant.totalDuration || 0), 0);
        systemUsage.avgDuration = Math.round(totalDuration / systemUsage.totalRequests);
      }

      return systemUsage;
    } catch (error) {
      console.error('获取系统用量统计失败:', error.message);
      throw error;
    }
  }

  // 获取租户在指定时间范围内的用量
  async getTenantUsageInRange(tenantId, startDate, endDate) {
    // 实现逻辑略，需要遍历日期范围内的所有文件
    // 这里提供基本框架
    return this.getEmptyUsageAggregation();
  }

  // 辅助方法：确保目录存在
  async ensureDirectory(dir) {
    try {
      await fs.access(dir);
    } catch (error) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // 辅助方法：追加到用量文件
  async appendToUsageFile(filePath, record) {
    const line = JSON.stringify(record) + '\n';
    await fs.appendFile(filePath, line);
  }

  // 辅助方法：聚合用量记录
  aggregateUsageRecords(records) {
    const aggregation = this.getEmptyUsageAggregation();
    
    records.forEach(record => {
      aggregation.totalRequests++;
      aggregation.totalTokens += record.totalTokens;
      aggregation.inputTokens += record.inputTokens;
      aggregation.outputTokens += record.outputTokens;
      aggregation.cacheCreationTokens += record.cacheCreationTokens;
      aggregation.cacheReadTokens += record.cacheReadTokens;
      aggregation.totalDuration += record.duration;
      
      // 聚合成本信息
      aggregation.totalCost += record.totalCost || 0;
      aggregation.inputCost += record.inputCost || 0;
      aggregation.outputCost += record.outputCost || 0;
      aggregation.cacheCreationCost += record.cacheCreationCost || 0;
      aggregation.cacheReadCost += record.cacheReadCost || 0;

      if (record.statusCode >= 400) {
        aggregation.errorCount++;
      }

      // 按模型聚合
      if (!aggregation.byModel[record.model]) {
        aggregation.byModel[record.model] = this.getEmptyUsageAggregation();
      }
      this.mergeUsageAggregation(aggregation.byModel[record.model], {
        totalRequests: 1,
        totalTokens: record.totalTokens,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        cacheReadTokens: record.cacheReadTokens,
        totalCost: record.totalCost || 0,
        inputCost: record.inputCost || 0,
        outputCost: record.outputCost || 0,
        cacheCreationCost: record.cacheCreationCost || 0,
        cacheReadCost: record.cacheReadCost || 0,
        totalDuration: record.duration,
        errorCount: record.statusCode >= 400 ? 1 : 0
      });

      // 按小时聚合
      const hour = new Date(record.timestamp).getHours();
      if (!aggregation.byHour[hour]) {
        aggregation.byHour[hour] = this.getEmptyUsageAggregation();
      }
      this.mergeUsageAggregation(aggregation.byHour[hour], {
        totalRequests: 1,
        totalTokens: record.totalTokens,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        cacheReadTokens: record.cacheReadTokens,
        totalCost: record.totalCost || 0,
        inputCost: record.inputCost || 0,
        outputCost: record.outputCost || 0,
        cacheCreationCost: record.cacheCreationCost || 0,
        cacheReadCost: record.cacheReadCost || 0,
        totalDuration: record.duration,
        errorCount: record.statusCode >= 400 ? 1 : 0
      });
    });

    // 计算平均值
    if (aggregation.totalRequests > 0) {
      aggregation.avgDuration = Math.round(aggregation.totalDuration / aggregation.totalRequests);
      aggregation.errorRate = Math.round((aggregation.errorCount / aggregation.totalRequests) * 100);
      aggregation.avgCost = Math.round(aggregation.totalCost / aggregation.totalRequests * 1000000) / 1000000;
    }

    return aggregation;
  }

  // 辅助方法：获取空的用量聚合对象
  getEmptyUsageAggregation() {
    return {
      totalRequests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheCreationCost: 0,
      cacheReadCost: 0,
      avgCost: 0,
      totalDuration: 0,
      avgDuration: 0,
      errorCount: 0,
      errorRate: 0,
      byModel: {},
      byHour: {}
    };
  }

  // 辅助方法：合并用量聚合
  mergeUsageAggregation(target, source) {
    target.totalRequests += source.totalRequests;
    target.totalTokens += source.totalTokens;
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheCreationTokens += source.cacheCreationTokens;
    target.cacheReadTokens += source.cacheReadTokens;
    target.totalCost += source.totalCost || 0;
    target.inputCost += source.inputCost || 0;
    target.outputCost += source.outputCost || 0;
    target.cacheCreationCost += source.cacheCreationCost || 0;
    target.cacheReadCost += source.cacheReadCost || 0;
    target.totalDuration += source.totalDuration;
    target.errorCount += source.errorCount;
  }

  // 辅助方法：聚合用量数组
  aggregateUsageArray(usageArray) {
    const aggregation = this.getEmptyUsageAggregation();
    usageArray.forEach(usage => {
      this.mergeUsageAggregation(aggregation, usage);
    });

    if (aggregation.totalRequests > 0) {
      aggregation.avgDuration = Math.round(aggregation.totalDuration / aggregation.totalRequests);
      aggregation.errorRate = Math.round((aggregation.errorCount / aggregation.totalRequests) * 100);
      aggregation.avgCost = Math.round(aggregation.totalCost / aggregation.totalRequests * 1000000) / 1000000;
    }

    return aggregation;
  }

  // 辅助方法：格式化日期
  formatDate(date) {
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  // 辅助方法：格式化月份
  formatMonth(date) {
    return date.toISOString().substr(0, 7); // YYYY-MM
  }
}

module.exports = UsageService;
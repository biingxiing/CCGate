const https = require('https');
const http = require('http');
const url = require('url');

class LoadBalancer {
  constructor(configManager) {
    this.configManager = configManager;
    this.upstreams = [];
    this.currentIndex = 0;
    this.healthStatus = new Map();
    this.healthCheckInterval = null;
    this.initialize();
  }

  initialize() {
    this.updateUpstreams();
    this.startHealthCheck();
  }

  updateUpstreams() {
    const config = this.configManager.getUpstreamsConfig();
    this.upstreams = config.upstreams.filter(upstream => upstream.enabled);
    console.log(`🔄 更新上游列表，共 ${this.upstreams.length} 个可用上游`);
  }

  startHealthCheck() {
    const config = this.configManager.getUpstreamsConfig();
    if (!config.loadBalancer.healthCheckEnabled) {
      console.log('⚠️  健康检查已禁用');
      return;
    }

    const interval = 300000; // 30秒检查一次
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, interval);

    // 立即执行一次健康检查
    this.performHealthCheck();
    console.log(`🏥 健康检查已启动，间隔 ${interval/1000} 秒`);
  }

  async performHealthCheck() {
    const promises = this.upstreams.map(upstream => this.checkUpstreamHealth(upstream));
    await Promise.allSettled(promises);
  }

  async checkUpstreamHealth(upstream) {
    return new Promise((resolve) => {
      try {
        const targetUrl = new URL(upstream.url);
        const healthPath = upstream.healthCheck?.path || '/health';
        const timeout = upstream.healthCheck?.timeout || 5000;
        
        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: healthPath,
          method: 'GET',
          timeout: timeout,
          headers: {
            'User-Agent': 'CCGate-HealthCheck/1.0'
          }
        };

        const client = targetUrl.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
          const isHealthy = res.statusCode >= 200 && res.statusCode < 400;
          this.updateHealthStatus(upstream.id, isHealthy);
          resolve(isHealthy);
        });

        req.on('error', (error) => {
          console.warn(`❌ 上游 ${upstream.name} (${upstream.id}) 健康检查失败:`, error.message);
          this.updateHealthStatus(upstream.id, false);
          resolve(false);
        });

        req.on('timeout', () => {
          console.warn(`⏰ 上游 ${upstream.name} (${upstream.id}) 健康检查超时`);
          this.updateHealthStatus(upstream.id, false);
          req.destroy();
          resolve(false);
        });

        req.end();
      } catch (error) {
        console.warn(`❌ 上游 ${upstream.name} (${upstream.id}) 健康检查异常:`, error.message);
        this.updateHealthStatus(upstream.id, false);
        resolve(false);
      }
    });
  }

  updateHealthStatus(upstreamId, isHealthy) {
    const wasHealthy = this.healthStatus.get(upstreamId);
    this.healthStatus.set(upstreamId, isHealthy);
    
    if (wasHealthy !== isHealthy) {
      const upstream = this.upstreams.find(u => u.id === upstreamId);
      const status = isHealthy ? '健康' : '不健康';
      const emoji = isHealthy ? '✅' : '❌';
      console.log(`${emoji} 上游 ${upstream?.name} (${upstreamId}) 状态变更: ${status}`);
    }
  }

  getHealthyUpstreams() {
    return this.upstreams.filter(upstream => {
      const isHealthy = this.healthStatus.get(upstream.id);
      return isHealthy !== false; // undefined 也被视为健康
    });
  }

  selectUpstream(requestId) {
    const config = this.configManager.getUpstreamsConfig();
    const strategy = config.loadBalancer.strategy || 'weighted_round_robin';
    
    let candidates = this.upstreams;
    
    // 如果启用了健康检查，只选择健康的上游
    if (config.loadBalancer.healthCheckEnabled) {
      candidates = this.getHealthyUpstreams();
      if (candidates.length === 0) {
        if (config.loadBalancer.failoverEnabled) {
          console.warn('⚠️  没有健康的上游，使用故障转移模式');
          candidates = this.upstreams; // 使用所有上游作为故障转移
        } else {
          throw new Error('没有可用的健康上游服务');
        }
      }
    }

    switch (strategy) {
      case 'round_robin':
        return this.roundRobinSelection(candidates, requestId);
      case 'weighted_round_robin':
        return this.weightedRoundRobinSelection(candidates, requestId);
      case 'random':
        return this.randomSelection(candidates, requestId);
      case 'weighted_random':
        return this.weightedRandomSelection(candidates, requestId);
      default:
        console.warn(`⚠️  未知的负载均衡策略: ${strategy}，使用默认策略`);
        return this.weightedRoundRobinSelection(candidates, requestId);
    }
  }

  roundRobinSelection(upstreams, requestId) {
    if (upstreams.length === 0) {
      throw new Error('没有可用的上游服务');
    }
    
    const selected = upstreams[this.currentIndex % upstreams.length];
    this.currentIndex = (this.currentIndex + 1) % upstreams.length;
    
    console.log(`🎯 请求 ${requestId} 选择上游: ${selected.name} (轮询)`);
    return selected;
  }

  weightedRoundRobinSelection(upstreams, requestId) {
    if (upstreams.length === 0) {
      throw new Error('没有可用的上游服务');
    }

    // 计算总权重
    const totalWeight = upstreams.reduce((sum, upstream) => sum + (upstream.weight || 100), 0);
    
    if (totalWeight === 0) {
      return this.roundRobinSelection(upstreams, requestId);
    }

    // 初始化权重计数器
    if (!this.weightCounters) {
      this.weightCounters = new Map();
      upstreams.forEach(upstream => {
        this.weightCounters.set(upstream.id, 0);
      });
    }

    // 找到当前权重最高的上游
    let selected = null;
    let maxCurrentWeight = -1;

    upstreams.forEach(upstream => {
      const currentWeight = this.weightCounters.get(upstream.id) + (upstream.weight || 100);
      this.weightCounters.set(upstream.id, currentWeight);
      
      if (currentWeight > maxCurrentWeight) {
        maxCurrentWeight = currentWeight;
        selected = upstream;
      }
    });

    // 减少选中上游的权重
    if (selected) {
      const currentWeight = this.weightCounters.get(selected.id);
      this.weightCounters.set(selected.id, currentWeight - totalWeight);
      console.log(`🎯 请求 ${requestId} 选择上游: ${selected.name} (加权轮询, 权重: ${selected.weight || 100})`);
    }

    return selected || upstreams[0];
  }

  randomSelection(upstreams, requestId) {
    if (upstreams.length === 0) {
      throw new Error('没有可用的上游服务');
    }
    
    const index = Math.floor(Math.random() * upstreams.length);
    const selected = upstreams[index];
    
    console.log(`🎯 请求 ${requestId} 选择上游: ${selected.name} (随机)`);
    return selected;
  }

  weightedRandomSelection(upstreams, requestId) {
    if (upstreams.length === 0) {
      throw new Error('没有可用的上游服务');
    }

    const totalWeight = upstreams.reduce((sum, upstream) => sum + (upstream.weight || 100), 0);
    
    if (totalWeight === 0) {
      return this.randomSelection(upstreams, requestId);
    }

    let randomNum = Math.random() * totalWeight;
    
    for (const upstream of upstreams) {
      randomNum -= (upstream.weight || 100);
      if (randomNum <= 0) {
        console.log(`🎯 请求 ${requestId} 选择上游: ${upstream.name} (加权随机, 权重: ${upstream.weight || 100})`);
        return upstream;
      }
    }
    
    return upstreams[upstreams.length - 1];
  }

  getUpstreamStats() {
    return {
      total: this.upstreams.length,
      healthy: this.getHealthyUpstreams().length,
      unhealthy: this.upstreams.length - this.getHealthyUpstreams().length,
      healthStatus: Object.fromEntries(this.healthStatus),
      upstreams: this.upstreams.map(upstream => ({
        id: upstream.id,
        name: upstream.name,
        url: upstream.url,
        weight: upstream.weight || 100,
        enabled: upstream.enabled,
        healthy: this.healthStatus.get(upstream.id) !== false
      }))
    };
  }

  // 重新加载配置
  reload() {
    console.log('🔄 重新加载负载均衡器配置');
    this.updateUpstreams();
    
    // 重置权重计数器
    this.weightCounters = null;
    this.currentIndex = 0;
    
    // 重新启动健康检查
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.startHealthCheck();
  }

  destroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      console.log('🛑 负载均衡器已销毁');
    }
  }
}

module.exports = LoadBalancer;
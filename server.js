#!/usr/bin/env node

/**
 * CCGate 反向代理服务器
 * 大模型服务API代理，支持多租户、负载均衡、用量统计
 */

const CCGateApp = require('./src/app');

// 导入模型价格配置
const pricingConfig = require('./config/pricing.json');
const MODEL_PRICING = pricingConfig.modelPricing;

// 导出配置供其他模块使用
module.exports.MODEL_PRICING = MODEL_PRICING;

// 环境检查
function checkEnvironment() {
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (majorVersion < 14) {
    console.error('❌ CCGate 需要 Node.js 14.0.0 或更高版本');
    console.error(`   当前版本: ${nodeVersion}`);
    process.exit(1);
  }
}

// 主函数
function main() {
  checkEnvironment();
  
  console.log('🚀 正在启动 CCGate...');
  
  try {
    const app = new CCGateApp();
    app.start();
  } catch (error) {
    console.error('💥 启动失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// CLI 参数处理
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
CCGate - Claude Code API 反向代理服务器

用法:
  node server.js [选项]

选项:
  -h, --help     显示帮助信息
  --version      显示版本信息
  --config       指定配置文件目录 (默认: ./config)

环境变量:
  PORT           服务器端口 (默认: 3000)
  NODE_ENV       运行环境 (development|production)

示例:
  node server.js
  PORT=8080 node server.js
  NODE_ENV=production node server.js

更多信息请查看 README.md
    `);
    process.exit(0);
  }
  
  if (args.includes('--version')) {
    const packageJson = require('./package.json');
    console.log(`CCGate v${packageJson.version}`);
    process.exit(0);
  }
  
  main();
}
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CCGate 是一个高性能的大模型服务反向代理服务器，专为 Claude Code API 设计。项目已从简单的代理服务演进为企业级的多租户管理系统，支持负载均衡、用量统计、限额控制等功能。

## 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式（使用 nodemon 自动重启）
pnpm run dev

# 生产环境启动
pnpm start

# 直接启动
node server.js

# 配置验证
pnpm run config:validate

# 健康检查
pnpm run health

# 清理数据
pnpm run clean
```

## 项目架构

### 核心文件结构
- `server.js` - 启动文件，环境检查和CLI参数处理
- `src/app.js` - 主应用类，组件初始化和服务器管理
- `src/config/` - 配置管理模块
- `src/core/` - 核心功能模块（代理、认证、负载均衡）
- `src/services/` - 业务服务层（租户管理、用量统计）
- `src/routes/` - 路由处理模块
- `src/utils/` - 工具函数和日志系统
- `config/` - JSON配置文件目录
- `data/` - 数据存储目录（日志、用量数据）

### 核心功能模块

#### 配置管理 (src/config/)
- **index.js**: 统一的配置加载器，支持多配置文件热加载
- **validator.js**: 配置验证器，确保配置完整性

#### 核心功能 (src/core/)
- **proxy.js**: 代理核心，处理HTTP请求转发和流式响应
- **auth.js**: 认证中间件，基于API密钥的租户认证
- **loadBalancer.js**: 负载均衡器，支持多种均衡策略和健康检查

#### 业务服务 (src/services/)
- **tenantService.js**: 租户管理服务，CRUD操作和权限控制
- **usageService.js**: 用量统计服务，Token计量和限额管理

#### 路由处理 (src/routes/)
- **usageRoutes.js**: 用量查询API，支持租户和管理员查询

### 配置系统
项目使用 JSON 配置文件，位于 `config/` 目录：
- `server.json` - 服务器基础配置（端口、日志、管理后台）
- `upstreams.json` - 上游服务器配置和负载均衡策略
- `tenants.json` - 租户配置、API密钥、模型权限、用量限额
- `pricing.json` - 模型价格配置

### 数据存储结构
```
data/
├── logs/                  # 日志文件
│   ├── combined.log      # 综合日志
│   ├── error.log         # 错误日志
│   └── access.log        # 访问日志
└── usage/                # 用量数据
    └── {tenant-id}/      # 按租户分组
        └── {YYYY-MM}/    # 按月分组
            └── {YYYY-MM-DD}.json  # 每日用量数据
```

## 开发注意事项

### 架构特点
- **模块化设计**: 采用分层架构，职责清晰分离
- **配置驱动**: 所有配置通过JSON文件管理，支持热重载
- **流式处理**: 支持大文件和流式响应的高效转发
- **企业级功能**: 多租户、负载均衡、用量统计、限额控制

### 关键实现点
- **认证**: 基于API密钥的租户认证，支持模型访问权限控制 (src/core/auth.js)
- **代理核心**: 使用原生HTTP模块实现高性能代理转发 (src/core/proxy.js)
- **负载均衡**: 支持多种策略的负载均衡和健康检查 (src/core/loadBalancer.js)
- **用量统计**: Token级别的精确计量和实时限额检查 (src/services/usageService.js)
- **租户管理**: 完整的CRUD操作和配置管理 (src/services/tenantService.js)

### 配置管理
- 配置文件位于 `config/` 目录，使用JSON格式
- 配置加载器支持热重载 (src/config/index.js)
- 配置验证确保完整性 (src/config/validator.js)
- 修改配置后无需重启服务器，如需要让用户手动重启

### 开发调试
- 使用结构化日志系统，支持不同级别 (src/utils/logger.js)
- 管理后台提供丰富的监控和调试信息 (`/dashboard`)
- 健康检查端点 (`/health`) 可扩展系统状态信息

### 核心路由和端点
- `POST /anthropic` - Claude Code API 代理主要端点
- `GET /health` - 系统健康检查
- `GET /dashboard` - 用量查询面板
- `POST /usage` - 用量查询API
- `GET /` - 重定向到用量查询页面

### 关键依赖和技术栈
- **运行时**: Node.js >= 14.0.0
- **核心依赖**: 使用原生 Node.js HTTP/HTTPS 模块
- **配置**: 完全基于JSON配置文件，无需环境变量
- **开发工具**: nodemon 用于开发时自动重启
- **包管理**: 推荐使用 pnpm
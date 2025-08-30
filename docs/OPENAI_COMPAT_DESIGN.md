# CCGate OpenAI 兼容层设计方案

## 概述

为CCGate添加OpenAI兼容接口，使得Cursor等工具能够通过标准的OpenAI API格式调用Claude服务。

## 设计原则

- **简洁优先**：避免过度设计，使用最简方案
- **无侵入性**：现有功能完全保留
- **配置驱动**：通过配置文件管理模型映射
- **复用现有能力**：充分利用现有的认证、限额、负载均衡、用量统计功能

## 技术方案

### 1. 路由设计

#### 当前架构
```
客户端 → /anthropic/v1/messages → CCGate(移除/anthropic前缀) → 上游/v1/messages
```

#### 新增OpenAI兼容路由
```
客户端 → /openai/v1/chat/completions → 兼容层转换 → 内部/anthropic/v1/messages → 现有代理流程
```

### 2. 客户端配置

**Cursor等工具配置：**
- Base URL: `http://localhost:3000/openai`
- 完整端点: `/openai/v1/chat/completions`
- API Key: 使用现有CCGate租户密钥

### 3. 配置文件扩展

在 `config/server.json` 中添加OpenAI兼容配置：

```json
{
  "server": { ... },
  "logging": { ... },
  "proxy": { ... },
  "admin": { ... },
  "openai": {
    "enabled": true,
    "models": {
      "gpt-4": "claude-3-5-sonnet-20241022",
      "gpt-3.5-turbo": "claude-3-haiku-20240307",
      "gpt-4-turbo": "claude-3-5-sonnet-20241022"
    }
  }
}
```

### 4. 实现架构

```
OpenAI请求 → 格式转换中间件 → 修改请求路径和body → 现有代理核心处理流程
```

#### 核心转换逻辑

**请求转换（OpenAI → Claude）：**
```javascript
function convertOpenAIToClaude(openaiRequest, modelMapping) {
  return {
    model: modelMapping[openaiRequest.model] || openaiRequest.model,
    messages: openaiRequest.messages, // 格式基本兼容
    max_tokens: openaiRequest.max_tokens || 4096,
    temperature: openaiRequest.temperature,
    stream: openaiRequest.stream
  };
}
```

**响应转换（Claude → OpenAI）：**
- 非流式：转换JSON格式为OpenAI ChatCompletion格式
- 流式：转换SSE事件格式为OpenAI流式格式

### 5. 代码实现

#### 路由处理（src/app.js）
```javascript
} else if (req.url.startsWith('/openai/v1/chat/completions')) {
  // OpenAI兼容处理
  await this.handleOpenAICompatRequest(req, res);
} else if (req.url.startsWith('/anthropic')) {
  // 现有Claude路由
  await this.proxyCore.handleRequest(req, res);
}
```

#### 兼容层处理函数
```javascript
async handleOpenAICompatRequest(req, res) {
  // 1. 收集OpenAI格式请求体
  const openaiBody = await this.collectRequestBody(req);
  
  // 2. 转换为Claude格式
  const claudeBody = this.convertOpenAIToClaude(openaiBody);
  
  // 3. 修改请求路径和body
  req.url = '/anthropic/v1/messages';
  req.body = claudeBody;
  
  // 4. 走现有代理逻辑（包含认证、限额、负载均衡）
  await this.proxyCore.handleRequest(req, res);
}
```

## 技术细节

### 格式转换要点

#### 1. 请求格式对比

**OpenAI格式：**
```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "max_tokens": 4096,
  "temperature": 0.7,
  "stream": true
}
```

**Claude格式：**
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "max_tokens": 4096,
  "temperature": 0.7,
  "stream": true
}
```

#### 2. 响应格式转换

**非流式响应：**
- Claude: `{id, type: "message", content: [...], usage: {...}}`
- OpenAI: `{id, object: "chat.completion", choices: [...], usage: {...}}`

**流式响应：**
- Claude: `event: message_start\ndata: {...}\n\n`
- OpenAI: `data: {"id": ..., "object": "chat.completion.chunk", ...}\n\n`

### 现有功能复用

1. **认证系统**：OpenAI请求同样使用CCGate的API Key认证
2. **负载均衡**：转换后的请求走相同的上游选择逻辑
3. **用量统计**：Token计量和限额检查完全复用
4. **日志系统**：请求日志正常记录，便于调试

## 优势

1. **完全兼容**：Cursor等工具无需任何修改即可使用
2. **功能完整**：所有CCGate企业级功能（多租户、限额、统计）全部可用
3. **维护简单**：核心逻辑复用，只需维护格式转换层
4. **性能优异**：转换开销极小，不影响代理性能

## 实施计划

1. **第一阶段**：基础格式转换和路由实现
2. **第二阶段**：流式响应转换优化
3. **第三阶段**：错误处理和边界案例完善
4. **第四阶段**：文档和测试完善

## 配置示例

完整的server.json配置示例：
```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "openai": {
    "enabled": true,
    "models": {
      "gpt-5-nano": "claude-3-5-haiku-20241022",
      "gpt-5-mini": "claude-3-7-sonnet-20250219",
      "gpt-5-low": "claude-sonnet-4-20250514",
      "gpt-5-high": "claude-opus-4-20250514",
      "gpt-5-high-fast": "claude-opus-4-1-20250805 "
    }
  }
}
```

## 使用示例

**Cursor配置：**
```
Base URL: http://localhost:3000/openai
API Key: 你的CCGate租户API Key
Model: gpt-4
```

请求会自动转换为对Claude的调用，并享受CCGate的所有企业级功能。
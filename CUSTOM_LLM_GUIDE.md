# 自定义LLM服务接入指南

本文档详细介绍如何将Gemini CLI的默认Google Gemini接口替换为自定义LLM服务。

## 🚀 快速开始

### 1. 设置自定义LLM为默认配置

现在支持将自定义LLM作为默认启动配置，有三种简单方法：

#### 方法A：一键配置向导（推荐）

```bash
# 运行配置向导
./setup-custom-llm.js

# 或者手动配置
./start-custom-llm.sh
```

#### 方法B：环境变量配置

```bash
# 设置环境变量后启动
export CUSTOM_LLM_BASE_URL=http://your-api-endpoint.com/api
export CUSTOM_LLM_API_KEY=your-api-key
export CUSTOM_LLM_MODEL=your-model-name
export AUTH_TYPE=custom-llm

# 启动CLI
pnpm start
```

#### 方法C：配置文件方式

```bash
# 1. 复制示例配置文件
cp .env.custom-llm-example .env.local

# 2. 编辑配置文件
nano .env.local

# 3. 启动CLI
pnpm start
```

#### 方法B：运行时指定

```bash
# OpenAI示例
export OPENAI_API_KEY="sk-your-key"
export AUTH_TYPE="openai"
export DEFAULT_MODEL="gpt-3.5-turbo"

# 启动CLI
pnpm start
```

### 3. 具体配置示例

#### OpenAI配置

```bash
# 在.env.local中设置
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-openai-key
OPENAI_MODEL=gpt-3.5-turbo
AUTH_TYPE=openai
```

#### Anthropic配置

```bash
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
ANTHROPIC_MODEL=claude-3-sonnet-20240229
AUTH_TYPE=anthropic
```

#### Ollama本地配置

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama2
AUTH_TYPE=ollama
```

#### 自定义API配置

```bash
CUSTOM_LLM_BASE_URL=http://localhost:8080/v1
CUSTOM_LLM_API_KEY=your-key
CUSTOM_LLM_MODEL=custom-model
AUTH_TYPE=custom-llm

# 可选：API格式选择
CUSTOM_LLM_USE_OPENAI_FORMAT=true  # 使用OpenAI格式的messages数组
# 如果不设置或设置为false，将使用传统的prompt格式
```

### 4. 命令行参数支持

```bash
# 使用OpenAI
pnpm start --auth-type=openai --model=gpt-4

# 使用Anthropic
pnpm start --auth-type=anthropic --model=claude-3-opus-20240229

# 使用Ollama
pnpm start --auth-type=ollama --model=llama2:7b
```

### 5. API格式说明

Custom LLM适配器支持两种不同的API格式：

#### 5.1 传统prompt格式（默认）

```json
{
  "prompt": "[System Instructions]\n你是一个有用的助手\n\n[Conversation]\n[role]-user,[content]-Hello;",
  "model": "custom-model",
  "stream": true,
  "temperature": 1,
  "max_tokens": 10000
}
```

这种格式将系统提示词和对话历史合并为一个单一的prompt字符串。

#### 5.2 OpenAI messages格式

通过设置`CUSTOM_LLM_USE_OPENAI_FORMAT=true`启用：

```json
{
  "model": "custom-model",
  "messages": [
    {
      "role": "system",
      "content": "你是一个有用的助手"
    },
    {
      "role": "user",
      "content": "Hello"
    }
  ],
  "stream": true,
  "temperature": 1,
  "max_tokens": 10000
}
```

这种格式将对话分解为结构化的消息数组，更符合OpenAI API标准。

#### 5.3 格式选择建议

- **使用传统格式**：如果你的API期望接收单一的prompt字符串
- **使用OpenAI格式**：如果你的API与OpenAI兼容，或者你需要更好的对话上下文处理

### 6. 高级配置

#### 6.1 自定义请求头

```bash
# 通过环境变量添加自定义请求头
CUSTOM_LLM_HEADERS='{"X-Custom-Header": "value"}'
```

#### 6.2 超时设置

```bash
CUSTOM_LLM_TIMEOUT=30000  # 30秒超时
```

#### 6.3 代理配置

```bash
# 通过代理访问
PROXY=http://localhost:8080
```

### 7. 测试连接

创建测试脚本 `test-custom-llm.js`：

```javascript
import {
  CustomLLMAdapter,
  CustomLLMProvider,
} from './packages/core/src/llm/custom-llm-adapter.js';

const adapter = new CustomLLMAdapter(
  {
    baseUrl: 'http://localhost:11434',
    model: 'llama2',
  },
  CustomLLMProvider.CUSTOM,
  process.cwd(),
);

const result = await adapter.generateContent({
  contents: [{ role: 'user', parts: [{ text: 'Hello, world!' }] }],
});

console.log('Response:', result);
```

运行测试：

```bash
node test-custom-llm.js
```

### 7. 常见问题解决

#### 7.1 连接失败

```bash
# 检查网络连接
curl -X POST http://localhost:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model": "llama2", "prompt": "Hello"}'
```

#### 7.2 认证错误

```bash
# 检查API密钥
echo $OPENAI_API_KEY
# 确保密钥有效且未过期
```

#### 7.3 模型不可用

```bash
# 列出可用模型（Ollama示例）
curl http://localhost:11434/api/tags
```

### 8. 开发扩展

#### 8.1 添加新的LLM提供商

1. 在 `CustomLLMProvider` 枚举中添加新类型
2. 在 `CustomLLMAdapter` 中实现对应的方法
3. 更新配置工厂函数

#### 8.2 自定义消息格式

如果你的API使用特殊的消息格式，可以继承 `CustomLLMAdapter`：

```typescript
class MyCustomAdapter extends CustomLLMAdapter {
  protected convertToMyFormat(contents: any[]): any {
    // 实现自定义转换逻辑
  }
}
```

### 9. 性能优化

#### 9.1 连接池

```bash
# 配置连接池大小
CUSTOM_LLM_MAX_CONNECTIONS=10
```

#### 9.2 缓存

```bash
# 启用响应缓存
CUSTOM_LLM_CACHE_ENABLED=true
```

### 10. 监控和日志

#### 10.1 启用详细日志

```bash
DEBUG=llm:* pnpm start
```

#### 10.2 性能监控

```bash
# 记录API调用耗时
CUSTOM_LLM_LOG_PERFORMANCE=true
```

## 📝 配置检查清单

在部署前，请确保：

- [ ] API密钥正确配置
- [ ] 基础URL可访问
- [ ] 模型名称正确
- [ ] 网络连接正常
- [ ] 请求头格式正确
- [ ] 响应格式兼容

## 🔧 故障排除

### 连接问题

1. 检查网络连接
2. 验证API密钥
3. 确认模型可用
4. 检查防火墙设置

### 响应格式问题

1. 查看API文档
2. 使用curl测试
3. 检查日志输出
4. 验证JSON格式

### 性能问题

1. 调整超时设置
2. 启用缓存
3. 使用代理
4. 监控资源使用

## 📞 支持

如果遇到问题，请：

1. 检查本指南
2. 查看调试日志
3. 提交GitHub issue
4. 联系技术支持

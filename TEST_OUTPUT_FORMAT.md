# 验证 --output-format 功能指南

本文档说明如何在项目本地上下文切换到非交互模式并验证 `--output-format` 功能。

## 前置准备

### 1. 构建项目

首先需要构建项目，确保代码更改已编译：

```bash
# 在项目根目录执行
npm run build
```

### 2. 确认 CLI 可执行

构建完成后，可以通过以下方式运行 CLI：

```bash
# 方式1：使用 npm start（开发模式）
npm start

# 方式2：使用构建后的可执行文件
node packages/cli/dist/index.js

# 方式3：如果已全局安装
bluecode
```

## 切换到非交互模式

非交互模式有以下几种触发方式：

### 方式1：使用 `--prompt` 或 `-p` 参数

```bash
# 使用 --prompt 参数
npm start -- --prompt "你的问题"

# 或使用简写 -p
npm start -- -p "你的问题"
```

### 方式2：从 stdin 管道输入

```bash
# 使用 echo 管道输入
echo "你的问题" | npm start

# 或使用其他命令的输出
cat file.txt | npm start
```

### 方式3：组合使用（stdin + --prompt）

```bash
echo "第一部分" | npm start -- --prompt "第二部分"
```

## 验证不同的输出格式

### 1. 测试文本格式（默认）

```bash
# 默认就是文本格式
npm start -- --prompt "什么是微调？"

# 或显式指定
npm start -- --prompt "什么是微调？" --output-format text
```

**预期输出：**
```
微调（Fine-tuning）是...
```

### 2. 测试 JSON 格式

```bash
npm start -- --prompt "什么是微调？" --output-format json
```

**预期输出：**
```json
{
  "response": "微调（Fine-tuning）是...",
  "stats": {
    "turns": 1,
    "toolCalls": 0
  }
}
```

### 3. 测试流式 JSON 格式

```bash
npm start -- --prompt "什么是微调？" --output-format stream-json
```

**预期输出：**
```json
{"type":"content","data":{"text":"微调"},"timestamp":"2025-01-XX..."}
{"type":"content","data":{"text":"（Fine-tuning）"},"timestamp":"2025-01-XX..."}
{"type":"content","data":{"text":"是..."},"timestamp":"2025-01-XX..."}
{"type":"done","data":{"response":"微调（Fine-tuning）是...","stats":{"turns":1,"toolCalls":0}},"timestamp":"2025-01-XX..."}
```

### 4. 测试带工具调用的场景

```bash
# 测试一个会触发工具调用的命令
npm start -- --prompt "列出当前目录的文件" --output-format json
```

**预期输出（JSON 格式）：**
```json
{
  "response": "当前目录包含以下文件：...",
  "stats": {
    "turns": 2,
    "toolCalls": 1
  }
}
```

**预期输出（stream-json 格式）：**
```json
{"type":"tool_call","data":{"callId":"...","name":"list_directory","args":{...}},"timestamp":"..."}
{"type":"tool_response","data":{"tool":"list_directory","response":"..."},"timestamp":"..."}
{"type":"content","data":{"text":"当前目录包含..."},"timestamp":"..."}
{"type":"done","data":{"response":"...","stats":{"turns":2,"toolCalls":1}},"timestamp":"..."}
```

### 5. 测试错误处理

```bash
# 测试一个会出错的场景（例如文件不存在）
npm start -- --prompt "@不存在的文件.txt 解释这个文件" --output-format json
```

**预期输出：**
```json
{
  "response": "",
  "stats": {
    "turns": 0,
    "toolCalls": 0,
    "errors": ["Error executing tool ..."]
  },
  "error": "Exiting due to an error processing the @ command."
}
```

### 6. 使用管道输入测试

```bash
# 从文件读取输入
echo "解释一下 TypeScript 的优势" | npm start -- --output-format json

# 从其他命令获取输入
cat README.md | npm start -- --prompt "总结这个文件的内容" --output-format json
```

## 完整测试脚本示例

创建一个测试脚本 `test-output-format.sh`：

```bash
#!/bin/bash

echo "=== 测试文本格式 ==="
npm start -- --prompt "用一句话解释什么是 AI" --output-format text

echo -e "\n=== 测试 JSON 格式 ==="
npm start -- --prompt "用一句话解释什么是 AI" --output-format json

echo -e "\n=== 测试流式 JSON 格式 ==="
npm start -- --prompt "用一句话解释什么是 AI" --output-format stream-json

echo -e "\n=== 测试管道输入 ==="
echo "什么是机器学习？" | npm start -- --output-format json
```

在 Windows PowerShell 中，可以使用 `test-output-format.ps1`：

```powershell
Write-Host "=== 测试文本格式 ==="
npm start -- --prompt "用一句话解释什么是 AI" --output-format text

Write-Host "`n=== 测试 JSON 格式 ==="
npm start -- --prompt "用一句话解释什么是 AI" --output-format json

Write-Host "`n=== 测试流式 JSON 格式 ==="
npm start -- --prompt "用一句话解释什么是 AI" --output-format stream-json

Write-Host "`n=== 测试管道输入 ==="
echo "什么是机器学习？" | npm start -- --output-format json
```

## 验证要点

在验证时，请检查以下几点：

1. ✅ **文本格式**：输出应该是纯文本，没有 JSON 结构
2. ✅ **JSON 格式**：输出应该是有效的 JSON，包含 `response`、`stats` 字段
3. ✅ **stream-json 格式**：每行应该是一个独立的 JSON 对象，包含 `type`、`data`、`timestamp` 字段
4. ✅ **统计信息**：`stats` 应该正确记录轮次和工具调用次数
5. ✅ **错误处理**：当发生错误时，应该正确输出错误信息
6. ✅ **工具调用**：当有工具调用时，应该正确记录在统计信息中

## 常见问题

### Q: 提示 "Unknown arguments: output-format"
A: 确保已经运行了 `npm run build` 重新构建项目。

### Q: 输出格式不生效
A: 检查是否在非交互模式下运行（使用了 `--prompt` 或从 stdin 输入）。

### Q: JSON 格式输出不完整
A: 确保等待命令完全执行完成，JSON 格式会在最后统一输出。

### Q: stream-json 格式每行都是独立 JSON
A: 这是正确的行为，每行是一个事件对象，便于流式处理。

## 调试技巧

如果遇到问题，可以启用调试模式：

```bash
npm start -- --prompt "你的问题" --output-format json --debug
```

或者查看帮助信息：

```bash
npm start -- --help
```

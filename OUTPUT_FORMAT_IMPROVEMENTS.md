# Output Format 改进总结

## 已完成的改进

根据 [Gemini CLI 官方文档](https://geminicli.com/docs/cli/headless/#headless-mode)，我们已经将 JSON 和 stream-json 输出格式与官方文档保持一致。

### 1. JSON 输出格式改进

#### 之前（简化版本）
```json
{
  "response": "...",
  "stats": {
    "turns": 1,
    "toolCalls": 0,
    "errors": []
  },
  "error": "错误消息"
}
```

#### 现在（与官方文档一致）
```json
{
  "response": "...",
  "stats": {
    "models": {
      "gemini-2.5-pro": {
        "api": {
          "totalRequests": 2,
          "totalErrors": 0,
          "totalLatencyMs": 5053
        },
        "tokens": {
          "prompt": 24939,
          "candidates": 20,
          "total": 25113,
          "cached": 21263,
          "thoughts": 154,
          "tool": 0
        }
      }
    },
    "tools": {
      "totalCalls": 1,
      "totalSuccess": 1,
      "totalFail": 0,
      "totalDurationMs": 1881,
      "totalDecisions": {
        "accept": 0,
        "reject": 0,
        "modify": 0,
        "auto_accept": 1
      },
      "byName": {
        "google_web_search": {
          "count": 1,
          "success": 1,
          "fail": 0,
          "durationMs": 1881,
          "decisions": {
            "accept": 0,
            "reject": 0,
            "modify": 0,
            "auto_accept": 1
          }
        }
      }
    },
    "files": {
      "totalLinesAdded": 0,
      "totalLinesRemoved": 0
    }
  },
  "error": {
    "type": "ErrorType",
    "message": "错误消息",
    "code": 123
  }
}
```

### 2. Streaming JSON 输出格式改进

#### 事件类型（与官方文档一致）

1. **`init`** - 会话开始
   ```json
   {
     "type": "init",
     "timestamp": "2025-10-10T12:00:00.000Z",
     "session_id": "abc123",
     "model": "gemini-2.0-flash-exp"
   }
   ```

2. **`message`** - 用户提示和助手响应
   ```json
   {
     "type": "message",
     "role": "user",
     "content": "List files in current directory",
     "timestamp": "2025-10-10T12:00:01.000Z"
   }
   ```
   
   助手响应（delta 模式）：
   ```json
   {
     "type": "message",
     "role": "assistant",
     "content": "Here are the files...",
     "delta": true,
     "timestamp": "2025-10-10T12:00:04.000Z"
   }
   ```

3. **`tool_use`** - 工具调用请求
   ```json
   {
     "type": "tool_use",
     "tool_name": "Bash",
     "tool_id": "bash-123",
     "parameters": {
       "command": "ls -la"
     },
     "timestamp": "2025-10-10T12:00:02.000Z"
   }
   ```

4. **`tool_result`** - 工具执行结果
   ```json
   {
     "type": "tool_result",
     "tool_id": "bash-123",
     "status": "success",
     "output": "file1.txt\nfile2.txt",
     "timestamp": "2025-10-10T12:00:03.000Z"
   }
   ```

5. **`error`** - 错误和警告
   ```json
   {
     "type": "error",
     "timestamp": "2025-10-10T12:00:05.000Z",
     "message": "错误消息"
   }
   ```

6. **`result`** - 最终会话结果
   ```json
   {
     "type": "result",
     "status": "success",
     "stats": {
       "total_tokens": 250,
       "input_tokens": 50,
       "output_tokens": 200,
       "duration_ms": 3000,
       "tool_calls": 1
     },
     "timestamp": "2025-10-10T12:00:05.000Z"
   }
   ```

### 3. 主要改进点

#### JSON 格式
- ✅ 添加了详细的 `models` 统计（每个模型的 API 和 token 使用情况）
- ✅ 添加了详细的 `tools` 统计（包括按工具名称的详细统计）
- ✅ 添加了 `files` 统计（文件修改统计）
- ✅ 改进了错误格式（从字符串改为结构化对象）

#### Streaming JSON 格式
- ✅ 添加了 `init` 事件（会话开始）
- ✅ 统一了事件类型命名（`tool_use`, `tool_result` 等）
- ✅ 改进了 `message` 事件格式（支持 delta 模式）
- ✅ 添加了 `result` 事件（包含聚合统计）

### 4. 技术实现

#### 数据来源
- 使用 `uiTelemetryService.getMetrics()` 获取详细的统计信息
- 统计信息包括：
  - 模型使用情况（API 请求、token 使用、延迟等）
  - 工具调用统计（成功/失败、决策类型、按工具名称的详细统计）
  - 文件修改统计（添加/删除的行数）

#### 代码结构
- `buildJsonOutput()`: 构建符合官方文档格式的 JSON 输出
- `buildStatsFromMetrics()`: 从 metrics 构建统计信息（用于 result 事件）
- 所有事件都包含 `timestamp` 字段（ISO 8601 格式）

### 5. 使用示例

#### JSON 格式
```bash
npm start -- --prompt "解释 Docker" --output-format json
```

输出示例：
```json
{
  "response": "Docker 是一个容器化平台...",
  "stats": {
    "models": {
      "gemini-2.5-pro": {
        "api": {
          "totalRequests": 1,
          "totalErrors": 0,
          "totalLatencyMs": 2000
        },
        "tokens": {
          "prompt": 100,
          "candidates": 200,
          "total": 300,
          "cached": 0,
          "thoughts": 0,
          "tool": 0
        }
      }
    },
    "tools": {
      "totalCalls": 0,
      "totalSuccess": 0,
      "totalFail": 0,
      "totalDurationMs": 0
    },
    "files": {
      "totalLinesAdded": 0,
      "totalLinesRemoved": 0
    }
  }
}
```

#### Streaming JSON 格式
```bash
npm start -- --prompt "列出文件" --output-format stream-json
```

输出示例（每行一个 JSON 对象）：
```json
{"type":"init","timestamp":"2025-01-XX...","session_id":"...","model":"gemini-2.0-flash-exp"}
{"type":"message","role":"user","content":"列出文件","timestamp":"2025-01-XX..."}
{"type":"tool_use","tool_name":"list_directory","tool_id":"...","parameters":{},"timestamp":"2025-01-XX..."}
{"type":"tool_result","tool_id":"...","status":"success","output":"file1.txt\nfile2.txt","timestamp":"2025-01-XX..."}
{"type":"message","role":"assistant","content":"当前目录包含以下文件：","delta":true,"timestamp":"2025-01-XX..."}
{"type":"result","status":"success","stats":{"total_tokens":250,"input_tokens":50,"output_tokens":200,"duration_ms":3000,"tool_calls":1},"timestamp":"2025-01-XX..."}
```

### 6. 与官方文档的对比

| 功能 | 官方文档 | 我们的实现 | 状态 |
|------|---------|-----------|------|
| JSON 基础结构 | ✅ | ✅ | ✅ 完全一致 |
| JSON 详细统计 | ✅ models/tools/files | ✅ models/tools/files | ✅ 完全一致 |
| JSON 错误格式 | ✅ 结构化对象 | ✅ 结构化对象 | ✅ 完全一致 |
| Stream init 事件 | ✅ | ✅ | ✅ 完全一致 |
| Stream message 事件 | ✅ | ✅ | ✅ 完全一致 |
| Stream tool_use 事件 | ✅ | ✅ | ✅ 完全一致 |
| Stream tool_result 事件 | ✅ | ✅ | ✅ 完全一致 |
| Stream error 事件 | ✅ | ✅ | ✅ 完全一致 |
| Stream result 事件 | ✅ | ✅ | ✅ 完全一致 |

### 7. 注意事项

1. **统计信息收集**：统计信息依赖于 `uiTelemetryService`，确保在非交互模式下也能正确收集统计信息。

2. **事件顺序**：Streaming JSON 的事件按时间顺序输出，确保事件的时间戳准确。

3. **错误处理**：所有错误都通过结构化格式输出，便于程序化处理。

4. **性能考虑**：详细的统计信息会增加 JSON 输出的体积，但对于自动化场景很有价值。

### 8. 测试建议

建议测试以下场景：

1. **简单查询**（无工具调用）
   ```bash
   npm start -- --prompt "什么是 AI？" --output-format json
   ```

2. **带工具调用的查询**
   ```bash
   npm start -- --prompt "列出当前目录文件" --output-format json
   ```

3. **Streaming JSON 实时输出**
   ```bash
   npm start -- --prompt "分析这个项目" --output-format stream-json
   ```

4. **错误场景**
   ```bash
   npm start -- --prompt "@不存在的文件.txt 解释" --output-format json
   ```

5. **使用管道输入**
   ```bash
   echo "解释 TypeScript" | npm start -- --output-format json
   ```

## 总结

✅ 所有输出格式已与官方文档保持一致
✅ 支持详细的统计信息收集和输出
✅ 支持实时事件流输出
✅ 错误处理更加完善
✅ 代码结构清晰，易于维护

1.中文编码解码问题
2.错误处理问题
3.文件读写等复杂场景
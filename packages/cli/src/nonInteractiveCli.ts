/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ToolCallRequestInfo, SessionMetrics } from '@vivo/bluecode-cli-core';
import {
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  parseAndFormatApiError,
  FatalInputError,
  FatalTurnLimitedError,
  uiTelemetryService,
  sessionId,
} from '@vivo/bluecode-cli-core';
import type { Content, Part } from '@google/genai';

import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';

/**
 * 输出格式类型定义
 * - text: 普通文本格式（默认）
 * - json: 结构化 JSON 格式，包含完整响应和统计信息
 * - stream-json: 实时事件流 JSON 格式（换行分隔），适用于管道和监控
 */
export type OutputFormat = 'text' | 'json' | 'stream-json';

/**
 * Think 标签过滤器（用于无头模式）
 *
 * 功能：
 * - 过滤所有 think 标签及其内容
 * - 保留标签之间的正常内容
 * - 支持流式处理（跨 chunk）
 * - 压缩多余空行（think 标签之间最多保留 1 个空行）
 */
class ThinkFilter {
  private static readonly START_TAG = '<think>';
  private static readonly END_TAG = '</think>';

  private state: 'OUTSIDE' | 'INSIDE' | 'MATCHING_START' | 'MATCHING_END';
  private buffer: string;
  private matchIndex: number;

  constructor() {
    this.state = 'OUTSIDE';
    this.buffer = '';
    this.matchIndex = 0;
  }

  reset(): void {
    this.state = 'OUTSIDE';
    this.buffer = '';
    this.matchIndex = 0;
  }

  filterChunk(chunk: string): string {
    let result = '';

    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];

      switch (this.state) {
        case 'OUTSIDE':
          if (char === '<') {
            this.state = 'MATCHING_START';
            this.buffer = '<';
            this.matchIndex = 1;
          } else {
            result += char;
          }
          break;

        case 'MATCHING_START':
          this.buffer += char;

          if (char === ThinkFilter.START_TAG[this.matchIndex]) {
            this.matchIndex++;

            if (this.matchIndex === ThinkFilter.START_TAG.length) {
              this.state = 'INSIDE';
              this.buffer = '';
              this.matchIndex = 0;
            }
          } else {
            result += this.buffer;
            this.state = 'OUTSIDE';
            this.buffer = '';
            this.matchIndex = 0;
          }
          break;

        case 'INSIDE':
          if (char === '<') {
            this.state = 'MATCHING_END';
            this.buffer = '<';
            this.matchIndex = 1;
          }
          break;

        case 'MATCHING_END':
          this.buffer += char;

          if (char === ThinkFilter.END_TAG[this.matchIndex]) {
            this.matchIndex++;

            if (this.matchIndex === ThinkFilter.END_TAG.length) {
              this.state = 'OUTSIDE';
              this.buffer = '';
              this.matchIndex = 0;
            }
          } else {
            this.state = 'INSIDE';
            this.buffer = '';
            this.matchIndex = 0;
          }
          break;

        default:
          break;
      }
    }

    return result;
  }

  filterText(text: string): string {
    let filtered = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    filtered = filtered.replace(/\n{3,}/g, '\n\n');
    filtered = filtered.replace(/^\n+/, '').replace(/\n+$/, '\n');
    return filtered;
  }
}

/**
 * JSON 输出格式的数据结构
 */
/**
 * JSON 输出格式的数据结构
 * 注意：除了 error 字段是可选的，其他所有字段都是必须的
 */
interface JsonOutput {
  /** 完整的响应文本内容 */
  response: string;
  /** 详细统计信息 */
  stats: {
    /** 每个模型的详细统计 */
    models: Record<string, {
      api: {
        totalRequests: number;
        totalErrors: number;
        totalLatencyMs: number;
      };
      tokens: {
        prompt: number;
        candidates: number;
        total: number;
        cached: number;
        thoughts: number;
        tool: number;
      };
    }>;
    /** 工具执行统计 */
    tools: {
      totalCalls: number;
      totalSuccess: number;
      totalFail: number;
      totalDurationMs: number;
      /** 决策统计 */
      totalDecisions: {
        accept: number;
        reject: number;
        modify: number;
        auto_accept: number;
      };
      /** 按工具名称的详细统计 */
      byName: Record<string, {
        count: number;
        success: number;
        fail: number;
        durationMs: number;
        decisions: {
          accept: number;
          reject: number;
          modify: number;
          auto_accept: number;
        };
      }>;
    };
    /** 文件修改统计 */
    files: {
      totalLinesAdded: number;
      totalLinesRemoved: number;
    };
  };
  /** 结构化错误信息（可选，只在有错误时存在） */
  error?: {
    type: string;
    message: string;
    code?: number;
  };
}

/**
 * 在非交互模式下运行 Gemini CLI
 * 
 * @param config - 配置对象
 * @param input - 用户输入的提示文本
 * @param prompt_id - 提示的唯一标识符
 * @param outputFormat - 输出格式，默认为 'text'
 * @returns Promise<void>
 */
export async function runNonInteractive(
  config: Config,
  input: string,
  prompt_id: string,
  outputFormat: OutputFormat = 'text',
): Promise<void> {
  // 创建控制台补丁器，用于拦截和重定向输出
  const consolePatcher = new ConsolePatcher({
    stderr: false,
    debugMode: config.getDebugMode(),
    onNewMessage: () => {},  // 在非交互模式下忽略所有消息
  });

  // 用于跟踪输出的变量（在 try 和 catch 块中都会使用）
  let turnCount = 0;        // 对话轮次计数
  let responseText = '';    // 累积的响应文本（用于 JSON 格式）
  let currentModel: string | undefined; // 当前使用的模型
  let sessionStarted = false; // 是否已发送 init 事件
  const thinkFilter = new ThinkFilter(); // Think 标签过滤器

  try {
    // 应用控制台补丁
    consolePatcher.patch();
    
    // 处理 EPIPE 错误：当输出被管道到提前关闭的命令时会发生此错误
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // 如果管道已关闭，优雅地退出
        process.exit(0);
      }
    });

    // 获取 Gemini 客户端实例
    const geminiClient = config.getGeminiClient();

    // 创建中止控制器，用于取消操作
    const abortController = new AbortController();

    // 处理 @ 命令（文件包含等）
    const { processedQuery, shouldProceed } = await handleAtCommand({
      query: input,
      config,
      addItem: (_item, _timestamp) => 0,
      onDebugMessage: () => {},
      messageId: Date.now(),
      signal: abortController.signal,
    });

    // 如果 @ 命令处理失败（例如文件未找到），抛出错误
    if (!shouldProceed || !processedQuery) {
      // 错误消息已经由 handleAtCommand 记录
      throw new FatalInputError(
        'Exiting due to an error processing the @ command.',
      );
    }

    // 初始化当前消息列表
    let currentMessages: Content[] = [
      { role: 'user', parts: processedQuery as Part[] },
    ];

    // 发送 init 事件（stream-json 格式）
    if (outputFormat === 'stream-json' && !sessionStarted) {
      const model = config.getModel() || 'unknown';
      currentModel = model;
      process.stdout.write(
        JSON.stringify({
          type: 'init',
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          model: model,
        }) + '\n',
      );
      sessionStarted = true;
    }

    // 发送用户消息事件（stream-json 格式）
    if (outputFormat === 'stream-json') {
      process.stdout.write(
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: input,
          timestamp: new Date().toISOString(),
        }) + '\n',
      );
    }

    // 主循环：处理多轮对话和工具调用
    while (true) {
      turnCount++;

      // 重置 Think 过滤器状态（新的对话轮次）
      thinkFilter.reset();

      // 检查是否超过最大对话轮次限制
      if (
        config.getMaxSessionTurns() >= 0 &&
        turnCount > config.getMaxSessionTurns()
      ) {
        const error = new FatalTurnLimitedError(
          'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
        );

        // 根据输出格式输出错误信息
        if (outputFormat === 'json') {
          const metrics = uiTelemetryService.getMetrics();
          const filteredResponse = thinkFilter.filterText(responseText);
          const output = buildJsonOutput(filteredResponse, metrics, {
            type: 'FatalTurnLimitedError',
            message: error.message,
          });
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        } else if (outputFormat === 'stream-json') {
          process.stdout.write(
            JSON.stringify({
              type: 'error',
              timestamp: new Date().toISOString(),
              message: error.message,
            }) + '\n',
          );
        } else {
          console.error(error.message);
        }
        throw error;
      }

      // 存储本轮的工具调用请求
      const toolCallRequests: ToolCallRequestInfo[] = [];

      // 发送消息并获取响应流
      const responseStream = geminiClient.sendMessageStream(
        currentMessages[0]?.parts || [],
        abortController.signal,
        prompt_id,
      );

      // 处理响应流中的事件
      for await (const event of responseStream) {
        // 检查操作是否已被取消
        if (abortController.signal.aborted) {
          const cancelMessage = 'Operation cancelled.';
          if (outputFormat === 'json') {
            const metrics = uiTelemetryService.getMetrics();
            const filteredResponse = thinkFilter.filterText(responseText);
            const output = buildJsonOutput(filteredResponse, metrics, {
              type: 'CancellationError',
              message: cancelMessage,
            });
            process.stdout.write(JSON.stringify(output, null, 2) + '\n');
          } else if (outputFormat === 'stream-json') {
            process.stdout.write(
              JSON.stringify({
                type: 'error',
                timestamp: new Date().toISOString(),
                message: cancelMessage,
              }) + '\n',
            );
          } else {
            console.error(cancelMessage);
          }
          return;
        }

        // 处理内容事件（模型返回的文本）
        if (event.type === GeminiEventType.Content) {
          let content = event.value;

          // 应用 Think 标签过滤（流式）
          content = thinkFilter.filterChunk(content);

          // 如果过滤后内容为空（在 think 标签内），跳过输出
          if (!content) {
            continue;
          }

          responseText += content; // 累积响应文本（用于 JSON 格式）

          if (outputFormat === 'text') {
            // 文本格式：直接输出内容
            process.stdout.write(content);
          } else if (outputFormat === 'stream-json') {
            // 流式 JSON 格式：实时输出消息事件（delta 模式）
            process.stdout.write(
              JSON.stringify({
                type: 'message',
                role: 'assistant',
                content: content,
                delta: true,
                timestamp: new Date().toISOString(),
              }) + '\n',
            );
          }
          // JSON 格式：累积响应，在最后统一输出
        } else if (event.type === GeminiEventType.ToolCallRequest) {
          // 处理工具调用请求
          toolCallRequests.push(event.value);

          if (outputFormat === 'stream-json') {
            // 流式 JSON 格式：实时输出工具调用事件（tool_use）
            process.stdout.write(
              JSON.stringify({
                type: 'tool_use',
                tool_name: event.value.name,
                tool_id: event.value.callId,
                parameters: event.value.args,
                timestamp: new Date().toISOString(),
              }) + '\n',
            );
          }
        }
      }

      // 如果有工具调用请求，执行它们
      if (toolCallRequests.length > 0) {
        const toolResponseParts: Part[] = [];

        // 依次执行每个工具调用
        for (const requestInfo of toolCallRequests) {
          const toolResponse = await executeToolCall(
            config,
            requestInfo,
            abortController.signal,
          );

          // 处理工具执行结果（无论成功或失败都输出 tool_result 事件）
          if (outputFormat === 'stream-json') {
            if (toolResponse.error) {
              // 工具执行失败
              process.stdout.write(
                JSON.stringify({
                  type: 'tool_result',
                  tool_id: requestInfo.callId,
                  status: 'error',
                  output: toolResponse.resultDisplay || toolResponse.error.message,
                  timestamp: new Date().toISOString(),
                }) + '\n',
              );
            } else {
              // 工具执行成功
              process.stdout.write(
                JSON.stringify({
                  type: 'tool_result',
                  tool_id: requestInfo.callId,
                  status: 'success',
                  output: toolResponse.resultDisplay || 'Tool executed',
                  timestamp: new Date().toISOString(),
                }) + '\n',
              );
            }
          }

          // 处理工具执行错误（文本格式）
          if (toolResponse.error) {
            const errorMessage = `Error executing tool ${requestInfo.name}: ${toolResponse.resultDisplay || toolResponse.error.message}`;
            if (outputFormat === 'text') {
              // 文本格式：输出到 stderr
              console.error(errorMessage);
            }
          }

          // 收集工具响应部分
          if (toolResponse.responseParts) {
            toolResponseParts.push(...toolResponse.responseParts);
          }
        }
        
        // 将工具响应作为新的用户消息，继续下一轮对话
        currentMessages = [{ role: 'user', parts: toolResponseParts }];
      } else {
        // 没有更多工具调用，输出最终结果
        if (outputFormat === 'json') {
          // JSON 格式：输出完整的结构化响应
          const metrics = uiTelemetryService.getMetrics();
          const filteredResponse = thinkFilter.filterText(responseText);
          const output = buildJsonOutput(filteredResponse, metrics);
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        } else if (outputFormat === 'stream-json') {
          // 流式 JSON 格式：输出最终结果事件（result）
          const metrics = uiTelemetryService.getMetrics();
          const finalEvent = {
            type: 'result',
            status: 'success',
            stats: buildStatsFromMetrics(metrics),
            timestamp: new Date().toISOString(),
          };
          process.stdout.write(JSON.stringify(finalEvent) + '\n');
        } else {
          // 文本格式：确保最后有一个换行符
          process.stdout.write('\n');
        }
        return;
      }
    }
  } catch (error) {
    // 捕获并格式化错误信息
    const errorMessage = parseAndFormatApiError(
      error,
      config.getContentGeneratorConfig()?.authType,
    );

    // 确定错误类型
    const errorType =
      error instanceof FatalInputError
        ? 'FatalInputError'
        : error instanceof FatalTurnLimitedError
          ? 'FatalTurnLimitedError'
          : error instanceof Error
            ? error.constructor.name
            : 'UnknownError';

    // 根据输出格式输出错误信息
    if (outputFormat === 'json') {
      const metrics = uiTelemetryService.getMetrics();
      const filteredResponse = thinkFilter.filterText(responseText);
      const output = buildJsonOutput(filteredResponse, metrics, {
        type: errorType,
        message: errorMessage,
      });
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    } else if (outputFormat === 'stream-json') {
      process.stdout.write(
        JSON.stringify({
          type: 'error',
          timestamp: new Date().toISOString(),
          message: errorMessage,
        }) + '\n',
      );
    } else {
      // 文本格式：输出到 stderr
      console.error(errorMessage);
    }
    throw error;
  } finally {
    // 清理资源
    consolePatcher.cleanup();
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry(config);
    }
  }
}

/**
 * 构建 JSON 输出对象
 */
function buildJsonOutput(
  response: string,
  metrics: SessionMetrics,
  error?: { type: string; message: string; code?: number },
): JsonOutput {
  // 构建完整的统计信息结构
  const output: JsonOutput = {
    response,
    stats: {
      models: {},
      tools: {
        totalCalls: metrics.tools.totalCalls ?? 0,
        totalSuccess: metrics.tools.totalSuccess ?? 0,
        totalFail: metrics.tools.totalFail ?? 0,
        totalDurationMs: metrics.tools.totalDurationMs ?? 0,
        totalDecisions: {
          accept: (metrics.tools.totalDecisions as Record<string, number>)['accept'] ?? 0,
          reject: (metrics.tools.totalDecisions as Record<string, number>)['reject'] ?? 0,
          modify: (metrics.tools.totalDecisions as Record<string, number>)['modify'] ?? 0,
          auto_accept: (metrics.tools.totalDecisions as Record<string, number>)['auto_accept'] ?? 0,
        },
        byName: {},
      },
      files: {
        totalLinesAdded: metrics.files.totalLinesAdded ?? 0,
        totalLinesRemoved: metrics.files.totalLinesRemoved ?? 0,
      },
    },
  };

  for (const [modelName, modelMetrics] of Object.entries(metrics.models)) {
    output.stats.models[modelName] = {
      api: {
        totalRequests: modelMetrics.api.totalRequests ?? 0,
        totalErrors: modelMetrics.api.totalErrors ?? 0,
        totalLatencyMs: modelMetrics.api.totalLatencyMs ?? 0,
      },
      tokens: {
        prompt: modelMetrics.tokens.prompt ?? 0,
        candidates: modelMetrics.tokens.candidates ?? 0,
        total: modelMetrics.tokens.total ?? 0,
        cached: modelMetrics.tokens.cached ?? 0,
        thoughts: modelMetrics.tokens.thoughts ?? 0,
        tool: modelMetrics.tokens.tool ?? 0,
      },
    };
  }

  for (const [toolName, toolStats] of Object.entries(metrics.tools.byName)) {
    output.stats.tools.byName[toolName] = {
      count: toolStats.count ?? 0,
      success: toolStats.success ?? 0,
      fail: toolStats.fail ?? 0,
      durationMs: toolStats.durationMs ?? 0,
      decisions: {
        accept: (toolStats.decisions as Record<string, number>)['accept'] ?? 0,
        reject: (toolStats.decisions as Record<string, number>)['reject'] ?? 0,
        modify: (toolStats.decisions as Record<string, number>)['modify'] ?? 0,
        auto_accept: (toolStats.decisions as Record<string, number>)['auto_accept'] ?? 0,
      },
    };
  }

  if (error) {
    output.error = {
      type: error.type,
      message: error.message,
      ...(error.code !== undefined && { code: error.code }),
    };
  }

  return output;
}

/**
 * 从 metrics 构建统计信息（用于 stream-json 的 result 事件）
 */
function buildStatsFromMetrics(metrics: SessionMetrics) {
  // 计算总 token 数
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;
  let toolCalls = metrics.tools.totalCalls;

  for (const modelMetrics of Object.values(metrics.models)) {
    totalTokens += modelMetrics.tokens.total;
    inputTokens += modelMetrics.tokens.prompt;
    outputTokens += modelMetrics.tokens.candidates;
    durationMs += modelMetrics.api.totalLatencyMs;
  }

  return {
    total_tokens: totalTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: durationMs,
    tool_calls: toolCalls,
  };
}

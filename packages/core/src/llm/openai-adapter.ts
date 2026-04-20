/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensResponse,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
  FinishReason,
  FunctionCall,
  ToolListUnion,
  Part,
  Content,
} from '@google/genai';
import { ContentGenerator } from '../core/contentGenerator.js';
import { logApiResponse } from '../telemetry/loggers.js'
import { ApiResponseEvent } from '../telemetry/types.js'
import { Config } from '../config/config.js';
import { TokenCalculator, ModelConfig } from './token-calculator.js';
import { TokenUsageInfo, UsageTracker, hashRequestContent } from './usage-tracker.js';
/**
 * OpenAI API配置
 */
export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  apiHost?: string;
  organization?: string;
  project?: string;
  timeout?: number;
  headers?: Record<string, string>;
  modelConfig?: ModelConfig;
  // 新增userId，用于token限流等
  userId?: string;
}

/**
 * OpenAI消息格式
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content:
  | string
  | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_details?: any; // 保存推理详情
}

/**
 * OpenAI工具调用格式
 */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  // Present in streaming deltas; helps correlate chunks before an id is provided
  index?: number;
}

/**
 * OpenAI函数定义格式
 */
interface OpenAIFunction {
  name: string;
  description?: string;
  parameters: any;
}

/**
 * OpenAI工具定义格式
 */
interface OpenAITool {
  type: 'function';
  function: OpenAIFunction;
}

/**
 * OpenAI API响应格式
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_details?: any; // 推理详情
    };
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_details?: any; // 流式推理详情
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      audio_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
    };
  };
}

/**
 * OpenAI 适配器
 * 将OpenAI API适配为ContentGenerator接口，支持工具调用和流式响应
 */
// 内部状态：用于过滤 <think>...</think>
type ReasoningState = {
  inThinking: boolean;
  pending: string;
  visibleBuffer: string;
};

export class OpenAIAdapter implements ContentGenerator {
  private config: OpenAIConfig;
  // 统一的思考标签常量
  private readonly THINK_OPEN_TAG = '<think>';
  private readonly THINK_CLOSE_TAG = '</think>';
  private readonly DEFAULT_INPUT_TOKENS = 10000;
  /**
   * 🎯 追踪已上报过 api_response 事件的 prompt_id
   * 确保每个用户会话只上报首次 API 响应
   */
  private readonly reportedPromptIds: Set<string> = new Set();
  // Token使用情况追踪器
  private usageTracker: UsageTracker;
  // API Host (用于前缀baseUrl)
  private readonly apiHost: string;

  constructor(config: OpenAIConfig) {
    this.config = {
      baseUrl: 'https://api.openai.com/v1',
      timeout: 60000,
      ...config,
    };
    this.apiHost = config.apiHost || '';
    this.usageTracker = new UsageTracker();
  }

  private resolveUserId(sysConfig?: Config): string | undefined {
    // Priority:
    // 1) runtime Config customData (most accurate per session/user)
    // 2) adapter construction-time config fallback
    // 3) env fallback (useful for debugging/headless)
    return (
      sysConfig?.getCustomData<string>('userId') ||
      this.config.userId ||
      process.env['BLUECODE_USER_ID'] ||
      process.env['USER_ID']
    );
  }

  /**
   * 估算工具定义在 prompt 中占用的 token 数
   * 用于 toolUsePromptTokenCount 字段
   * 使用与 TokenCalculator 类似的逻辑，考虑 API 差异和语言组成
   */
  private estimateToolUsePromptTokens(request?: GenerateContentParameters): number {
    if (!request?.config?.tools) {
      return 0;
    }

    try {
      // 将工具定义序列化为 JSON 字符串
      const toolsJson = JSON.stringify(request.config.tools);
      
      // 分析语言组成（类似 TokenCalculator.analyzeLanguage）
      const CHINESE_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
      const ENGLISH_WORD_REGEX = /[a-zA-Z]+/g;
      const chineseMatches = toolsJson.match(CHINESE_CHAR_REGEX) || [];
      const englishMatches = toolsJson.match(ENGLISH_WORD_REGEX) || [];
      const chineseChars = chineseMatches.length;
      const englishChars = englishMatches.join('').length;
      const totalLength = toolsJson.length;
      const otherChars = totalLength - chineseChars - englishChars;
      const chineseRatio = totalLength > 0 ? chineseChars / totalLength : 0;
      
      // 根据 OpenAI API 的特性计算 tokens（GPT系列对中文token消耗较高）
      // OpenAI: 中文约1字符/token，英文约4字符/token，其他约2字符/token
      let totalTokens = Math.ceil(chineseChars / 1) + 
                       Math.ceil(englishChars / 4) + 
                       Math.ceil(otherChars / 2);
      
      // 工具定义的 JSON 结构本身有额外开销（字段名、括号、引号等）
      // 每个工具约增加 30-50 tokens 的结构开销
      const toolCount = Array.isArray(request.config.tools) ? request.config.tools.length : 1;
      const structureOverhead = toolCount * 40; // 每个工具约 40 tokens 的结构开销
      
      return totalTokens + structureOverhead;
    } catch (error) {
      console.warn('Failed to estimate tool use prompt tokens:', error);
      // 如果序列化失败，使用粗略估算：每个工具约 200 tokens
      const toolCount = Array.isArray(request.config.tools) ? request.config.tools.length : 1;
      return toolCount * 200;
    }
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): Promise<GenerateContentResponse> {
    return this.requestPost(request, userPromptId, sysConfig);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.requestStreamingPost(request, userPromptId, sysConfig);
  }
  // 初始化思考过滤状态
  private initReasoningState(): ReasoningState {
    return { inThinking: false, pending: '', visibleBuffer: '' };
  }

  // 处理一段文本到思考过滤状态机
  private processReasoningChunk(state: ReasoningState, chunk: string): void {
    if (!chunk) return;
    const OPEN_TAG = this.THINK_OPEN_TAG;
    const CLOSE_TAG = this.THINK_CLOSE_TAG;

    // 扫描窗口：上次遗留前缀 + 本次块
    const window = state.pending + chunk;
    const lower = window.toLowerCase();
    let idx = 0;

    while (idx < window.length) {
      if (!state.inThinking) {
        const openIdx = lower.indexOf(OPEN_TAG, idx);
        if (openIdx === -1) {
          // 剩余内容可能包含开标签前缀，末尾留作 pending
          break;
        }
        // 输出开标签之前的可见内容
        if (openIdx > idx) {
          state.visibleBuffer += window.slice(idx, openIdx);
        }
        // 跳过开标签，进入思考态
        idx = openIdx + OPEN_TAG.length;
        state.inThinking = true;
      } else {
        const closeIdx = lower.indexOf(CLOSE_TAG, idx);
        if (closeIdx === -1) {
          // 剩余内容可能包含闭标签前缀，末尾留作 pending
          break;
        }
        // 丢弃思考内容，跳过闭标签
        idx = closeIdx + CLOSE_TAG.length;
        state.inThinking = false;
      }
    }

    // 处理尾部：保留可能的标签前缀到 pending
    const tailLower = lower.slice(idx);
    const tail = window.slice(idx);
    const target = state.inThinking ? CLOSE_TAG : OPEN_TAG;
    let keep = 0;
    const maxKeep = Math.min(tailLower.length, target.length - 1);
    for (let k = maxKeep; k > 0; k--) {
      if (target.startsWith(tailLower.slice(-k))) {
        keep = k;
        break;
      }
    }

    if (!state.inThinking) {
      // 非思考态：尾部除去 pending 的部分可见
      if (tail.length - keep > 0) {
        state.visibleBuffer += tail.slice(0, tail.length - keep);
      }
      state.pending = keep > 0 ? tail.slice(-keep) : '';
    } else {
      // 思考态：尾部全部丢弃，仅保留 pending
      state.pending = keep > 0 ? tail.slice(-keep) : '';
    }
  }

  // 取出可见文本（如果有），并清空缓冲
  private popVisible(state: ReasoningState): string | undefined {
    if (!state.visibleBuffer) return undefined;
    const out = state.visibleBuffer;
    state.visibleBuffer = '';
    return out;
  }

  /**
   * 过滤文本中的 <think>...</think> 标签
   * 用于非流式请求，与流式请求的过滤逻辑保持一致
   * @param text 原始文本
   * @returns 过滤后的文本
   */
  private filterThinkTags(text: string): string {
    if (!text) return text;

    const state = this.initReasoningState();
    this.processReasoningChunk(state, text);
    
    // 处理完整文本后，提取可见内容
    const visible = this.popVisible(state);
    
    // 如果还有 pending 且不在思考态，说明是正常文本的尾部
    if (state.pending && !state.inThinking) {
      return (visible || '') + state.pending;
    }
    
    return visible || '';
  }

  private getCompletionsUrl(): string {
    const base = this.config.baseUrl || 'https://api.openai.com/v1';
    // If caller already provided a full endpoint (chat/completions or responses), use as-is
    if (/\/(chat\/completions|responses)(\?|$)/.test(base)) return base;
    // If base looks like OpenAI REST root, append chat/completions
    if (/\/v1\/?$/.test(base))
      return `${base.replace(/\/$/, '')}/chat/completions`;
    if (/\/v4\/?$/.test(base))
      return `${base.replace(/\/$/, '')}/chat/completions`;
    // Otherwise, assume the base already encodes the right endpoint (e.g., Azure or proxy)
    return base;
  }

  /**
   * 动态计算max_tokens值
   * 🎯 优化：使用增量计算 - 历史messages的实际token数 + 最新message的估算
   * @param request 请求参数
   * @param options 可选配置
   * @param options.ignoreMaxOutputLimit 是否忽略 maxOutputTokenSize 限制（用于压缩场景）
   */
  private calculateMaxTokens(
    request: GenerateContentParameters, 
    options?: { ignoreMaxOutputLimit?: boolean }
  ): number {
    if (!this.config.modelConfig) {
      console.warn('OpenAIAdapter: 缺少模型配置，使用默认max_tokens值');
      return this.DEFAULT_INPUT_TOKENS; // 默认值
    }

    // 🎯 优化：尝试使用增量计算
    const contents = Array.isArray(request.contents) ? request.contents : [request.contents];
    let estimatedInputTokens: number;
    
    if (contents.length > 1) {
      const lastMessage = contents[contents.length - 1];
      const lastRole = (lastMessage as any)?.role;
      
      // 🎯 如果最后一条是 user 或 tool（工具响应），尝试增量计算
      // OpenAI: user → assistant(tool_calls) → tool(results) → assistant(response)
      // 说明：tool role 表示工具刚执行完返回结果，即将请求 model 生成最终响应
      if (lastRole === 'user' || lastRole === 'tool') {
        const historyContents = contents.slice(0, -1);
        const historicalTokens = this.usageTracker.getHistoricalTokens(historyContents);
        
        if (historicalTokens !== null) {
          // 🎯 只估算最新一条 user/tool message 的token数
          // 注意：不包含 systemInstruction 和 tools，因为历史实际值中已经包含了
          const latestMessageRequest = {
            model: request.model,
            contents: lastMessage,
            // ❌ 不携带 config，避免重复计算 system 和 tools
            // config: {
            //   systemInstruction: request.config?.systemInstruction,
            //   tools: request.config?.tools
            // }
          } as GenerateContentParameters;
          const latestTokens = TokenCalculator.estimateInputTokensOnly(
            this.config.modelConfig,
            latestMessageRequest
          );
          
          // 增量计算：历史实际值（含system+tools） + 最新估算值（仅message）
          estimatedInputTokens = historicalTokens + latestTokens;
          console.log(
            `🎯 [OpenAI] calculateMaxTokens: 增量计算 ${historicalTokens}(历史实际，含system+tools) + ${latestTokens}(最新${lastRole}，仅message) = ${estimatedInputTokens} tokens`
          );
        } else {
          // 回退到完整估算
          estimatedInputTokens = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
          console.log(`OpenAIAdapter: 完整估算输入=${estimatedInputTokens} tokens`);
        }
      } else {
        // 不是 user/tool message，使用完整估算
        estimatedInputTokens = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
        console.log(`OpenAIAdapter: 完整估算输入=${estimatedInputTokens} tokens`);
      }
    } else {
      // 单条消息，直接估算
      estimatedInputTokens = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
      console.log(`OpenAIAdapter: 单条消息估算输入=${estimatedInputTokens} tokens`);
    }

    // 使用估算的输入token数计算max_tokens
    const result = TokenCalculator.computeMaxTokensFromEstimatedInput(
      this.config.modelConfig,
      estimatedInputTokens,
      options  // 🎯 传递 options 参数
    );

    if (result.warnings && result.warnings.length > 0) {
      console.warn('OpenAIAdapter token计算警告:', result.warnings);
    }

    if (!result.isWithinLimits) {
      console.warn('OpenAIAdapter: 请求可能超出模型token限制');
    }

    console.log(`OpenAIAdapter: 动态计算max_tokens=${result.maxTokens}`);

    return result.maxTokens;
  }

  async requestPost(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): Promise<GenerateContentResponse> {
    const systemInstruction = request.config?.systemInstruction as string;
    const tools = request.config?.tools;

    const messages = this.convertToOpenAIMessages(
      Array.isArray(request.contents) ? request.contents : [request.contents],
      systemInstruction,
    );

    // if (tools && this.hasTools(tools)) {
    //   messages.unshift({
    //     role: 'system',
    //     content:
    //       "Tool calling policy: If and only if a provided tool is needed to fulfill the request, respond with tool_calls entries where each tool_calls[i].function.name exactly matches one of the provided tool names and tool_calls[i].function.arguments is a valid JSON object matching that tool's schema. Do not invent names. Do not omit the name.",
    //   });
    // }

    // 动态计算max_tokens
    // 对于历史记录压缩场景，由于没有专用的上下文窗口更大的摘要压缩模型，所以此处不采用传入的 request.config.maxOutputTokens (即压缩前的 originalTokenCount)
    let maxTokens: number
    if (request.config?.maxOutputTokens) {
      maxTokens = this.calculateMaxTokens(request, {
        ignoreMaxOutputLimit: true
      });
    } else {
      maxTokens = this.calculateMaxTokens(request);
    }

    const requestBody: any = {
      prompt_id: userPromptId,
      model: request.model || this.config.modelConfig?.config.model || 'gpt-4',
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      reasoning_split: !!this.config.modelConfig?.config.reasoningSplit
    };

    // 在请求体中添加userId
    const userId = this.resolveUserId(sysConfig);
    if (userId) {
      requestBody.user = userId;
    }

    if (request?.config?.responseJsonSchema) {
      requestBody.response_format = {
        type: 'json_schema',
        json_schema: request?.config?.responseJsonSchema
      }
    }

    if (tools && this.hasTools(tools)) {
      requestBody.tools = this.convertToolsToOpenAIFormat(tools);
      requestBody.tool_choice = 'auto';
      requestBody.parallel_tool_calls = true;
    }

    const url = this.getCompletionsUrl();
    const fullUrl = url.startsWith('http')? url : (this.apiHost ? `${this.apiHost}${url}` : url);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.organization
        ? { 'OpenAI-Organization': this.config.organization }
        : {}),
      ...(this.config.project
        ? { 'OpenAI-Project': this.config.project }
        : {}),
      ...this.config.headers,
    };
    if (userId) {
      headers['x-user-id'] = userId;
    }

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const message = choice?.message;
    const rawContent = message?.content || '';
    const toolCalls = (message?.tool_calls || []) as OpenAIToolCall[];
    const reasoningDetails = message?.reasoning_details; // 🎯 提取 reasoning_details

    let content = rawContent;
    // 如果开启了 UI 层 think 过滤，则 adapter 不过滤
    if (!this.config.modelConfig?.config.uiThinkFilter) {
      // 🎯 过滤 <think>...</think> 标签（与流式请求保持一致）
      content = this.filterThinkTags(rawContent);
    }

    // 在 createNonStreamingFinalResponse 中会记录 usage
    return this.createNonStreamingFinalResponse(
      content,
      toolCalls, 
      data.usage, 
      request, 
      reasoningDetails
    );
  }

  async *requestStreamingPost(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): AsyncGenerator<GenerateContentResponse> {
    const systemInstruction = request.config?.systemInstruction as string;
    const tools = request.config?.tools;

    // 构建OpenAI格式的消息
    const messages = this.convertToOpenAIMessages(
      Array.isArray(request.contents) ? request.contents : [request.contents],
      systemInstruction,
    );

    // 如果存在工具，在最前面追加一条系统提示，严格约束返回的工具调用格式
    // if (tools && this.hasTools(tools)) {
    //   messages.unshift({
    //     role: 'system',
    //     content:
    //       "Tool calling policy: If and only if a provided tool is needed to fulfill the request, respond with tool_calls entries where each tool_calls[i].function.name exactly matches one of the provided tool names and tool_calls[i].function.arguments is a valid JSON object matching that tool's schema. Do not invent names. Do not omit the name.",
    //   });
    // }

    // 动态计算max_tokens
    const maxTokens = this.calculateMaxTokens(request);

    // 构建请求体
    const requestBody: any = {
      prompt_id: userPromptId,
      model: request.model || this.config.modelConfig?.config.model || 'gpt-4',
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream_options: {
        include_usage: true
      },
      reasoning_split: !!this.config.modelConfig?.config.reasoningSplit
    };

    // 在请求体中添加userId
    const userId = this.resolveUserId(sysConfig);
    if (userId) {
      requestBody.user = userId;
    }

    // 添加工具定义
    if (tools && this.hasTools(tools)) {
      requestBody.tools = this.convertToolsToOpenAIFormat(tools);
      requestBody.tool_choice = 'auto';
      // Reduce partial/parallel tool-call flakiness in some models
      requestBody.parallel_tool_calls = true;
    }

    const url = this.getCompletionsUrl();
    const startTime = Date.now()
    const fullUrl = url.startsWith('http')? url : (this.apiHost ? `${this.apiHost}${url}` : url);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.organization
        ? { 'OpenAI-Organization': this.config.organization }
        : {}),
      ...(this.config.project
        ? { 'OpenAI-Project': this.config.project }
        : {}),
      ...this.config.headers,
    };
    if (userId) {
      headers['x-user-id'] = userId;
    }

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 🎯 只上报首次 API 响应（错误情况）
      if (!this.reportedPromptIds.has(userPromptId as string) && sysConfig) {
        this.reportedPromptIds.add(userPromptId as string);
        const modelName = sysConfig.getCustomData<string>("modelName") || request.model || this.config.modelConfig?.config.model || 'gpt-4';
        const authType = sysConfig.getContentGeneratorConfig()?.authType;
        logApiResponse(sysConfig, new ApiResponseEvent(
          modelName,
          Date.now() - startTime,
          userPromptId as string,
          authType,
          undefined,
          undefined,
          `${response.status} ${response.statusText} - ${errorText}`
        ))
      }
      throw new Error(
        `${response.status} ${response.statusText} - ${errorText}`,
      );
    } else {
      // 🎯 只上报首次 API 响应（成功情况）
      if (!this.reportedPromptIds.has(userPromptId as string) && sysConfig) {
        this.reportedPromptIds.add(userPromptId as string);
        const modelName = sysConfig.getCustomData<string>("modelName") || request.model || this.config.modelConfig?.config.model || 'gpt-4';
        const authType = sysConfig.getContentGeneratorConfig()?.authType;
        logApiResponse(sysConfig, new ApiResponseEvent(
          modelName,
          Date.now() - startTime,
          userPromptId as string,
          authType,
        ))
      }
    }

    const fullContent = '';
    const accumulatedToolCalls: OpenAIToolCall[] = [];
    const accumulatedReasoningDetails: any = null; // 🎯 累积 reasoning_details

    yield* this.parseStreamResponse(
      response,
      fullContent,
      accumulatedToolCalls,
      request,
      accumulatedReasoningDetails,
    );
  }

  private async *parseStreamResponse(
    response: Response,
    fullContent: string,
    accumulatedToolCalls: OpenAIToolCall[],
    request: GenerateContentParameters,
    accumulatedReasoningDetails: any = null, // 🎯 新增参数
  ): AsyncGenerator<GenerateContentResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let buffer = '';
    const state = this.initReasoningState();
    let lastUsage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
      };
      completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
      };
    } | undefined;
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!this.config.modelConfig?.config.uiThinkFilter) {
            const out = this.popVisible(state);
            if (out) {
              fullContent += out;
              yield this.createStreamingResponse(out, false);
            }
          }
          
          // 在 createStreamingFinalResponse 中会记录 usage
          yield this.createStreamingFinalResponse(
            accumulatedToolCalls,
            lastUsage && lastUsage.prompt_tokens !== undefined && lastUsage.completion_tokens !== undefined && lastUsage.total_tokens !== undefined
              ? {
                  prompt_tokens: lastUsage.prompt_tokens,
                  completion_tokens: lastUsage.completion_tokens,
                  total_tokens: lastUsage.total_tokens,
                  prompt_tokens_details: lastUsage.prompt_tokens_details,
                  completion_tokens_details: lastUsage.completion_tokens_details,
                }
              : undefined,
            request,
            fullContent,
            accumulatedReasoningDetails // 🎯 传递累积的 reasoning_details
          );
          // break
          return
        };

        buffer += new TextDecoder().decode(value);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (
            trimmedLine.startsWith('data:') ||
            trimmedLine.startsWith('data: ')
          ) {
            const subLength = trimmedLine.startsWith('data:') ? 5 : 6;
            const data = trimmedLine.substring(subLength);

            // ✅ [DONE] 标记：OpenAI SSE 协议表示流结束，跳过此行
            if (data === '[DONE]' || data === ' [DONE]') {
              continue;
            }

            // 仅捕获 JSON 解析失败；真实的 API 错误事件需要抛出到上层以终止流程并在 UI 呈现
            let parsed: OpenAIResponse & { error?: { message?: string; type?: string; code?: string | number } };
            try {
              parsed = JSON.parse(data);
            } catch (parseError) {
              console.warn('Failed to parse OpenAI streaming response:', parseError);
              continue;
            }

            if (parsed && (parsed as any).error) {
              const err = (parsed as any).error || {};
              const code = err.code || err.type;
              const message = err.message || 'Unknown error';
              const composedMessage =
                `[OpenAI stream error]` +
                (code ? ` ${String(code)}` : '') +
                `: ${String(message)}`;
              const thrown: any = new Error(composedMessage);
              thrown.code = code;
              thrown.details = err;
              console.error('OpenAI streaming error event:', err);
              throw thrown;
            }

            const choice = parsed.choices?.[0];

            // 🎯 提取 usage 信息（OpenAI 流式响应在最后一个chunk中包含usage）
            if (parsed.usage) {
              lastUsage = parsed.usage;
            }

            // 注意：finish_reason 只是表示当前生成结束的原因，不影响流式处理
            // 真正的流结束由 [DONE] 标记决定
            
            if (choice?.delta) {
              const { content, tool_calls, reasoning_details } = choice.delta;

              // 处理内容（统一用状态机）
              if (content) {
                if (this.config.modelConfig?.config.uiThinkFilter) {
                  // 直接传递原始内容（think交由UI侧过滤）
                  fullContent += content;
                  yield this.createStreamingResponse(content, false);
                } else {
                  this.processReasoningChunk(state, content);
                  const out2 = this.popVisible(state);
                  if (out2) {
                    fullContent += out2;
                    yield this.createStreamingResponse(out2, false);
                  }
                }
              }

              // 处理工具调用（渐进式累积）
              if (tool_calls) {
                this.mergeToolCalls(accumulatedToolCalls, tool_calls);
              }

              // 🎯 处理 reasoning_details（渐进式累积）
              if (reasoning_details) {
                accumulatedReasoningDetails = this.mergeReasoningDetails(
                  accumulatedReasoningDetails,
                  reasoning_details
                );
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private createStreamingResponse(
    content: string,
    isThink: boolean,
  ): GenerateContentResponse {
    return {
      candidates: [
        {
          content: {
            parts: [{ text: content, thought: isThink }],
            role: 'model',
          },
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
        toolUsePromptTokenCount: 0,
      },
      text: content,
    } as GenerateContentResponse;
  }

  private createNonStreamingFinalResponse(
    fullContent: string,
    toolCalls: OpenAIToolCall[],
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
      };
      completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
      };
    },
    request?: GenerateContentParameters,
    reasoningDetails?: any, // 🎯 新增参数
  ): GenerateContentResponse {
    const functionCalls =
      toolCalls.length > 0
        ? this.convertOpenAIToolCallsToGemini(toolCalls)
        : undefined;

    const parts: any[] = [];
    if (fullContent) {
      parts.push({ text: fullContent });
    }
    if (functionCalls && functionCalls.length > 0) {
      for (const fc of functionCalls) {
        parts.push({
          functionCall: {
            name: fc.name,
            args: fc.args || {},
            id: fc.id,
          },
        });
      }
    }

    // 使用完整的 usage 数据，严格遵循 OpenAI API 官方接口定义
    // OpenAI API 直接提供的字段：
    // - prompt_tokens, completion_tokens, total_tokens (基础字段，必需)
    // - prompt_tokens_details.cached_tokens (缓存 tokens，可选)
    // - completion_tokens_details.reasoning_tokens (推理 tokens，用于 reasoning 模型，可选)
    // 需要估算的字段（API 不提供）：
    // - toolUsePromptTokenCount: 工具定义在 prompt 中占用的 token 数（从工具定义中估算）
    const estimatedToolUsePromptTokens = this.estimateToolUsePromptTokens(request);
    const usageMetadata = usage ? {
      promptTokenCount: usage.prompt_tokens, // ✅ API 提供
      candidatesTokenCount: usage.completion_tokens, // ✅ API 提供
      totalTokenCount: usage.total_tokens, // ✅ API 提供
      cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens ?? 0, // ✅ API 提供（可选）
      thoughtsTokenCount: usage.completion_tokens_details?.reasoning_tokens ?? 0, // ✅ API 提供（可选，仅 reasoning 模型）
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ API 不提供，从工具定义估算
    } : {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: 0,
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ 即使没有 usage，也尝试估算工具 tokens
    };

    // 🎯 记录实际的token使用情况（如果有 usage 和 request）
    if (usage && request) {
      // 构造完整的 contents（包含 model 回复）
      const requestContents = Array.isArray(request.contents) ? request.contents : [request.contents]
      // 检查是否为checkNextSpeaker请求
      const lastUserMessage = requestContents.length && requestContents.slice(-1)[0]
      // @ts-expect-error parts 可能为空
      const isNextSpeakerCheck = lastUserMessage?.parts[0]?.text?.includes(
        'Analyze *only* the content and structure of your immediately preceding response',
      );
      // 如果不是checkNextSpeaker请求，则记录
      if (!isNextSpeakerCheck) {
        const modelResponse: any = {
          role: 'model',
          parts
        };
        // 🎯 如果需要保留 reasoning_details，添加到 modelResponse
        if (reasoningDetails) {
          modelResponse.reasoning_details = reasoningDetails;
        }
        const completeContents = [...requestContents, modelResponse];
        const contentHash = hashRequestContent(completeContents);
        
        const usageInfo: TokenUsageInfo = {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          timestamp: Date.now(),
          contentHash,
        };
        this.usageTracker.recordUsage(usageInfo);
        
      }
    }

    // 🎯 构造返回的 content，包含 reasoning_details
    const responseContent: any = {
      parts,
      role: 'model',
    };
    // 🎯 如果有 reasoning_details，添加到返回的 content 中
    if (reasoningDetails) {
      responseContent.reasoning_details = reasoningDetails;
    }

    return {
      candidates: [
        {
          content: responseContent,
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
      usageMetadata,
      text: fullContent,
      functionCalls,
    } as GenerateContentResponse;
  }

  private createStreamingFinalResponse(
    toolCalls: OpenAIToolCall[],
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
      };
      completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
      };
    },
    request?: GenerateContentParameters,
    fullContent?: string,
    reasoningDetails?: any, // 🎯 新增参数
  ): GenerateContentResponse {
    const functionCalls =
      toolCalls.length > 0
        ? this.convertOpenAIToolCallsToGemini(toolCalls)
        : undefined;

    const parts: any[] = [];
    let isLastPartAppend = false;

    // 然后添加工具调用（如果有）
    if (functionCalls && functionCalls.length > 0) {
      for (const fc of functionCalls) {
        parts.push({
          functionCall: {
            name: fc.name,
            args: fc.args || {},
            id: fc.id,
          },
        });
      }
    } else {
      // 如果既没有文本也没有工具调用，补一个最小有效分片
      parts.push({ text: ' ', thought: true });
      isLastPartAppend = true
    }

    // 使用完整的 usage 数据，严格遵循 OpenAI API 官方接口定义
    // OpenAI API 直接提供的字段：
    // - prompt_tokens, completion_tokens, total_tokens (基础字段，必需)
    // - prompt_tokens_details.cached_tokens (缓存 tokens，可选)
    // - completion_tokens_details.reasoning_tokens (推理 tokens，用于 reasoning 模型，可选)
    // 需要估算的字段（API 不提供）：
    // - toolUsePromptTokenCount: 工具定义在 prompt 中占用的 token 数（从工具定义中估算）
    const estimatedToolUsePromptTokens = this.estimateToolUsePromptTokens(request);
    const usageMetadata = usage ? {
      promptTokenCount: usage.prompt_tokens, // ✅ API 提供
      candidatesTokenCount: usage.completion_tokens, // ✅ API 提供
      totalTokenCount: usage.total_tokens, // ✅ API 提供
      cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens ?? 0, // ✅ API 提供（可选）
      thoughtsTokenCount: usage.completion_tokens_details?.reasoning_tokens ?? 0, // ✅ API 提供（可选，仅 reasoning 模型）
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ API 不提供，从工具定义估算
    } : {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: 0,
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ 即使没有 usage，也尝试估算工具 tokens
    };

    // 🎯 记录实际的token使用情况（如果有 usage 和 request）
    if (usage && request) {
      // 构造完整的 contents（包含 model 回复）
      const requestContents = Array.isArray(request.contents) ? request.contents : [request.contents];
      // 记录Token时，要把补充的 thought: true 空白分片去掉，以免影响后续新对话
      const defaultParts = isLastPartAppend ? parts.slice(0, -1) : parts
      const modelResponse: any = {
        role: 'model',
        parts: [
        { text: fullContent || ' ', thought: false}, 
        ...defaultParts]
      };
      // 🎯 如果需要保留 reasoning_details，添加到 modelResponse
      if (reasoningDetails) {
        modelResponse.reasoning_details = reasoningDetails;
      }
      const completeContents = [...requestContents, modelResponse];
      const contentHash = hashRequestContent(completeContents);
      
      const usageInfo: TokenUsageInfo = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        timestamp: Date.now(),
        contentHash,
      };
      this.usageTracker.recordUsage(usageInfo);
    }

    // 🎯 构造返回的 content，包含 reasoning_details
    const responseContent: any = {
      parts,
      role: 'model',
    };
    // 🎯 如果有 reasoning_details，添加到返回的 content 中
    if (reasoningDetails) {
      responseContent.reasoning_details = reasoningDetails;
    }

    return {
      candidates: [
        {
          content: responseContent,
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
      usageMetadata,
      text: ' ',
      functionCalls,
    } as GenerateContentResponse;
  }


  private mergeToolCalls(
    accumulated: OpenAIToolCall[],
    newToolCalls: OpenAIToolCall[],
  ): void {
    /**
     * 处理流式工具调用的渐进式块：
     * 
     * 典型流程：
     * 1. 起始块：可能只包含 id 和 index，function.name 和 arguments 为空
     *    例如：{ id: "call_123", index: 0, function: { name: "", arguments: "" } }
     * 
     * 2. 中间块：逐步提供 name 和 arguments 的 JSON 片段
     *    例如：{ index: 0, function: { name: "search", arguments: '{"qu' } }
     *          { index: 0, function: { arguments: 'ery": "' } }
     *          { index: 0, function: { arguments: 'test"}' } }
     * 
     * 3. 最终：通过 index 关联所有块，拼接完整的 arguments JSON 字符串
     * 
     * 关键点：
     * - 使用 index 作为主要关联标识（id 可能在后续块中才提供）
     * - name 可能在后续块中才提供（起始块可能为空）
     * - arguments 需要逐块累积拼接成完整的 JSON 字符串
     */
    for (const raw of newToolCalls as Array<
      OpenAIToolCall & { index?: number }
    >) {
      const incomingIndex =
        typeof raw.index === 'number' ? raw.index : undefined;
      const incomingId = raw.id;

      // 查找已存在的工具调用（优先用 id，其次用 index）
      let existing: (OpenAIToolCall & { index?: number }) | undefined;
      if (incomingId) {
        existing = accumulated.find((c) => c.id === incomingId) as
          | (OpenAIToolCall & { index?: number })
          | undefined;
      }
      if (!existing && incomingIndex !== undefined) {
        existing = (
          accumulated as Array<OpenAIToolCall & { index?: number }>
        ).find((c) => c.index === incomingIndex);
      }

      if (!existing) {
        // 创建新的工具调用占位符（起始块）
        const created: OpenAIToolCall & { index?: number } = {
          id: incomingId || `call_${Date.now()}_${accumulated.length}`,
          type: 'function',
          function: {
            name: raw.function?.name || '',
            arguments: raw.function?.arguments || '',
          },
          index: incomingIndex,
        };
        (accumulated as Array<OpenAIToolCall & { index?: number }>).push(
          created,
        );
        existing = created;
      } else {
        // 更新后续块中提供的字段
        
        // 1. 更新 id（如果起始块未提供）
        if (!existing.id && incomingId) {
          existing.id = incomingId;
        }
        
        // 2. 更新 name（如果起始块为空，后续块才提供）
        if (raw.function?.name && !existing.function.name) {
          existing.function.name = raw.function.name;
        }
        
        // 3. 累积拼接 arguments JSON 片段（渐进式）
        if (raw.function?.arguments) {
          existing.function.arguments =
            (existing.function.arguments || '') + raw.function.arguments;
        }
      }
    }
  }

  /**
   * 合并流式 reasoning_details
   * 🎯 处理流式响应中的 reasoning_details 渐进式块
   * 
   * 策略：深度合并对象，拼接数组和字符串
   * @param accumulated 已累积的 reasoning_details
   * @param incoming 新到达的 reasoning_details 片段
   * @returns 合并后的 reasoning_details
   */
  private mergeReasoningDetails(accumulated: any, incoming: any): any {
    // 如果没有累积值，直接返回新值
    if (!accumulated) return incoming;
    if (!incoming) return accumulated;

    // 如果都是数组，合并数组
    if (Array.isArray(accumulated) && Array.isArray(incoming)) {
      // 处理空数组情况
      if (accumulated.length === 0) return incoming;
      if (incoming.length === 0) return accumulated;

      const accumulatedObj = accumulated[0]
      const incomingObj = incoming[0]
      if (accumulatedObj && incomingObj) {
        accumulatedObj.text = (accumulatedObj.text || '') + (incomingObj.text || '');
      }
      return accumulated;
    }

    // 其他情况，新值覆盖旧值
    return incoming;
  }

  private convertToOpenAIMessages(
    contents: any[],
    systemInstruction?: string,
  ): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    // 添加系统消息
    if (systemInstruction) {
      messages.push({
        role: 'system',
        content: systemInstruction,
      });
    }

    // 转换对话消息
    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : content.role;
      const parts = content.parts || [];
      const reasoningDetails = content.reasoning_details; // 🎯 提取 reasoning_details

      // 先处理包含函数调用的情况：将其映射为 assistant.tool_calls
      const functionCallParts = parts
        .map((p: any) => p.functionCall)
        .filter(Boolean);
      if (functionCallParts.length > 0) {
        const toolCalls: OpenAIToolCall[] = functionCallParts.map(
          (fc: any, idx: number) => ({
            id: fc.id || `call_${Date.now()}_${idx}`,
            type: 'function',
            function: {
              name: fc.name || '',
              arguments: JSON.stringify(fc.args ?? {}),
            },
          }),
        );

        const textContent = parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('');

        const message: OpenAIMessage = {
          role,
          content: textContent || '',
          tool_calls: toolCalls,
        };
        // 🎯 如果有 reasoning_details，添加到消息中
        if (reasoningDetails) {
          message.reasoning_details = reasoningDetails;
        }
        messages.push(message);

        continue;
      }

      // 处理文本、图片和工具响应（统一处理，支持并行工具调用）
      const contentArray: any[] = [];
      const toolResponses: any[] = [];
      
      for (const part of parts) {
        if (part.text) {
          contentArray.push({ type: 'text', text: part.text });
        } else if (part.inlineData) {
          // 图片内容
          const mimeType = part.inlineData.mimeType;
          const data = part.inlineData.data;
          contentArray.push({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${data}` },
          });
        } else if (part.functionResponse) {
          // 🎯 收集所有工具响应（支持并行工具调用）
          toolResponses.push(part.functionResponse);
        }
      }

      // 如果有文本或图片内容，添加到消息列表
      if (contentArray.length > 0) {
        const message: OpenAIMessage = {
          role,
          content:
            contentArray.length === 1 && contentArray[0].type === 'text'
              ? contentArray[0].text
              : contentArray,
        };
        // 🎯 如果有 reasoning_details，添加到消息中
        if (reasoningDetails) {
          message.reasoning_details = reasoningDetails;
        }
        messages.push(message);
      }
      
      // 🎯 处理所有工具响应（支持串行和并行工具调用）
      for (const toolResponse of toolResponses) {
        messages.push({
          role: 'tool',
          tool_call_id: toolResponse.id || '',
          content: toolResponse.response?.output || toolResponse.response?.error || '',
        });
      }
    }

    return messages;
  }

  private convertToolsToOpenAIFormat(tools: ToolListUnion): OpenAITool[] {
    const openaiTools: OpenAITool[] = [];

    for (const tool of tools) {
      if ('functionDeclarations' in tool && tool.functionDeclarations) {
        for (const func of tool.functionDeclarations) {
          openaiTools.push({
            type: 'function',
            function: {
              name: func.name || '',
              description: func.description,
              parameters: func.parametersJsonSchema || {
                type: 'object',
                properties: {},
              },
            },
          });
        }
      }
    }

    return openaiTools;
  }

  private convertOpenAIToolCallsToGemini(
    toolCalls: OpenAIToolCall[],
  ): FunctionCall[] {
    return toolCalls.map((toolCall) => {
      let args: any = {};
      let parseFailed = false;

      try {
        if (toolCall.function.arguments) {
          args = JSON.parse(toolCall.function.arguments);
        }
      } catch (error) {
        console.error(error);
        console.warn(
          'Failed to parse OpenAI tool call arguments:',
          toolCall.function.arguments,
        );
        // Keep the original string value when parse fails
        args = toolCall.function.arguments;
        parseFailed = true;
      }

      // Normalize args to ensure it's always a valid object
      // This prevents API errors when sending back to the API
      // If args is not an object (e.g., string, array, null), wrap it
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        const originalType = Array.isArray(args) ? 'array' : typeof args;
        args = {
          _invalid_params_type: originalType,
          _invalid_params_value: args,
          _error_message: `Tool parameters must be an object, but received ${originalType}. The value has been wrapped in this object to prevent API errors.`,
          _parse_failed: parseFailed,
        };
      }

      return {
        name: toolCall.function.name,
        args: args as Record<string, any>,
        id: toolCall.id,
      } as FunctionCall;
    });
  }

  private hasTools(tools: ToolListUnion): boolean {
    return tools.some(
      (tool) =>
        'functionDeclarations' in tool &&
        tool.functionDeclarations &&
        tool.functionDeclarations.length > 0,
    );
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    if (!this.config.modelConfig) {
      return {}
    }

    // 🎯 优化1：检查是否可以使用缓存的实际token数（完全匹配）
    const contentHash = hashRequestContent(request.contents);
    const cachedTokens = this.usageTracker.getCachedTokensByContentHash(contentHash, true);
    
    if (cachedTokens !== null) {
      console.log(`🎯 [OpenAI] countTokens: 使用缓存的实际值 ${cachedTokens} tokens`);
      return {
        totalTokens: cachedTokens
      };
    }

    // 🎯 优化2：增量计算 - 历史messages的实际值 + 最新message的估算
    // 说明：recordUsage 记录的是完整对话 [user, model, user, model]（包含 model 回复）
    // 当 countTokens 收到 [user, model, user, model, user] 时：
    //   - 查找 [user, model, user, model] 的实际 promptTokens（已记录）
    //   - 估算最后一条 user 的 token 数
    //   - 返回：历史实际值 + 最新估算值
    const contents = Array.isArray(request.contents) ? request.contents : [request.contents];
    
    if (contents.length > 1) {
      const lastMessage = contents[contents.length - 1];
      const lastRole = (lastMessage as any)?.role;
      
      // 如果最后一条是 user，说明是新的用户输入
      // 尝试查找去掉最后一条 user 的历史记录（应该以 model 结尾）
      if (lastRole === 'user') {
        const historyContents = contents.slice(0, -1);
        const historicalTokens = this.usageTracker.getHistoricalTokens(historyContents);
        
        if (historicalTokens !== null) {
          // 🎯 只估算最新一条 user message 的token数
          // 注意：不包含 systemInstruction 和 tools，因为历史实际值中已经包含了
          const latestMessageRequest = {
            model: request.model,
            contents: lastMessage,
            // ❌ 不携带 config，避免重复计算 system 和 tools
            // config: request.config
          } as GenerateContentParameters;
          const latestTokens = TokenCalculator.estimateInputTokensOnly(
            this.config.modelConfig,
            latestMessageRequest
          );
          
          // 增量计算：历史实际值（含system+tools） + 最新估算值（仅message）
          const incrementalEstimate = historicalTokens + latestTokens;
          console.log(
            `🎯 [OpenAI] countTokens: 增量计算 ${historicalTokens}(历史实际，含system+tools) + ${latestTokens}(最新user，仅message) = ${incrementalEstimate} tokens`
          );
          
          return {
            totalTokens: incrementalEstimate
          };
        }
      }
    }

    // 🎯 优化3：使用估算 + 校正系数（备用方案）
    // 获取估算准确度报告
    const accuracyReport = this.usageTracker.getAccuracyReport();
    
    // 使用轻量级方法仅估算输入token数（避免不必要的max_tokens计算）
    let estimatedTokens = TokenCalculator.estimateInputTokensOnly(
      this.config.modelConfig, 
      request
    );
    
    // 如果有足够的样本且可靠，使用校正系数
    if (accuracyReport.isReliable) {
      const correctionFactor = accuracyReport.correctionFactor;
      const originalEstimate = estimatedTokens;
      estimatedTokens = Math.round(estimatedTokens * correctionFactor);
      console.log(
        `🎯 [OpenAI] countTokens: 估算校正 ${originalEstimate} → ${estimatedTokens} ` +
        `(factor: ${correctionFactor.toFixed(3)}, samples: ${accuracyReport.samples}, ` +
        `error: ${accuracyReport.averageError.toFixed(2)}%)`
      );
    } else {
      console.log(
        `🎯 [OpenAI] countTokens: 使用未校正的估算值 ${estimatedTokens} tokens ` +
        `(samples: ${accuracyReport.samples}, 需要 ≥10 且误差 <15%)`
      );
    }

    return {
      totalTokens: estimatedTokens
    };
  }

  /**
   * 获取Usage追踪器（用于外部访问统计信息）
   */
  getUsageTracker(): UsageTracker {
    return this.usageTracker;
  }

  async embedContent(
    _req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw Error('Embedding not supported');
  }

  private extractTextFromRequest(request: CountTokensParameters): string {
    const contents = (request.contents as Content[]) || [];
    return contents
      .map((content) => this.extractTextFromParts(content.parts || []))
      .join(' ');
  }

  private extractTextFromParts(parts: Part[]): string {
    return parts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join(' ');
  }
}

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
import { UsageTracker, TokenUsageInfo, hashRequestContent} from './usage-tracker.js';

/**
 * Anthropic API配置
 */
export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  apiHost?: string;
  timeout?: number;
  modelConfig?: ModelConfig;
  // 新增userId，用于token限流等
  userId?: string;
}

/**
 * Anthropic消息格式
 */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

/**
 * Anthropic内容格式
 */
interface AnthropicContent {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: any;
  content?: string;
  tool_use_id?: string;
}

/**
 * Anthropic工具定义格式
 */
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: any;
}

/**
 * Anthropic API响应格式
 */
interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContent[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Anthropic流式响应格式
 */
interface _AnthropicStreamEvent {
  type:
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop';
  message?: AnthropicResponse;
  content_block?: AnthropicContent;
  delta?: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
  index?: number;
}

/**
 * Anthropic 适配器
 * 将Anthropic Claude API适配为ContentGenerator接口，支持工具调用和流式响应
 */
export class AnthropicAdapter implements ContentGenerator {
  private config: AnthropicConfig;
  /**
   * 🎯 追踪已上报过 api_response 事件的 prompt_id
   * 确保每个用户会话只上报首次 API 响应
   */
  private readonly reportedPromptIds: Set<string> = new Set();
  private usageTracker: UsageTracker;
  // API Host (用于前缀baseUrl)
  private readonly apiHost: string;
  private readonly DEFAULT_INPUT_TOKENS = 10000;

  constructor(config: AnthropicConfig) {
    this.config = {
      baseUrl: 'https://api.anthropic.com/v1',
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
      
      // 根据 Anthropic API 的特性计算 tokens
      // Anthropic: 中文约1字符/token，英文约4字符/token，其他约2字符/token
      let totalTokens = Math.ceil(chineseChars / 1) + 
                       Math.ceil(englishChars / 4) + 
                       Math.ceil(otherChars / 2);
      
      // 对于中英文混合内容，Anthropic的token消耗有额外开销
      if (chineseChars > 0 && englishChars > 0) {
        const mixedContentPenalty = Math.ceil((chineseChars + englishChars) * 0.15); // 15%的混合内容惩罚
        totalTokens += mixedContentPenalty;
      }
      
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

  /**
   * 估算思考内容（thoughts）占用的 token 数
   * 通过检测内容中的 <think> 标签或 reasoning_details 来估算
   */
  private estimateThoughtsTokens(fullContent?: string, reasoningDetails?: any): number {
    if (!fullContent && !reasoningDetails) {
      return 0;
    }

    let thoughtsText = '';

    // 从 reasoning_details 中提取思考内容
    if (reasoningDetails) {
      try {
        if (typeof reasoningDetails === 'string') {
          thoughtsText += reasoningDetails;
        } else if (typeof reasoningDetails === 'object') {
          // 尝试提取常见的 reasoning 字段
          if (reasoningDetails.thinking || reasoningDetails.reasoning) {
            thoughtsText += JSON.stringify(reasoningDetails.thinking || reasoningDetails.reasoning);
          } else {
            // 序列化整个对象
            thoughtsText += JSON.stringify(reasoningDetails);
          }
        }
      } catch (error) {
        console.warn('Failed to extract thoughts from reasoning_details:', error);
      }
    }

    // 从 fullContent 中提取 <think> 标签内容
    if (fullContent) {
      const thinkTagRegex = /<think>([\s\S]*?)<\/think>/gi;
      const matches = fullContent.matchAll(thinkTagRegex);
      for (const match of matches) {
        if (match[1]) {
          thoughtsText += match[1];
        }
      }
    }

    if (!thoughtsText) {
      return 0;
    }

    // 估算 token 数（使用与 TokenCalculator 类似的逻辑，考虑 Anthropic API 特性）
    const CHINESE_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
    const ENGLISH_WORD_REGEX = /[a-zA-Z]+/g;
    const chineseMatches = thoughtsText.match(CHINESE_CHAR_REGEX) || [];
    const englishMatches = thoughtsText.match(ENGLISH_WORD_REGEX) || [];
    const chineseChars = chineseMatches.length;
    const englishChars = englishMatches.join('').length;
    const totalLength = thoughtsText.length;
    const otherChars = totalLength - chineseChars - englishChars;
    
    // 根据 Anthropic API 的特性计算 tokens
    // Anthropic: 中文约1字符/token，英文约4字符/token，其他约2字符/token
    let totalTokens = Math.ceil(chineseChars / 1) + 
                     Math.ceil(englishChars / 4) + 
                     Math.ceil(otherChars / 2);
    
    // 对于中英文混合内容，Anthropic的token消耗有额外开销
    if (chineseChars > 0 && englishChars > 0) {
      const mixedContentPenalty = Math.ceil((chineseChars + englishChars) * 0.15); // 15%的混合内容惩罚
      totalTokens += mixedContentPenalty;
    }
    
    return Math.max(totalTokens, 1); // 确保至少1个token
  }

  private getMessagesEndpointUrl(): string {
    // Default Anthropic Messages streaming endpoint
    // If baseUrl already points to /v1/messages, use as-is; otherwise append
    const base = this.config.baseUrl || 'https://api.anthropic.com/v1/messages';
    return base;
  }

  /**
   * 动态计算max_tokens值
   * 🎯 优化：使用增量计算 - 历史messages的实际token数 + 最新message的估算
   */
  private calculateMaxTokens(request: GenerateContentParameters): number {
    if (!this.config.modelConfig) {
      console.warn('AnthropicAdapter: 缺少模型配置，使用默认max_tokens值');
      return this.DEFAULT_INPUT_TOKENS; // 默认值
    }

    // 🎯 优化：尝试使用增量计算
    const contents = Array.isArray(request.contents) ? request.contents : [request.contents];
    let estimatedInputTokens: number;
    
    if (contents.length > 1) {
      const lastMessage = contents[contents.length - 1];
      const lastRole = (lastMessage as any)?.role;
      
      // 如果最后一条是 user，尝试增量计算
      if (lastRole === 'user') {
        const historyContents = contents.slice(0, -1);
        const historicalTokens = this.usageTracker.getHistoricalTokens(historyContents);
        
        if (historicalTokens !== null) {
          // 只估算最新一条 user message 的token数
          const latestMessageRequest = {
            model: request.model,
            contents: lastMessage,
            config: {
              systemInstruction: request.config?.systemInstruction,
              tools: request.config?.tools
            }
          } as GenerateContentParameters;
          const latestTokens = TokenCalculator.estimateInputTokensOnly(
            this.config.modelConfig,
            latestMessageRequest
          );
          
          // 增量计算：历史实际值 + 最新估算值
          estimatedInputTokens = historicalTokens + latestTokens;
          console.log(
            `🎯 [Anthropic] calculateMaxTokens: 增量计算 ${historicalTokens}(历史实际) + ${latestTokens}(最新估算) = ${estimatedInputTokens} tokens`
          );
        } else {
          // 回退到完整估算
          estimatedInputTokens = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
          console.log(`AnthropicAdapter: 完整估算输入=${estimatedInputTokens} tokens`);
        }
      } else {
        // 不是 user message，使用完整估算
        estimatedInputTokens = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
        console.log(`AnthropicAdapter: 完整估算输入=${estimatedInputTokens} tokens`);
      }
    } else {
      // 单条消息，直接估算
      estimatedInputTokens = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
      console.log(`AnthropicAdapter: 单条消息估算输入=${estimatedInputTokens} tokens`);
    }

    // 使用估算的输入token数计算max_tokens
    const result = TokenCalculator.computeMaxTokensFromEstimatedInput(
      this.config.modelConfig,
      estimatedInputTokens
    );

    if (result.warnings && result.warnings.length > 0) {
      console.warn('AnthropicAdapter token计算警告:', result.warnings);
    }

    if (!result.isWithinLimits) {
      console.warn('AnthropicAdapter: 请求可能超出模型token限制');
    }

    console.log(`AnthropicAdapter: 动态计算max_tokens=${result.maxTokens}`);

    return result.maxTokens;
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): Promise<GenerateContentResponse> {
    // Note: non-streaming calls may not have sysConfig; userId fallback can still come from adapter config/env.
    return this.requestPost(request, userPromptId, sysConfig);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    sysConfig?: Config,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.requestStreamingPost(request, userPromptId, sysConfig);
  }

  async requestPost(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): Promise<GenerateContentResponse> {
    const systemInstruction = request.config?.systemInstruction;
    const tools = request.config?.tools;

    // 构建Anthropic格式的消息
    const messages = this.convertToAnthropicMessages(
      Array.isArray(request.contents) ? request.contents : [request.contents],
    );

    // 动态计算max_tokens
    const maxTokens = this.calculateMaxTokens(request);

    // 构建请求体（非流式）
    const requestBody: any = {
      prompt_id: userPromptId,
      model: request.model || 'claude-3-5-sonnet-latest',
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      stop_sequences: [],
      top_k: 10
    };

    // 在请求体中添加userId
    const userId = this.resolveUserId(sysConfig);
    if (userId) {
      requestBody.userId = userId;
    }

    if (systemInstruction) {
      requestBody.system = systemInstruction;
    }

    if (request?.config?.responseJsonSchema) {
      requestBody.output_format = {
        type: 'json_schema',
        json_schema: request?.config?.responseJsonSchema
      }
    }

    if (tools && this.hasTools(tools)) {
      requestBody.tools = this.convertToolsToAnthropicFormat(tools);
      requestBody.tool_choice = { type: 'auto' };
    }

    const url = this.getMessagesEndpointUrl();
    const fullUrl = url.startsWith('http')? url : (this.apiHost ? `${this.apiHost}${url}` : url);
    const hasTools = !!requestBody.tools && requestBody.tools.length > 0;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2025-01-01',
      ...(hasTools ? { 'anthropic-beta': 'tools-2025-01-01' } : {}),
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
        `Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    const contentBlocks = data.content || [];

    let fullContent = '';
    const toolUses: AnthropicContent[] = [];
    for (const block of contentBlocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        fullContent += block.text;
      }
      if (block.type === 'tool_use') {
        toolUses.push(block);
      }
    }

    // 在 createNonStreamingFinalResponse 中会记录 usage
    return this.createNonStreamingFinalResponse(fullContent, toolUses, data.usage, request)
  }

  async *requestStreamingPost(
    request: GenerateContentParameters,
    userPromptId?: string,
    sysConfig?: Config,
  ): AsyncGenerator<GenerateContentResponse> {
    const systemInstruction = request.config?.systemInstruction;
    const tools = request.config?.tools;

    // 构建Anthropic格式的消息
    const messages = this.convertToAnthropicMessages(
      Array.isArray(request.contents) ? request.contents : [request.contents],
    );

    // 动态计算max_tokens
    const maxTokens = this.calculateMaxTokens(request);

    // 构建请求体（流式）
    const requestBody: any = {
      prompt_id: userPromptId,
      model: request.model || 'claude-3-5-sonnet-latest',
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature: 0.7,
      stop_sequences: [],
      top_k: 10
    };

    // 在请求体中添加userId
    const userId = this.resolveUserId(sysConfig);
    if (userId) {
      requestBody.userId = userId;
    }

    // 添加系统消息
    if (systemInstruction) {
      requestBody.system = systemInstruction;
    }

    // 添加工具定义
    if (tools && this.hasTools(tools)) {
      requestBody.tools = this.convertToolsToAnthropicFormat(tools);
      requestBody.tool_choice = {
        type: 'auto',
      };
    }

    const url = this.getMessagesEndpointUrl();
    const fullUrl = url.startsWith('http')? url : (this.apiHost ? `${this.apiHost}${url}` : url);
    const hasTools = !!requestBody.tools && requestBody.tools.length > 0;
    const startTime = Date.now()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      ...(hasTools ? { 'anthropic-beta': 'tools-2024-04-04' } : {}),
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
        const modelName = sysConfig.getCustomData<string>("modelName") || request.model || 'claude-3-5-sonnet-latest';
        const authType = sysConfig.getContentGeneratorConfig()?.authType;
        logApiResponse(sysConfig, new ApiResponseEvent(
          modelName,
          Date.now() - startTime,
          userPromptId as string,
          authType,
          undefined,
          undefined,
          `Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`
        ))
      }
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    } else {
      // 🎯 只上报首次 API 响应（成功情况）
      if (!this.reportedPromptIds.has(userPromptId as string) && sysConfig) {
        this.reportedPromptIds.add(userPromptId as string);
        const modelName = sysConfig.getCustomData<string>("modelName") || request.model || 'claude-3-5-sonnet-latest';
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
    const accumulatedToolUses: AnthropicContent[] = [];

    yield* this.parseStreamResponse(response, fullContent, accumulatedToolUses, request);
  }

  private async *parseStreamResponse(
    response: Response,
    fullContent: string,
    accumulatedToolUses: AnthropicContent[],
    request: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let buffer = '';
    let currentEvent: string | null = null;
    // 🎯 Anthropic API 流式请求的实际 Token 消耗统计
    // 优先使用 message_stop chunk 中的 amazon-bedrock-invocationMetrics
    let bedrockMetrics:
      | { inputTokenCount?: number; outputTokenCount?: number; invocationLatency?: number; firstByteLatency?: number }
      | undefined;
    // 备用：标准 Anthropic usage（如果 bedrockMetrics 不可用）
    let lastUsage:
      | { 
          input_tokens?: number; 
          output_tokens?: number; 
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        }
      | undefined;
    // Map Anthropic content_block index -> index in accumulatedToolUses
    const toolUseIndexMap = new Map<number, number>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break
        };

        buffer += new TextDecoder().decode(value);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (trimmedLine.startsWith('event:')) {
            currentEvent = trimmedLine.substring(6).trim();
            continue;
          }

          if (trimmedLine.startsWith('data:')) {
            const data = trimmedLine.substring(5).trim();

            // 仅捕获 JSON 解析失败；真实的 SSE 错误事件需要抛出到上层
            let payload: any;
            try {
              payload = JSON.parse(data);
            } catch (parseError) {
              console.warn(
                'Failed to parse Anthropic streaming response:',
                parseError,
              );
              // 跳过无法解析的 data 行
              continue;
            }

            const eventType =
              currentEvent || (payload?.type as string | undefined) || '';

            switch (eventType) {
              case 'message_start': {
                // message_start: begin of an assistant message
                break;
              }
              case 'content_block_start': {
                const contentBlock = payload.content_block as
                  | AnthropicContent
                  | undefined;
                const blockIndex: number | undefined = payload.index;
                if (contentBlock?.type === 'tool_use') {
                  const newToolUseArrayIndex = accumulatedToolUses.length;
                  accumulatedToolUses.push(contentBlock);
                  if (typeof blockIndex === 'number') {
                    toolUseIndexMap.set(blockIndex, newToolUseArrayIndex);
                  }
                }
                break;
              }
              case 'content_block_delta': {
                const idx: number | undefined = payload.index;
                const delta = payload.delta || {};
                if (
                  delta.type === 'text_delta' &&
                  typeof delta.text === 'string'
                ) {
                  fullContent += delta.text;
                  yield this.createStreamingResponse(delta.text);
                }
                if (
                  delta.type === 'input_json_delta' &&
                  typeof delta.partial_json === 'string' &&
                  idx !== undefined
                ) {
                  const mappedIndex = toolUseIndexMap.has(idx)
                    ? toolUseIndexMap.get(idx)!
                    : idx;
                  this.updateToolUseJson(
                    accumulatedToolUses,
                    mappedIndex,
                    delta.partial_json,
                  );
                }
                break;
              }
              case 'content_block_stop': {
                // 块结束，无需处理
                break;
              }
              case 'message_delta': {
                // 更新 usage 信息作为备用（仅在 bedrockMetrics 不可用时使用）
                if (payload.usage && typeof payload.usage === 'object') {
                  lastUsage = {
                    input_tokens: payload.usage.input_tokens,
                    output_tokens: payload.usage.output_tokens,
                    cache_read_input_tokens: payload.usage.cache_read_input_tokens,
                    cache_creation_input_tokens: payload.usage.cache_creation_input_tokens,
                  };
                }
                break;
              }
              case 'message_stop': {
                // 🎯 提取 message_stop chunk 中的 amazon-bedrock-invocationMetrics
                // 格式: { inputTokenCount, outputTokenCount, invocationLatency, firstByteLatency }
                if (payload['amazon-bedrock-invocationMetrics']) {
                  bedrockMetrics = payload['amazon-bedrock-invocationMetrics'];
                }
                
                // 🎯 优先使用 amazon-bedrock-invocationMetrics 进行实际 Token 消耗统计
                let finalInputTokens: number | undefined;
                let finalOutputTokens: number | undefined;
                let finalCachedReadTokens: number | undefined;
                let finalCachedCreationTokens: number | undefined;
                
                if (bedrockMetrics && bedrockMetrics.inputTokenCount !== undefined && bedrockMetrics.outputTokenCount !== undefined) {
                  // 使用 Bedrock metrics（优先）
                  finalInputTokens = bedrockMetrics.inputTokenCount;
                  finalOutputTokens = bedrockMetrics.outputTokenCount;
                  // Bedrock metrics 没有 cache 相关字段，从 lastUsage 获取（如果有）
                  finalCachedReadTokens = lastUsage?.cache_read_input_tokens;
                  finalCachedCreationTokens = lastUsage?.cache_creation_input_tokens;
                } else if (lastUsage && lastUsage.input_tokens !== undefined && lastUsage.output_tokens !== undefined) {
                  // 备用：使用标准 Anthropic usage（包含所有 API 提供的字段）
                  finalInputTokens = lastUsage.input_tokens;
                  finalOutputTokens = lastUsage.output_tokens;
                  finalCachedReadTokens = lastUsage.cache_read_input_tokens;
                  finalCachedCreationTokens = lastUsage.cache_creation_input_tokens;
                } else if (payload.usage && typeof payload.usage === 'object') {
                  // 从 message_stop 事件中提取 usage（如果 lastUsage 不可用）
                  finalInputTokens = payload.usage.input_tokens;
                  finalOutputTokens = payload.usage.output_tokens;
                  finalCachedReadTokens = payload.usage.cache_read_input_tokens;
                  finalCachedCreationTokens = payload.usage.cache_creation_input_tokens;
                }
                
                // 流结束，发送最终响应（在 createStreamingFinalResponse 中会记录 usage）
                const final = this.createStreamingFinalResponse(
                  accumulatedToolUses,
                  finalInputTokens !== undefined && finalOutputTokens !== undefined
                    ? {
                        input_tokens: finalInputTokens,
                        output_tokens: finalOutputTokens,
                        cache_read_input_tokens: finalCachedReadTokens,
                        cache_creation_input_tokens: finalCachedCreationTokens,
                      }
                    : undefined,
                  request,
                  fullContent
                );
                yield final;
                return;
              }
              case 'error':
              case 'message_error': {
                // 处理流式错误事件，提取错误信息并中断流
                const err = (payload && (payload.error || payload)) || {};
                const code = err.type || err.code;
                const status = err.status || err.status_code;
                const message = err.message || err.error || 'Unknown error';
                const composedMessage =
                  `[Anthropic stream error]` +
                  (code ? ` ${String(code)}` : '') +
                  (status ? ` (status ${String(status)})` : '') +
                  `: ${String(message)}`;
                // 附带原始错误对象，便于上层记录和调试
                const thrown: any = new Error(composedMessage);
                thrown.code = code;
                thrown.status = status;
                thrown.details = err;
                console.error('Anthropic streaming error event:', err);
                throw thrown;
              }
              default: {
                // 未识别事件，忽略
                break;
              }
            }

            // data 行处理完成后重置事件名称，避免跨事件串扰
            currentEvent = null;
            continue;
          }

          // 空行表示一个事件块结束，重置事件名
          if (trimmedLine === '') {
            currentEvent = null;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private createStreamingResponse(content: string): GenerateContentResponse {
    return {
      candidates: [
        {
          content: {
            parts: [{ text: content }],
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

  private createStreamingFinalResponse(
    toolUses: AnthropicContent[],
    usage?: { 
      input_tokens: number; 
      output_tokens: number; 
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
    request?: GenerateContentParameters,
    fullContent?: string,
  ): GenerateContentResponse {
    const functionCalls =
      toolUses.length > 0
        ? this.convertAnthropicToolUsesToGemini(toolUses)
        : undefined;

    // Build model parts to ensure the model output is considered valid by history curation
    const parts: Part[] = [] as unknown as Part[];
    let isLastPartAppend = false;
    
    // 然后添加工具调用（如果有）
    if (functionCalls && functionCalls.length > 0) {
      for (const fc of functionCalls) {
        (parts as unknown as any[]).push({
          functionCall: {
            name: fc.name,
            args: fc.args ?? {},
            id: fc.id,
          },
        });
      }
    } else {
      // 如果既没有文本也没有工具调用，补一个最小有效分片
      parts.push({ text: ' ', thought: true });
      isLastPartAppend = true
    }
    
    // 使用实际的usage信息（如果有），严格遵循 Anthropic API 官方接口定义
    // Anthropic API 直接提供的字段：
    // - input_tokens, output_tokens (基础字段，必需)
    // - cache_read_input_tokens (缓存读取的 tokens，可选)
    // - cache_creation_input_tokens (缓存创建的 tokens，可选)
    // 需要估算的字段（API 不提供）：
    // - thoughtsTokenCount: 思考内容占用的 token 数（从响应内容中检测并估算）
    // - toolUsePromptTokenCount: 工具定义在 prompt 中占用的 token 数（从工具定义中估算）
    const estimatedThoughtsTokens = this.estimateThoughtsTokens(fullContent);
    const estimatedToolUsePromptTokens = this.estimateToolUsePromptTokens(request);
    
    // 合并 cache_read_input_tokens 和 cache_creation_input_tokens（如果存在）
    const totalCachedTokens = usage 
      ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      : 0;
    
    const usageMetadata = usage ? {
      promptTokenCount: usage.input_tokens, // ✅ API 提供
      candidatesTokenCount: usage.output_tokens, // ✅ API 提供
      totalTokenCount: usage.input_tokens + usage.output_tokens, // ✅ 计算得出
      cachedContentTokenCount: totalCachedTokens, // ✅ API 提供（可选字段合并）
      thoughtsTokenCount: estimatedThoughtsTokens, // ⚠️ API 不提供，从内容中检测并估算
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ API 不提供，从工具定义估算
    } : {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: estimatedThoughtsTokens, // ⚠️ 即使没有 usage，也尝试估算思考 tokens
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ 即使没有 usage，也尝试估算工具 tokens
    };

    // 🎯 记录实际的token使用情况（如果有 usage 和 request）
    if (usage && request) {
      // 构造完整的 contents（包含 model 回复）
      const requestContents = Array.isArray(request.contents) ? request.contents : [request.contents];
      // 记录Token时，要把补充的 thought: true 空白分片去掉，以免影响后续新对话
      const defaultParts = isLastPartAppend ? parts.slice(0, -1) : parts
      const modelResponse = {
        role: 'model',
        parts: [
        { text: fullContent || ' '}, 
        ...defaultParts]
      };
      const completeContents = [...requestContents, modelResponse];
      const contentHash = hashRequestContent(completeContents);
      
      const usageInfo: TokenUsageInfo = {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
        cachedTokens: usage.cache_read_input_tokens,
        timestamp: Date.now(),
        contentHash,
      };
      this.usageTracker.recordUsage(usageInfo);
      
    }

    return {
      candidates: [
        {
          content: {
            parts,
            role: 'model',
          },
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
      usageMetadata,
      text: ' ',
      functionCalls,
    } as unknown as GenerateContentResponse;
  }

  private createNonStreamingFinalResponse(
    fullContent: string,
    toolUses: AnthropicContent[],
    usage?: { 
      input_tokens: number; 
      output_tokens: number; 
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
    request?: GenerateContentParameters,
  ): GenerateContentResponse {
    const functionCalls =
      toolUses.length > 0
        ? this.convertAnthropicToolUsesToGemini(toolUses)
        : undefined;

    // Build model parts to ensure the model output is considered valid by history curation
    const parts: Part[] = [] as unknown as Part[];
    if (fullContent && fullContent.length > 0) {
      (parts as unknown as any[]).push({ text: fullContent });
    }

    if (functionCalls && functionCalls.length > 0) {
      for (const fc of functionCalls) {
        (parts as unknown as any[]).push({
          functionCall: {
            name: fc.name,
            args: fc.args ?? {},
            id: fc.id,
          },
        });
      }
    }

    // 使用实际的usage信息（如果有），严格遵循 Anthropic API 官方接口定义
    // Anthropic API 直接提供的字段：
    // - input_tokens, output_tokens (基础字段，必需)
    // - cache_read_input_tokens (缓存读取的 tokens，可选)
    // - cache_creation_input_tokens (缓存创建的 tokens，可选)
    // 需要估算的字段（API 不提供）：
    // - thoughtsTokenCount: 思考内容占用的 token 数（从响应内容中检测并估算）
    // - toolUsePromptTokenCount: 工具定义在 prompt 中占用的 token 数（从工具定义中估算）
    const estimatedThoughtsTokens = this.estimateThoughtsTokens(fullContent);
    const estimatedToolUsePromptTokens = this.estimateToolUsePromptTokens(request);
    
    // 合并 cache_read_input_tokens 和 cache_creation_input_tokens（如果存在）
    const totalCachedTokens = usage 
      ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      : 0;
    
    const usageMetadata = usage ? {
      promptTokenCount: usage.input_tokens, // ✅ API 提供
      candidatesTokenCount: usage.output_tokens, // ✅ API 提供
      totalTokenCount: usage.input_tokens + usage.output_tokens, // ✅ 计算得出
      cachedContentTokenCount: totalCachedTokens, // ✅ API 提供（可选字段合并）
      thoughtsTokenCount: estimatedThoughtsTokens, // ⚠️ API 不提供，从内容中检测并估算
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ API 不提供，从工具定义估算
    } : {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: estimatedThoughtsTokens, // ⚠️ 即使没有 usage，也尝试估算思考 tokens
      toolUsePromptTokenCount: estimatedToolUsePromptTokens, // ⚠️ 即使没有 usage，也尝试估算工具 tokens
    };

    // 🎯 记录实际的token使用情况（如果有 usage 和 request）
    if (usage && request) {
      // 构造完整的 contents（包含 model 回复）
      const requestContents = Array.isArray(request.contents) ? request.contents : [request.contents];
      // 检查是否为checkNextSpeaker请求
      const lastUserMessage = requestContents.length && requestContents.slice(-1)[0]
      // @ts-expect-error parts 可能为空
      const isNextSpeakerCheck = lastUserMessage?.parts[0]?.text?.includes(
        'Analyze *only* the content and structure of your immediately preceding response',
      );
      if (!isNextSpeakerCheck) {
        const modelResponse = {
          role: 'model',
          parts
        };
        const completeContents = [...requestContents, modelResponse];
        const contentHash = hashRequestContent(completeContents);
        
        const usageInfo: TokenUsageInfo = {
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
          totalTokens: usage.input_tokens + usage.output_tokens,
          cachedTokens: usage.cache_read_input_tokens,
          timestamp: Date.now(),
          contentHash,
        };
        this.usageTracker.recordUsage(usageInfo);
        
        // 🎯 记录估算准确度（使用轻量级估算方法，避免重复计算）
        if (this.config.modelConfig) {
          const estimated = TokenCalculator.estimateInputTokensOnly(this.config.modelConfig, request);
          this.usageTracker.recordEstimationAccuracy(estimated, usage.input_tokens);
        }
      }
    }

    return {
      candidates: [
        {
          content: {
            parts,
            role: 'model',
          },
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
      usageMetadata,
      text: fullContent,
      functionCalls,
    } as unknown as GenerateContentResponse;
  }

  private updateToolUseJson(
    toolUses: AnthropicContent[],
    index: number,
    partialJson: string,
  ): void {
    if (index < 0) return;
    // Ensure array slot exists if Anthropic sends deltas before start event processed
    if (!toolUses[index]) {
      toolUses[index] = {
        type: 'tool_use',
        id: `tool_${Date.now()}_${index}`,
        name: '',
        input: '',
      } as AnthropicContent;
    }
    if (toolUses[index].type !== 'tool_use') return;

    const existing =
      typeof toolUses[index].input === 'string' ? toolUses[index].input : '';
    toolUses[index].input = existing + partialJson;
  }

  /**
   * Removes orphaned tool_use blocks from the conversation history.
   * 
   * Anthropic API requires that every assistant message containing tool_use
   * must be immediately followed by a user message containing the corresponding
   * tool_result. This method filters out any model turns with functionCall
   * that don't have a matching functionResponse in the next turn.
   * 
   * @param contents - The conversation history in Gemini format
   * @returns Cleaned conversation history safe for Anthropic API
   */
  private removeOrphanedToolUses(contents: any[]): any[] {
    const result: any[] = [];
    
    for (let i = 0; i < contents.length; i++) {
      const current = contents[i];
      
      // Check if this is a model turn with functionCall (will become tool_use)
      const hasFunctionCall = 
        current.role === 'model' &&
        current.parts?.some((p: any) => p.functionCall);
      
      if (hasFunctionCall) {
        // Look ahead to see if the next turn contains matching functionResponse
        const next = contents[i + 1];
        const hasMatchingResponse = 
          next?.role === 'user' &&
          next?.parts?.some((p: any) => p.functionResponse);
        
        if (!hasMatchingResponse) {
          // Orphaned tool_use detected - skip this turn
          console.warn(
            `[Anthropic Adapter] Skipping orphaned functionCall at index ${i}. ` +
            `Anthropic API requires tool_use to be immediately followed by tool_result.`
          );
          continue;
        }
      }
      
      result.push(current);
    }
    
    return result;
  }

  private convertToAnthropicMessages(contents: any[]): AnthropicMessage[] {
    // Clean up orphaned tool_use blocks that don't have matching tool_result
    const cleanedContents = this.removeOrphanedToolUses(contents);
    
    const messages: AnthropicMessage[] = [];

    for (const content of cleanedContents) {
      // 跳过系统消息，因为Anthropic在请求体中单独处理系统消息
      if (content.role === 'system') continue;

      const role = content.role === 'model' ? 'assistant' : content.role;
      const parts = content.parts || [];

      // 统一构建为内容块数组，符合Anthropic消息格式要求
      const contentArray: AnthropicContent[] = [];

      for (const part of parts) {
        if (part.text) {
          contentArray.push({
            type: 'text',
            text: part.text,
          });
        } else if (part.inlineData) {
          // 图片内容
          contentArray.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data,
            },
          });
        } else if (part.functionCall) {
          // 工具调用
          contentArray.push({
            type: 'tool_use',
            id: part.functionCall.id || `tool_${Date.now()}`,
            name: part.functionCall.name,
            input: part.functionCall.args,
          });
        } else if (part.functionResponse) {
          // 工具响应 -> Anthropic 要作为 role=user 的消息提交
          // 在 user 分支中进行实际转换
        }
      }

      // 如果没有任何part（极少见），保持空数组，避免发送字符串
      // 注意：Anthropic 规范要求 tool_result 出现在 role=user 的消息里
      // 因此当本条是 user 且 parts 含有 functionResponse 时需要转成 tool_result
      if (content.role === 'user') {
        const toolResultParts: AnthropicContent[] = [];
        for (const part of parts) {
          if ((part as any).functionResponse) {
            const resp = (part as any).functionResponse.response;
            let resultText = '';
            if (typeof resp === 'string') {
              resultText = resp;
            } else if (resp && typeof resp.output === 'string') {
              resultText = resp.output;
            } else if (resp && typeof resp.error === 'string') {
              resultText = resp.error;
            } else if (resp && Array.isArray(resp.content)) {
              try {
                resultText = (resp.content as any[])
                  .map((p) => (typeof p?.text === 'string' ? p.text : ''))
                  .join('');
              } catch {
                resultText = '';
              }
            } else if (resp != null) {
              try {
                resultText = JSON.stringify(resp);
              } catch {
                resultText = String(resp);
              }
            }
            toolResultParts.push({
              type: 'tool_result',
              tool_use_id: (part as any).functionResponse.id || '',
              content: resultText,
            });
          }
        }
        const merged = [...contentArray, ...toolResultParts];
         // ✅ 防御性检查：如果 content 为空，添加占位符
        if (merged.length === 0) {
          console.warn('Empty user message detected, adding placeholder');
          merged.push({
            type: 'text',
            text: '[Empty user message placeholder]', // 或其他合适的占位符
          });
        }
        messages.push({ role: 'user', content: merged });
      } else {
         // ✅ 对 model 消息也添加检查
        if (contentArray.length === 0) {
          console.warn('Empty model message detected, adding placeholder');
          contentArray.push({
            type: 'text',
            text: '[Empty model message placeholder]',
          })
        }
        messages.push({ role, content: contentArray });
      }
    }

    return messages;
  }

  private convertToolsToAnthropicFormat(tools: ToolListUnion): AnthropicTool[] {
    const anthropicTools: AnthropicTool[] = [];

    for (const tool of tools) {
      if ('functionDeclarations' in tool && tool.functionDeclarations) {
        for (const func of tool.functionDeclarations) {
          anthropicTools.push({
            name: func.name || '',
            description: func.description,
            input_schema: func.parametersJsonSchema || {
              type: 'object',
              properties: {},
            },
          });
        }
      }
    }

    return anthropicTools;
  }

  private convertAnthropicToolUsesToGemini(
    toolUses: AnthropicContent[],
  ): FunctionCall[] {
    return toolUses
      .filter((content) => content.type === 'tool_use')
      .map((toolUse) => {
        let args: any = toolUse.input ?? {};
        let parseFailed = false;

        try {
          if (typeof toolUse.input === 'string') {
            args = JSON.parse(toolUse.input);
          } else if (toolUse.input !== undefined && toolUse.input !== null) {
            args = toolUse.input;
          }
        } catch (_error) {
          console.warn(
            'Failed to parse Anthropic tool use input:',
            toolUse.input,
          );
          // Keep the original string value when parse fails
          args = toolUse.input;
          parseFailed = true;
        }

        // Normalize args to ensure it's always a valid object
        // This prevents Anthropic API errors when sending back to the API
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
          name: toolUse.name || '',
          args: args as Record<string, any>,
          id: toolUse.id || `tool_${Date.now()}`,
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
      console.log(`🎯 [Anthropic] countTokens: 使用缓存的实际值 ${cachedTokens} tokens`);
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
          // 只估算最新一条 user message 的token数
          const latestMessageRequest = {
            model: request.model,
            contents: lastMessage,
            config: request.config
          } as GenerateContentParameters;
          const latestTokens = TokenCalculator.estimateInputTokensOnly(
            this.config.modelConfig,
            latestMessageRequest
          );
          
          // 增量计算：历史实际值 + 最新估算值
          const incrementalEstimate = historicalTokens + latestTokens;
          console.log(
            `🎯 [Anthropic] countTokens: 增量计算 ${historicalTokens}(历史实际) + ${latestTokens}(最新估算) = ${incrementalEstimate} tokens`
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
        `🎯 [Anthropic] countTokens: 估算校正 ${originalEstimate} → ${estimatedTokens} ` +
        `(factor: ${correctionFactor.toFixed(3)}, samples: ${accuracyReport.samples}, ` +
        `error: ${accuracyReport.averageError.toFixed(2)}%)`
      );
    } else {
      console.log(
        `🎯 [Anthropic] countTokens: 使用未校正的估算值 ${estimatedTokens} tokens ` +
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
    // Anthropic 不提供嵌入API，抛出错误
    throw new Error('Embedding not supported by Anthropic API');
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

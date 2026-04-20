/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponseUsageMetadata,
  GenerateContentResponse,
} from '@google/genai';
import {
  ApiRequestEvent,
  ApiResponseEvent,
  ApiErrorEvent,
} from '../telemetry/types.js';
import type { Config } from '../config/config.js';
import {
  logApiError,
  logApiRequest,
  logApiResponse,
} from '../telemetry/loggers.js';
import type { ContentGenerator } from './contentGenerator.js';
import { AuthType } from './contentGenerator.js';
import { toContents } from '../code_assist/converter.js';
import { isStructuredError } from '../utils/quotaErrorDetection.js';

interface StructuredError {
  status: number;
}

/**
 * A decorator that wraps a ContentGenerator to add logging to API calls.
 */
export class LoggingContentGenerator implements ContentGenerator {
  /**
   * 追踪已经上报过 api_response 事件的 prompt_id
   * 确保每个用户会话只上报首次 API 响应
   */
  private readonly reportedPromptIds: Set<string> = new Set();

  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly config: Config,
  ) {}

  getWrapped(): ContentGenerator {
    return this.wrapped;
  }

  private logApiRequest(
    contents: Content[],
    model: string,
    promptId: string,
  ): void {
    const requestText = JSON.stringify(contents);
    logApiRequest(
      this.config,
      new ApiRequestEvent(model, promptId, requestText),
    );
  }

  private _logApiResponse(
    durationMs: number,
    prompt_id: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
  ): void {
    // 只上报首次 API 响应，确保发起会话总数 >= 响应会话总数
    if (this.reportedPromptIds.has(prompt_id)) {
      return;
    }
    
    this.reportedPromptIds.add(prompt_id);
    
    const event = new ApiResponseEvent(
      this.config.getModel(),
      durationMs,
      prompt_id,
      this.config.getContentGeneratorConfig()?.authType,
      usageMetadata,
      responseText,
    );
    logApiResponse(this.config, event);
  }

  private buildUsageMetadata(
    usageMetadata: GenerateContentResponseUsageMetadata | undefined,
    request: GenerateContentParameters | undefined,
    response: GenerateContentResponse | undefined,
  ): GenerateContentResponseUsageMetadata | undefined {
    // 只使用真实数据，如果没有或全0，返回 undefined（让 ApiResponseEvent 处理为0）
    if (usageMetadata) {
      return usageMetadata;
    }
    
    return undefined;
  }

  private _logApiError(
    durationMs: number,
    error: unknown,
    prompt_id: string,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof Error ? error.name : 'unknown';

    logApiError(
      this.config,
      new ApiErrorEvent(
        this.config.getModel(),
        errorMessage,
        durationMs,
        prompt_id,
        this.config.getContentGeneratorConfig()?.authType,
        errorType,
        isStructuredError(error)
          ? (error as StructuredError).status
          : undefined,
      ),
    ); // 数据埋点 异常上报
  }

  async generateContent(
    req: GenerateContentParameters,
    userPromptId: string,
    sysConfig?: Config,
  ): Promise<GenerateContentResponse> {
    const startTime = Date.now();
    this.logApiRequest(toContents(req.contents), req.model, userPromptId);
    try {
      const response = await this.wrapped.generateContent(req, userPromptId, sysConfig);
      const durationMs = Date.now() - startTime;
      const usageMetadata = this.buildUsageMetadata(
        response.usageMetadata,
        req,
        response,
      );
      this._logApiResponse(
        durationMs,
        userPromptId,
        usageMetadata,
        JSON.stringify(response),
      );
      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(durationMs, error, userPromptId);
      throw error;
    }
  }

  async generateContentStream(
    req: GenerateContentParameters,
    userPromptId: string,
    sysConfig?: Config,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const startTime = Date.now();
    this.logApiRequest(toContents(req.contents), req.model, userPromptId);

    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.wrapped.generateContentStream(req, userPromptId, sysConfig);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(durationMs, error, userPromptId);
      throw error;
    }

    return this.loggingStreamWrapper(stream, startTime, userPromptId, req);
  }

  private async *loggingStreamWrapper(
    stream: AsyncGenerator<GenerateContentResponse>,
    startTime: number,
    userPromptId: string,
    request: GenerateContentParameters,
  ): AsyncGenerator<GenerateContentResponse> {
    let lastResponse: GenerateContentResponse | undefined;
    const responses: GenerateContentResponse[] = [];
    let accumulatedText = '';

    let lastUsageMetadata: GenerateContentResponseUsageMetadata | undefined;
    try {
      for await (const response of stream) {
        responses.push(response);
        lastResponse = response;
        if (response.usageMetadata) {
          lastUsageMetadata = response.usageMetadata;
        }
        // 累积所有文本内容
        if (response.text) {
          accumulatedText += response.text;
        } else if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part && typeof part === 'object' && 'text' in part && part.text) {
              accumulatedText += String(part.text);
            }
          }
        }
        yield response;
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(durationMs, error, userPromptId);
      throw error;
    }
    const durationMs = Date.now() - startTime;
    if (lastResponse) {
      // 构建一个包含完整内容的 response 对象用于估算
      const completeResponse = {
        ...lastResponse,
        text: accumulatedText || lastResponse.text || '',
      } as GenerateContentResponse;
      const usageMetadata = this.buildUsageMetadata(
        lastUsageMetadata,
        request,
        completeResponse,
      );
      this._logApiResponse(
        durationMs,
        userPromptId,
        usageMetadata,
        JSON.stringify(responses),
      );
    }
  }

  async countTokens(req: CountTokensParameters): Promise<CountTokensResponse> {
    return this.wrapped.countTokens(req);
  }

  async embedContent(
    req: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.wrapped.embedContent(req);
  }
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
} from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { Config } from '../config/config.js';

import { UserTierId } from '../code_assist/types.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { InstallationManager } from '../utils/installationManager.js';
import { AdapterFactory } from '../llm/adapter-factory.js';
import { ConfigBridge } from '../config/configBridge.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    sysConfig?: Config,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    sysConfig?: Config,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  userTier?: UserTierId;
}

export enum AuthType {
  LOGIN_WITH_GOOGLE = 'oauth-personal',
  USE_GEMINI = 'gemini-api-key',
  USE_VERTEX_AI = 'vertex-ai',
  CLOUD_SHELL = 'cloud-shell',
  USE_OPENAI = 'openai',
  USE_ANTHROPIC = 'anthropic',
}

export type ContentGeneratorConfig = {
  model: string;
  apiKey?: string;
  vertexai?: boolean;
  authType?: AuthType | undefined;
  proxy?: string | undefined;
};

export function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
): ContentGeneratorConfig {
  const geminiApiKey = process.env['GEMINI_API_KEY'] || undefined;
  const googleApiKey = process.env['GOOGLE_API_KEY'] || undefined;
  const googleCloudProject = process.env['GOOGLE_CLOUD_PROJECT'] || undefined;
  const googleCloudLocation = process.env['GOOGLE_CLOUD_LOCATION'] || undefined;

  // Use runtime model from config if available; otherwise, fall back to parameter or default
  const effectiveModel = config.getModel() || process.env['DEFAULT_MODEL'] || config.getModelConfig()!.config.model;

  const contentGeneratorConfig: ContentGeneratorConfig = {
    model: effectiveModel,
    authType,
    proxy: config?.getProxy(),
  };

  // If we are using Google auth or we are in Cloud Shell, there is nothing else to validate for now
  if (
    authType === AuthType.LOGIN_WITH_GOOGLE ||
    authType === AuthType.CLOUD_SHELL
  ) {
    return contentGeneratorConfig;
  }

  if (authType === AuthType.USE_GEMINI && geminiApiKey) {
    contentGeneratorConfig.apiKey = geminiApiKey;
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  if (
    authType === AuthType.USE_VERTEX_AI &&
    (googleApiKey || (googleCloudProject && googleCloudLocation))
  ) {
    contentGeneratorConfig.apiKey = googleApiKey;
    contentGeneratorConfig.vertexai = true;

    return contentGeneratorConfig;
  }

  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  const version = process.env['CLI_VERSION'] || process.version;
  const userAgent = `GeminiCLI/${version} (${process.platform}; ${process.arch})`;
  const baseHeaders: Record<string, string> = {
    'User-Agent': userAgent,
  };

  if (
    config.authType === AuthType.LOGIN_WITH_GOOGLE ||
    config.authType === AuthType.CLOUD_SHELL
  ) {
    const httpOptions = { headers: baseHeaders };
    return new LoggingContentGenerator(
      await createCodeAssistContentGenerator(
        httpOptions,
        config.authType,
        gcConfig,
        sessionId,
      ),
      gcConfig,
    );
  }

  if (
    config.authType === AuthType.USE_GEMINI ||
    config.authType === AuthType.USE_VERTEX_AI
  ) {
    let headers: Record<string, string> = { ...baseHeaders };
    if (gcConfig?.getUsageStatisticsEnabled()) {
      const installationManager = new InstallationManager();
      const installationId = installationManager.getInstallationId();
      headers = {
        ...headers,
        'x-gemini-api-privileged-user-id': `${installationId}`,
      };
    }
    const httpOptions = { headers };

    const googleGenAI = new GoogleGenAI({
      apiKey: config.apiKey === '' ? undefined : config.apiKey,
      vertexai: config.vertexai,
      httpOptions,
    });
    return new LoggingContentGenerator(googleGenAI.models, gcConfig);
  }

  // 优先使用完整的ModelConfig创建适配器
  if (
    config.authType === AuthType.USE_OPENAI ||
    config.authType === AuthType.USE_ANTHROPIC
  ) {
    try {
      // 优先级1: 检查是否有完整的ModelConfig
      const modelConfig = gcConfig.getModelConfig();
      if (modelConfig) {
        // 验证ModelConfig
        const validation = ConfigBridge.validateModelConfig(modelConfig);
        if (validation.warnings.length > 0) {
          console.warn('ModelConfig验证警告:', validation.warnings);
        }

        // 使用完整的ModelConfig创建适配器，并用 LoggingContentGenerator 包装
        const adapter = AdapterFactory.createAdapter(modelConfig, undefined, gcConfig.getApiHost());
        return new LoggingContentGenerator(adapter, gcConfig);
      }
      process.exit(1);

      // 优先级2: 回退到环境变量方式
      console.log('⚙️ 回退到环境变量方式创建适配器');
      const authTypeString = config.authType === AuthType.USE_OPENAI ? 'openai' :
                            config.authType === AuthType.USE_ANTHROPIC ? 'anthropic' :
                            'openai';

      const adapter = AdapterFactory.createAdapter(
        authTypeString,
        config.model,
        gcConfig.getApiHost()
      );
      return new LoggingContentGenerator(adapter, gcConfig);
    } catch (error) {
      // 如果AdapterFactory失败，回退到原有逻辑
      console.warn('AdapterFactory创建失败，回退到原有逻辑:', error);

      if (config.authType === AuthType.USE_OPENAI) {
        if (!process.env['OPENAI_API_KEY']) {
          throw new Error(
            'OPENAI_API_KEY environment variable is required for OpenAI authentication',
          );
        }

        const { OpenAIAdapter } = await import('../llm/openai-adapter.js');
        const openaiConfig = {
          apiKey: process.env['OPENAI_API_KEY'],
          baseUrl: process.env['OPENAI_BASE_URL'],
          apiHost: gcConfig.getApiHost(),
          organization: process.env['OPENAI_ORGANIZATION'],
          project: process.env['OPENAI_PROJECT'],
        };
        const adapter = new OpenAIAdapter(openaiConfig);
        return new LoggingContentGenerator(adapter, gcConfig);
      }

      if (config.authType === AuthType.USE_ANTHROPIC) {
        const KEY = process.env['V_ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'];
        const BASE_URL = process.env['V_ANTHROPIC_BASE_URL'] || process.env['ANTHROPIC_BASE_URL'];

        if (!BASE_URL) {
          throw new Error(
            'V_ANTHROPIC_BASE_URL or ANTHROPIC_BASE_URL environment variable is required for Anthropic authentication',
          );
        }

        const { AnthropicAdapter } = await import('../llm/anthropic-adapter.js');
        const anthropicConfig = {
          apiKey: KEY || '',
          baseUrl: BASE_URL,
          apiHost: gcConfig.getApiHost(),
          // 传入userId
          userId: gcConfig.getCustomData<string>('userId'),
        };
        const adapter = new AnthropicAdapter(anthropicConfig);
        return new LoggingContentGenerator(adapter, gcConfig);
      }
    }
  }

  throw new Error(
    `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
  );
}

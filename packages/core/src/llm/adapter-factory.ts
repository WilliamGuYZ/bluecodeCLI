/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ContentGenerator } from '../core/contentGenerator.js';
import { AnthropicAdapter, AnthropicConfig } from './anthropic-adapter.js';
import { OpenAIAdapter, OpenAIConfig } from './openai-adapter.js';
import { ModelConfig } from './token-calculator.js';
import { getModelTokenConfig } from './model-token-configs.js';

/**
 * Adapter工厂类
 * 负责创建配置了token计算功能的adapter实例
 */
export class AdapterFactory {
  /**
   * 创建Anthropic adapter
   */
  static createAnthropicAdapter(
    apiKey: string,
    modelConfig: ModelConfig,
    baseUrl?: string,
    apiHost?: string,
  ): ContentGenerator {
    const config: AnthropicConfig = {
      apiKey,
      baseUrl,
      apiHost,
      modelConfig // 传入模型配置以启用动态token计算
    };

    return new AnthropicAdapter(config);
  }

  /**
   * 创建OpenAI adapter
   */
  static createOpenAIAdapter(
    apiKey: string,
    modelConfig: ModelConfig,
    baseUrl?: string,
    apiHost?: string,
  ): ContentGenerator {
    const config: OpenAIConfig = {
      apiKey,
      baseUrl,
      apiHost,
      modelConfig // 传入模型配置以启用动态token计算
    };

    return new OpenAIAdapter(config);
  }

  /**
   * 创建适配器的主入口
   * 支持两种使用方式：
   * 1. 传入ModelConfig对象
   * 2. 传入authType字符串和model名称
   */
  static createAdapter(
    configOrAuthType: ModelConfig | string,
    apiKeyOrModel?: string,
    apiHost?: string,
  ): ContentGenerator {
    // 如果第一个参数是ModelConfig，直接使用
    if (typeof configOrAuthType === 'object') {
      return this.createAdapterFromModelConfig(
        configOrAuthType, 
        apiKeyOrModel || this.getApiKeyForAuthType(configOrAuthType.authType),
        apiHost,
      );
    }

    // 如果第一个参数是字符串，从环境变量创建ModelConfig
    const authType = configOrAuthType;
    const model = apiKeyOrModel;

    const modelConfig = this.createModelConfigFromEnv(authType, model);
    const apiKey = this.getApiKeyForAuthType(authType);

    return this.createAdapterFromModelConfig(modelConfig, apiKey, apiHost);
  }

  /**
   * 从ModelConfig创建适配器（内部方法）
   */
  private static createAdapterFromModelConfig(
    modelConfig: ModelConfig, 
    apiKey: string,
    apiHost?: string,
  ): ContentGenerator {
    switch (modelConfig.authType) {
      case 'anthropic':
        return this.createAnthropicAdapter(apiKey, modelConfig, modelConfig.config.baseUrl, apiHost);
      
      case 'openai':
        return this.createOpenAIAdapter(
          apiKey, 
          modelConfig, 
          modelConfig.config.baseUrl,
          apiHost,
        );
      
      default:
        throw new Error(`不支持的认证类型: ${modelConfig.authType}`);
    }
  }

  /**
   * 创建基于环境变量的ModelConfig
   * 会尝试从预定义配置中获取token信息
   */
  private static createModelConfigFromEnv(
    authType: string,
    model?: string
  ): ModelConfig {
    // 获取环境变量
    const { apiKey, baseUrl, defaultModel } = this.getEnvConfigForAuthType(authType);
    const finalModel = model || defaultModel;
    // 尝试从预定义配置获取token信息
    const tokenConfig = getModelTokenConfig(finalModel);
    
    const modelConfig: ModelConfig = {
      id: `${authType}-env-${finalModel}`,
      name: `${finalModel} (from environment)`,
      authType,
      config: {
        model: finalModel,
        baseUrl,
        apiKey
      }
    };

    // 如果找到预定义配置，添加token信息
    if (tokenConfig) {
      modelConfig.contextWindowTokenSize = tokenConfig.contextWindowTokenSize;
      modelConfig.maxOutputTokenSize = tokenConfig.maxOutputTokenSize;
      modelConfig.maxInputTokenSize = tokenConfig.maxInputTokenSize;
    }

    return modelConfig;
  }

  /**
   * 根据认证类型获取环境变量配置
   */
  private static getEnvConfigForAuthType(authType: string): {
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
  } {
    switch (authType) {
      case 'openai': {
        const apiKey = process.env['OPENAI_API_KEY'];
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY environment variable is required for OpenAI authentication');
        }
        return {
          apiKey,
          baseUrl: process.env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1',
          defaultModel: 'gpt-4'
        };
      }

      case 'anthropic': {
        const apiKey = process.env['V_ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'];
        const baseUrl = process.env['V_ANTHROPIC_BASE_URL'] || process.env['ANTHROPIC_BASE_URL'];
        
        if (!baseUrl) {
          throw new Error('V_ANTHROPIC_BASE_URL or ANTHROPIC_BASE_URL environment variable is required for Anthropic authentication');
        }

        return {
          apiKey: apiKey || '',
          baseUrl,
          defaultModel: 'claude-3-5-sonnet-latest'
        };
      }

      default:
        throw new Error(`不支持的认证类型: ${authType}`);
    }
  }

  /**
   * 从ModelConfigManager创建适配器（兼容方法）
   * 内部调用统一的createAdapter方法
   */
  static createAdapterFromManager(
    modelConfigManager: any, // 避免循环依赖，使用any类型
    modelId?: string,
    workingDir?: string
  ): ContentGenerator {
    // 获取模型配置
    const modelConfig = modelId 
      ? modelConfigManager.getModelById(modelId)
      : modelConfigManager.getCurrentModel();

    if (!modelConfig) {
      throw new Error(`模型配置未找到: ${modelId || '当前模型'}`);
    }

    // 使用统一的createAdapter方法
    return this.createAdapter(modelConfig, undefined, workingDir);
  }

  /**
   * 从环境变量创建适配器（兼容方法）
   * 内部调用统一的createAdapter方法
   */
  static createAdapterFromEnv(
    authType: string,
    model?: string,
    workingDir?: string,
  ): ContentGenerator {
    // 使用统一的createAdapter方法
    return this.createAdapter(authType, model, workingDir);
  }

  /**
   * 根据认证类型获取API密钥
   */
  private static getApiKeyForAuthType(authType: string): string {
    switch (authType) {
      case 'openai': {
        const openaiKey = process.env['OPENAI_API_KEY'];
        if (!openaiKey) {
          throw new Error('OPENAI_API_KEY environment variable is required for OpenAI authentication');
        }
        return openaiKey;
      }
        
      case 'anthropic': {
        const anthropicKey = process.env['V_ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'];
        if (!anthropicKey) {
          throw new Error('V_ANTHROPIC_API_KEY environment variable is required for OpenAI authentication');
        }
        return anthropicKey;
      }
        
      default:
        throw new Error(`不支持的认证类型: ${authType}`);
    }
  }

  /**
   * 智能创建适配器（兼容方法）
   * 自动选择最佳创建方式，内部调用统一的createAdapter方法
   */
  static createAdapterSmart(
    authType: string,
    model?: string,
    workingDir?: string,
    modelConfigManager?: any,
    modelId?: string
  ): ContentGenerator {
    try {
      // 优先级1: 使用ModelConfigManager（如果可用）
      if (modelConfigManager) {
        console.log('🎯 使用ModelConfigManager创建适配器（支持完整token配置）');
        return this.createAdapterFromManager(modelConfigManager, modelId, workingDir);
      }

      // 优先级2: 从环境变量创建（包含预定义token配置）
      console.log('⚙️ 从环境变量创建适配器（使用预定义token配置）');
      return this.createAdapter(authType, model, workingDir);
      
    } catch (error) {
      console.error('智能适配器创建失败:', error);
      throw error;
    }
  }
}

/**
 * 简化的使用示例：
 * 
 * ```typescript
 * import { AdapterFactory } from './adapter-factory.js';
 * 
 * // 方式1: 使用ModelConfig对象（推荐）
 * const adapter1 = AdapterFactory.createAdapter(modelConfig);
 * 
 * // 方式2: 使用字符串参数（从环境变量）
 * const adapter2 = AdapterFactory.createAdapter('openai', 'gpt-4');
 * 
 * // 方式3: 带额外参数
 * const adapter3 = AdapterFactory.createAdapter('anthropic', 'claude-3-5-sonnet-latest', workingDir);
 * 
 * // 所有适配器都自动支持动态token计算
 * const response = await adapter.generateContent(request);
 * ```
 * 
 * 兼容方法（可选使用）：
 * ```typescript
 * // 从ModelConfigManager创建
 * const adapter = AdapterFactory.createAdapterFromManager(modelConfigManager);
 * 
 * // 智能创建（自动选择最佳方式）
 * const adapter = AdapterFactory.createAdapterSmart('openai', 'gpt-4', workingDir, modelConfigManager);
 * ```
 */
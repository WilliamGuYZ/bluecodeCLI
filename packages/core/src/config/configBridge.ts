/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 配置桥接器
 * 负责在CLI包的ModelConfig和Core包的ContentGeneratorConfig之间进行转换
 */

import { ModelConfig } from '../llm/token-calculator.js';
import { ContentGeneratorConfig, AuthType } from '../core/contentGenerator.js';

/**
 * 配置桥接器类
 */
export class ConfigBridge {
  /**
   * 将ModelConfig转换为ContentGeneratorConfig
   */
  static fromModelConfig(modelConfig: ModelConfig): ContentGeneratorConfig {
    return {
      model: modelConfig.config.model,
      apiKey: modelConfig.config.apiKey,
      authType: this.mapAuthType(modelConfig.authType),
      // 注意：这里不设置vertexai和proxy，保持现有逻辑
    };
  }

  /**
   * 将字符串认证类型映射为AuthType枚举
   */
  private static mapAuthType(authType: string): AuthType {
    switch (authType) {
      case 'openai':
        return AuthType.USE_OPENAI;
      case 'anthropic':
        return AuthType.USE_ANTHROPIC;
      case 'oauth-personal':
        return AuthType.LOGIN_WITH_GOOGLE;
      case 'gemini-api-key':
        return AuthType.USE_GEMINI;
      case 'vertex-ai':
        return AuthType.USE_VERTEX_AI;
      case 'cloud-shell':
        return AuthType.CLOUD_SHELL;
      default:
        throw new Error(`未知的认证类型: ${authType}`);
    }
  }

  /**
   * 检查ModelConfig是否包含完整的token配置
   */
  static hasCompleteTokenConfig(modelConfig: ModelConfig): boolean {
    return !!(
      modelConfig.contextWindowTokenSize &&
      modelConfig.maxOutputTokenSize &&
      modelConfig.maxInputTokenSize
    );
  }

  /**
   * 从ModelConfig提取token配置信息
   */
  static extractTokenConfig(modelConfig: ModelConfig): {
    contextWindowTokenSize?: number;
    maxOutputTokenSize?: number;
    maxInputTokenSize?: number;
  } {
    return {
      contextWindowTokenSize: modelConfig.contextWindowTokenSize,
      maxOutputTokenSize: modelConfig.maxOutputTokenSize,
      maxInputTokenSize: modelConfig.maxInputTokenSize
    };
  }

  /**
   * 验证ModelConfig的完整性
   */
  static validateModelConfig(modelConfig: ModelConfig): {
    isValid: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let isValid = true;

    // 检查基本配置
    if (!modelConfig.config?.model) {
      warnings.push('缺少模型名称');
      isValid = false;
    }

    if (!modelConfig.config?.baseUrl) {
      warnings.push('缺少API基础URL');
      isValid = false;
    }

    if (!modelConfig.authType) {
      warnings.push('缺少认证类型');
      isValid = false;
    }

    // 检查token配置（警告但不影响有效性）
    if (!this.hasCompleteTokenConfig(modelConfig)) {
      warnings.push('缺少完整的token配置，将使用预定义配置或默认值');
    }

    return { isValid, warnings };
  }

  /**
   * 创建用于日志记录的配置摘要
   */
  static createConfigSummary(modelConfig: ModelConfig): string {
    const tokenInfo = this.hasCompleteTokenConfig(modelConfig) 
      ? `token配置完整` 
      : `使用预定义配置`;
    
    return `${modelConfig.name} (${modelConfig.authType}, ${tokenInfo})`;
  }
}
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

type Model = string;
type TokenCount = number;

export const DEFAULT_TOKEN_LIMIT = 1_048_576;

/**
 * 模型配置接口（简化版，避免循环依赖）
 */
export interface ModelConfig {
  id: string;
  name: string;
  authType: string;
  config: {
    model: string;
    baseUrl: string;
    apiKey: string;
  };
  contextWindowTokenSize?: number;
  maxOutputTokenSize?: number;
  maxInputTokenSize?: number;
}

/**
 * 动态获取模型的输入token限制 (maxInputTokenSize)
 * 用于判断聊天历史是否需要压缩，优先从模型配置中获取
 * 
 * @param model 模型名称
 * @param modelConfig 可选的模型配置，如果提供则优先使用
 * @param customLimits 可选的自定义限制映射
 * @returns 模型的最大输入token限制
 */
export function tokenLimit(
  model: Model, 
  modelConfig?: ModelConfig | null,
): TokenCount {
  if (modelConfig && modelConfig.maxInputTokenSize) {
    // 从模型配置中动态获取最大输入token数
    return modelConfig.maxInputTokenSize;
  }
  
  // 5. 返回默认值（转换为输入限制）
  const defaultInputLimit = Math.floor(DEFAULT_TOKEN_LIMIT * 0.9);
  console.warn(`未知模型 "${model}"，使用默认输入token限制: ${defaultInputLimit}`);
  return defaultInputLimit;
}

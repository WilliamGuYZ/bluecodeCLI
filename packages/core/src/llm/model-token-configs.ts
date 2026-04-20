/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 常见模型的token配置信息
 * 这些配置可以作为API返回数据的参考或默认值
 */
export const MODEL_TOKEN_CONFIGS = {
  // OpenAI Models
  'gpt-4': {
    contextWindowTokenSize: 8192,
    maxOutputTokenSize: 4096,
    maxInputTokenSize: 4096
  },
  'gpt-4-turbo': {
    contextWindowTokenSize: 128000,
    maxOutputTokenSize: 4096,
    maxInputTokenSize: 123904
  },
  'gpt-4o': {
    contextWindowTokenSize: 128000,
    maxOutputTokenSize: 16384,
    maxInputTokenSize: 111616
  },
  'gpt-4o-mini': {
    contextWindowTokenSize: 128000,
    maxOutputTokenSize: 16384,
    maxInputTokenSize: 111616
  },
  'gpt-3.5-turbo': {
    contextWindowTokenSize: 16385,
    maxOutputTokenSize: 4096,
    maxInputTokenSize: 12289
  },

  // Anthropic Models
  'claude-3-5-sonnet-latest': {
    contextWindowTokenSize: 200000,
    maxOutputTokenSize: 8192,
    maxInputTokenSize: 191808
  },
  'claude-3-5-sonnet-20241022': {
    contextWindowTokenSize: 200000,
    maxOutputTokenSize: 8192,
    maxInputTokenSize: 191808
  },
  'claude-3-5-haiku-20241022': {
    contextWindowTokenSize: 200000,
    maxOutputTokenSize: 8192,
    maxInputTokenSize: 191808
  },
  'claude-3-opus-20240229': {
    contextWindowTokenSize: 200000,
    maxOutputTokenSize: 4096,
    maxInputTokenSize: 195904
  },

  // 其他模型可以继续添加...
} as const;

/**
 * 根据模型名称获取token配置
 */
export function getModelTokenConfig(modelName: string): {
  contextWindowTokenSize: number;
  maxOutputTokenSize: number;
  maxInputTokenSize: number;
} | null {
  // 精确匹配
  if (modelName in MODEL_TOKEN_CONFIGS) {
    return MODEL_TOKEN_CONFIGS[modelName as keyof typeof MODEL_TOKEN_CONFIGS];
  }

  // 模糊匹配
  const lowerModelName = modelName.toLowerCase();
  for (const [key, config] of Object.entries(MODEL_TOKEN_CONFIGS)) {
    if (lowerModelName.includes(key.toLowerCase()) || key.toLowerCase().includes(lowerModelName)) {
      return config;
    }
  }

  return null;
}

/**
 * 检查模型是否支持大上下文窗口（>32k tokens）
 */
export function isLargeContextModel(modelName: string): boolean {
  const config = getModelTokenConfig(modelName);
  return config ? config.contextWindowTokenSize > 32000 : false;
}

/**
 * 获取模型的推荐安全边距
 */
export function getRecommendedSafetyMargin(): number {
  return 1000; // 默认安全边距
}
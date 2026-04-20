/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentParameters } from '@google/genai';
import { getModelTokenConfig, getRecommendedSafetyMargin } from './model-token-configs.js';
import { UsageTracker } from './usage-tracker.js';

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
    reasoningSplit?: boolean,
    uiThinkFilter?: string
  };
  contextWindowTokenSize?: number;
  maxOutputTokenSize?: number;
  maxInputTokenSize?: number;
}

/**
 * Token计算配置
 */
export interface TokenCalculationConfig {
  contextWindowTokenSize: number;
  maxOutputTokenSize: number;
  maxInputTokenSize: number;
  // 安全边距，避免超出限制
  safetyMargin?: number;
  // 最小输出token保证
  minOutputTokens?: number;
}

/**
 * Token计算结果
 */
export interface TokenCalculationResult {
  maxTokens: number;
  estimatedInputTokens: number;
  availableOutputTokens: number;
  isWithinLimits: boolean;
  warnings?: string[];
}

/**
 * Token计算器
 * 根据模型配置和请求内容动态计算max_tokens值
 * 支持基于实际usage的自适应学习
 */
export class TokenCalculator {
  private static readonly DEFAULT_SAFETY_MARGIN = 100;
  private static readonly DEFAULT_MIN_OUTPUT_TOKENS = 100;
  
  // 全局usage追踪器缓存（用于跨adapter共享学习数据）
  private static globalUsageTrackers = new Map<string, UsageTracker>();
  
  // 更精确的token计算常数
  private static readonly ENGLISH_CHARS_PER_TOKEN = 4.2; // 英文平均字符数
  private static readonly CHINESE_CHARS_PER_TOKEN = 1.5; // 中文平均字符数（1个中文字符≈2-3个token）
  private static readonly MIXED_CHARS_PER_TOKEN = 2.8; // 中英文混合内容
  
  // 语言检测相关常数
  private static readonly CHINESE_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
  private static readonly ENGLISH_WORD_REGEX = /[a-zA-Z]+/g;

  /**
   * 仅估算输入token数（轻量级方法）
   * 适用于只需要统计输入token的场景，如countTokens、历史压缩判断等
   * @param modelConfig 模型配置
   * @param request 请求参数
   * @returns 估算的输入token数
   */
  static estimateInputTokensOnly(
    modelConfig: ModelConfig,
    request: GenerateContentParameters
  ): number {
    return this.estimateInputTokens(request, modelConfig.authType);
  }

  /**
   * 根据模型配置和请求参数计算最优的max_tokens值
   * 适用于生成内容时需要设置max_tokens参数的场景
   * @param modelConfig 模型配置
   * @param request 请求参数
   */
  static calculateMaxTokens(
    modelConfig: ModelConfig,
    request: GenerateContentParameters
  ): TokenCalculationResult {
    // 提取token配置
    const tokenConfig = this.extractTokenConfig(modelConfig);
    if (!tokenConfig) {
      // 尝试从预定义配置中获取
      const fallbackConfig = this.getFallbackTokenConfig(modelConfig);
      if (!fallbackConfig) {
        // 如果没有任何配置，返回默认值
        return {
          maxTokens: 4000,
          estimatedInputTokens: 0,
          availableOutputTokens: 4000,
          isWithinLimits: true,
          warnings: ['模型缺少token配置，使用默认值']
        };
      }
      return this.computeOutputTokens(fallbackConfig, this.estimateInputTokens(request, modelConfig.authType));
    }

    // 估算输入token数（考虑API特性和历史准确度）
    const estimatedInputTokens = this.estimateInputTokens(request, modelConfig.authType);
    
    // 计算可用的输出token数
    const result = this.computeOutputTokens(tokenConfig, estimatedInputTokens);
    
    return result;
  }

  /**
   * 获取或创建全局usage追踪器
   */
  static getGlobalUsageTracker(modelKey: string): UsageTracker {
    if (!this.globalUsageTrackers.has(modelKey)) {
      this.globalUsageTrackers.set(modelKey, new UsageTracker());
    }
    return this.globalUsageTrackers.get(modelKey)!;
  }

  /**
   * 清除全局usage追踪器
   */
  static clearGlobalUsageTrackers(): void {
    this.globalUsageTrackers.clear();
  }

  /**
   * 从模型配置中提取token配置
   */
  private static extractTokenConfig(modelConfig: ModelConfig): TokenCalculationConfig | null {
    const { contextWindowTokenSize, maxOutputTokenSize, maxInputTokenSize } = modelConfig;
    
    if (!contextWindowTokenSize || !maxOutputTokenSize) {
      return null;
    }

    // 获取推荐的安全边距
    const recommendedMargin = getRecommendedSafetyMargin();

    return {
      contextWindowTokenSize,
      maxOutputTokenSize,
      maxInputTokenSize: maxInputTokenSize || contextWindowTokenSize,
      safetyMargin: recommendedMargin,
      minOutputTokens: this.DEFAULT_MIN_OUTPUT_TOKENS
    };
  }

  /**
   * 获取后备token配置（从预定义配置中）
   */
  private static getFallbackTokenConfig(modelConfig: ModelConfig): TokenCalculationConfig | null {
    const predefinedConfig = getModelTokenConfig(modelConfig.config.model);
    if (!predefinedConfig) {
      return null;
    }

    const recommendedMargin = getRecommendedSafetyMargin();

    return {
      contextWindowTokenSize: predefinedConfig.contextWindowTokenSize,
      maxOutputTokenSize: predefinedConfig.maxOutputTokenSize,
      maxInputTokenSize: predefinedConfig.maxInputTokenSize,
      safetyMargin: recommendedMargin,
      minOutputTokens: this.DEFAULT_MIN_OUTPUT_TOKENS
    };
  }

  /**
   * 估算输入token数量
   */
  private static estimateInputTokens(request: GenerateContentParameters, authType?: string): number {
    let totalTokens = 0;
    
    try {
      // 统计系统指令
      if (request.config?.systemInstruction) {
        const instruction = request.config.systemInstruction;
        if (typeof instruction === 'string') {
          totalTokens += this.calculateTextTokens(instruction, authType);
        }
      }

      // 统计对话内容
      const contents = Array.isArray(request.contents) ? request.contents : [request.contents];
      for (const content of contents) {
        if (content && typeof content === 'object' && 'parts' in content) {
          const parts = content.parts || [];
          for (const part of parts) {
            totalTokens += this.calculatePartTokens(part, authType);
          }
        }
      }

      // 统计工具定义（如果有）
      if (request.config?.tools) {
        try {
          const toolsJson = JSON.stringify(request.config.tools);
          totalTokens += this.calculateTextTokens(toolsJson, authType);
        } catch (error) {
          console.warn('Failed to stringify tools for token calculation:', error);
        }
      }
    } catch (error) {
      console.warn('Error estimating input tokens:', error);
      // 返回一个保守的估算值
      return 1000;
    }

    // 对于较长上下文，额外增加一个冗余倍率
    if (totalTokens > 50000) {
      totalTokens *= 1.05;
    }

    return Math.max(Math.ceil(totalTokens), 1); // 确保至少1个token
  }

  /**
   * 计算单个part的token数（考虑语言特性）
   * 针对不同API和内容类型进行优化计算
   */
  private static calculatePartTokens(part: any, authType?: string): number {
    if (!part || typeof part !== 'object') {
      return 0;
    }

    let totalTokens = 0;

    // 文本内容 - 使用精确的语言感知计算
    if (part.text && typeof part.text === 'string') {
      totalTokens += this.calculateTextTokens(part.text, authType);
      // Anthropic API需要额外计算type字段
      if (authType === 'anthropic') {
        totalTokens += Math.ceil(this.getAnthropicTypeOverhead('text') / this.ENGLISH_CHARS_PER_TOKEN);
      }
    }

    // 图片内容
    if (part.inlineData) {
      totalTokens += this.calculateImageTokens(part.inlineData, authType);
      // Anthropic API需要额外计算type字段
      if (authType === 'anthropic') {
        totalTokens += Math.ceil(this.getAnthropicTypeOverhead('image') / this.ENGLISH_CHARS_PER_TOKEN);
      }
    }

    // 工具调用 (functionCall)
    if (part.functionCall) {
      totalTokens += this.calculateFunctionCallTokens(part.functionCall, authType);
    }

    // 工具调用返回 (functionResponse)
    if (part.functionResponse) {
      totalTokens += this.calculateFunctionResponseTokens(part.functionResponse, authType);
    }

    return totalTokens;
  }

  /**
   * 语言感知的文本token计算
   * 根据中英文比例动态调整计算方式
   */
  private static calculateTextTokens(text: string, authType?: string): number {
    if (!text || typeof text !== 'string') {
      return 0;
    }

    const languageStats = this.analyzeLanguage(text);
    const { chineseChars, englishChars, otherChars, chineseRatio } = languageStats;
    
    let totalTokens = 0;
    
    // 根据不同API和语言特性计算token
    switch (authType) {
      case 'anthropic':
        // Claude的tokenization实际上比预期消耗更多token，特别是中英文混合内容
        // 根据实际测试调整参数，使计算更保守
        totalTokens = Math.ceil(chineseChars / 1) + // 中文：约1字符/token
                     Math.ceil(englishChars / 4) + // 英文：约4字符/token
                     Math.ceil(otherChars / 2);    // 其他：约2字符
        
        // 对于中英文混合内容，Anthropic的token消耗有额外开销
        if (chineseChars > 0 && englishChars > 0) {
          const mixedContentPenalty = Math.ceil((chineseChars + englishChars) * 0.15); // 15%的混合内容惩罚
          totalTokens += mixedContentPenalty;
        }
        
        // 对于长文本，Anthropic的token计算会有额外的上下文开销
        if (text.length > 1000) {
          const longTextPenalty = Math.ceil(text.length * 0.08); // 8%的长文本惩罚
          totalTokens += longTextPenalty;
        }
        break;
        
      case 'openai':
        // GPT系列对中文token消耗较高
        totalTokens = Math.ceil(chineseChars / 1) + // 中文：约1.2字符/token（更多token）
                     Math.ceil(englishChars / 4) + // 英文：约4字符/token
                     Math.ceil(otherChars / 2);    // 其他：约2字符/token
        break;
        
      default:
        // 通用计算：根据中英文比例动态调整
        if (chineseRatio > 0.7) {
          // 主要是中文内容
          totalTokens = Math.ceil(text.length / this.CHINESE_CHARS_PER_TOKEN);
        } else if (chineseRatio < 0.1) {
          // 主要是英文内容
          totalTokens = Math.ceil(text.length / this.ENGLISH_CHARS_PER_TOKEN);
        } else {
          // 中英文混合内容
          totalTokens = Math.ceil(chineseChars / this.CHINESE_CHARS_PER_TOKEN) +
                       Math.ceil(englishChars / this.ENGLISH_CHARS_PER_TOKEN) +
                       Math.ceil(otherChars / this.MIXED_CHARS_PER_TOKEN);
        }
    }
    
    return Math.max(totalTokens, 1); // 确保至少1个token
  }

  /**
   * 分析文本的语言组成
   */
  private static analyzeLanguage(text: string): {
    chineseChars: number;
    englishChars: number;
    otherChars: number;
    chineseRatio: number;
    englishRatio: number;
    totalLength: number;
  } {
    const chineseMatches = text.match(this.CHINESE_CHAR_REGEX) || [];
    const englishMatches = text.match(this.ENGLISH_WORD_REGEX) || [];
    
    const chineseChars = chineseMatches.length;
    const englishChars = englishMatches.join('').length;
    const totalLength = text.length;
    const otherChars = totalLength - chineseChars - englishChars;
    
    return {
      chineseChars,
      englishChars,
      otherChars: Math.max(otherChars, 0),
      chineseRatio: totalLength > 0 ? chineseChars / totalLength : 0,
      englishRatio: totalLength > 0 ? englishChars / totalLength : 0,
      totalLength
    };
  }

  /**
   * 计算Anthropic API的type字段开销
   */
  private static getAnthropicTypeOverhead(contentType: string): number {
    // Anthropic API格式: { type: "text", text: "..." }
    // 需要额外计算type字段的开销
    switch (contentType) {
      case 'text':
        return 'text'.length; // type字段值的长度
      case 'image':
        return 'image'.length;
      case 'tool_use':
        return 'tool_use'.length;
      case 'tool_result':
        return 'tool_result'.length;
      default:
        return contentType.length;
    }
  }

  /**
   * 计算图片内容的token数
   */
  private static calculateImageTokens(inlineData: any, authType?: string): number {
    if (!inlineData || !inlineData.mimeType) {
      return 0;
    }

    const mimeType = inlineData.mimeType;
    if (!mimeType.startsWith('image/')) {
      return 0;
    }

    // 不同API的图片token计算差异
    switch (authType) {
      case 'anthropic':
        // Claude视觉模型: 约85-1700 tokens，取决于图片复杂度
        // Anthropic还需要计算base64数据的部分开销
        { const base64Data = inlineData.data || '';
        const base64Overhead = Math.min(base64Data.length * 0.1, 100); // 限制base64开销
        return 800 + base64Overhead; } // Claude平均值 + base64开销
        
      case 'openai':
        // GPT-4V: 约85-2000 tokens
        return 600; // GPT-4V��均值
        
      default:
        // 通用估算
        return 500;
    }
  }

  /**
   * 计算工具调用的token数
   */
  private static calculateFunctionCallTokens(functionCall: any, authType?: string): number {
    if (!functionCall) {
      return 0;
    }

    let totalTokens = 0;

    // 工具名称 - 通常是英文
    if (functionCall.name) {
      totalTokens += Math.ceil(functionCall.name.length / this.ENGLISH_CHARS_PER_TOKEN);
    }

    // 工具参数 - 可能包含中英文混合内容
    if (functionCall.args) {
      try {
        const argsJson = JSON.stringify(functionCall.args);
        totalTokens += this.calculateTextTokens(argsJson, authType);
      } catch (error) {
        console.warn('Failed to stringify function call args:', error);
      }
    }

    // 工具ID - 通常是英文/数字
    if (functionCall.id) {
      totalTokens += Math.ceil(functionCall.id.length / this.ENGLISH_CHARS_PER_TOKEN);
    }

    // API特定的额外开销
    switch (authType) {
      case 'anthropic':
        // Anthropic格式: { type: "tool_use", id: "...", name: "...", input: {...} }
        totalTokens += Math.ceil(this.getAnthropicTypeOverhead('tool_use') / this.ENGLISH_CHARS_PER_TOKEN);
        totalTokens += Math.ceil(('input' + 'id' + 'name').length / this.ENGLISH_CHARS_PER_TOKEN);
        break;
        
      case 'openai':
        // OpenAI格式: tool_calls数组中的function对象
        totalTokens += Math.ceil(('function' + 'name' + 'arguments').length / this.ENGLISH_CHARS_PER_TOKEN);
        break;
        
      default:
        // 通用开销估算
        totalTokens += Math.ceil(20 / this.ENGLISH_CHARS_PER_TOKEN);
    }

    return Math.max(totalTokens, 1);
  }

  /**
   * 计算工具调用返回的token数
   */
  private static calculateFunctionResponseTokens(functionResponse: any, authType?: string): number {
    if (!functionResponse) {
      return 0;
    }

    let totalTokens = 0;

    // 工具调用ID - 通常是英文/数字
    if (functionResponse.id) {
      totalTokens += Math.ceil(functionResponse.id.length / this.ENGLISH_CHARS_PER_TOKEN);
    }

    // 响应内容 - 可能包含中英文混合内容
    if (functionResponse.response) {
      const response = functionResponse.response;
      
      if (typeof response === 'string') {
        totalTokens += this.calculateTextTokens(response, authType);
      } else if (response && typeof response === 'object') {
        // 处理结构化响应
        if (response.output && typeof response.output === 'string') {
          totalTokens += this.calculateTextTokens(response.output, authType);
        } else if (response.error && typeof response.error === 'string') {
          totalTokens += this.calculateTextTokens(response.error, authType);
        } else if (response.content && Array.isArray(response.content)) {
          // 处理content数组
          for (const item of response.content) {
            if (item && typeof item === 'object' && item.text) {
              totalTokens += this.calculateTextTokens(item.text, authType);
            }
          }
        } else {
          // 其他情况，序列化整个响应
          try {
            const responseJson = JSON.stringify(response);
            totalTokens += this.calculateTextTokens(responseJson, authType);
          } catch (error) {
            console.warn('Failed to stringify function response:', error);
          }
        }
      }
    }

    // API特定的额外开销
    switch (authType) {
      case 'anthropic':
        // Anthropic格式: { type: "tool_result", tool_use_id: "...", content: "..." }
        totalTokens += Math.ceil(this.getAnthropicTypeOverhead('tool_result') / this.ENGLISH_CHARS_PER_TOKEN);
        totalTokens += Math.ceil(('tool_use_id' + 'content').length / this.ENGLISH_CHARS_PER_TOKEN);
        break;
        
      case 'openai':
        // OpenAI格式: { role: "tool", tool_call_id: "...", content: "..." }
        totalTokens += Math.ceil(('tool' + 'tool_call_id' + 'content').length / this.ENGLISH_CHARS_PER_TOKEN);
        break;
        
      default:
        // 通用开销估算
        totalTokens += Math.ceil(25 / this.ENGLISH_CHARS_PER_TOKEN);
    }

    return Math.max(totalTokens, 1);
  }

  /**
   * 🎯 新增：根据已估算的输入token数计算max_tokens
   * 用于支持增量计算场景，避免重复估算
   * @param modelConfig 模型配置
   * @param estimatedInputTokens 已估算的输入token数
   * @param options 可选配置
   * @param options.ignoreMaxOutputLimit 是否忽略 maxOutputTokenSize 限制（用于压缩等场景）
   */
  static computeMaxTokensFromEstimatedInput(
    modelConfig: ModelConfig,
    estimatedInputTokens: number,
    options?: { ignoreMaxOutputLimit?: boolean }
  ): TokenCalculationResult {
    // 提取token配置
    const tokenConfig = this.extractTokenConfig(modelConfig);
    if (!tokenConfig) {
      // 尝试从预定义配置中获取
      const fallbackConfig = this.getFallbackTokenConfig(modelConfig);
      if (!fallbackConfig) {
        // 如果没有任何配置，返回默认值
        return {
          maxTokens: 10000,
          estimatedInputTokens,
          availableOutputTokens: 10000,
          isWithinLimits: true,
          warnings: ['模型缺少token配置，使用默认值']
        };
      }
      return this.computeOutputTokens(fallbackConfig, estimatedInputTokens, options);
    }

    return this.computeOutputTokens(tokenConfig, estimatedInputTokens, options);
  }

  /**
   * 计算输出token数
   * @param config Token计算配置
   * @param estimatedInputTokens 估算的输入token数
   * @param options 可选配置
   * @param options.ignoreMaxOutputLimit 是否忽略 maxOutputTokenSize 限制（用于压缩等场景）
   */
  private static computeOutputTokens(
    config: TokenCalculationConfig,
    estimatedInputTokens: number,
    options?: { ignoreMaxOutputLimit?: boolean }
  ): TokenCalculationResult {
    const warnings: string[] = [];
    
    // 检查输入是否超出限制
    if (config.maxInputTokenSize && estimatedInputTokens > config.maxInputTokenSize) {
      warnings.push(`输入token数(${estimatedInputTokens})超出模型限制(${config.maxInputTokenSize})`);
    }

    // 计算基于上下文窗口的可用输出token
    const contextBasedOutput = config.contextWindowTokenSize - estimatedInputTokens - (config.safetyMargin || 0);
    
    // 🎯 根据选项决定是否限制 maxOutputTokenSize
    let maxTokens: number;
    if (options?.ignoreMaxOutputLimit) {
      // 压缩场景：使用全部可用空间，不受 maxOutputTokenSize 限制
      maxTokens = contextBasedOutput;
      console.log(
        `🎯 [TokenCalculator] 忽略 maxOutputTokenSize 限制 (压缩场景), ` +
        `使用全部可用输出空间: ${maxTokens} tokens (可用: ${contextBasedOutput})`
      );
    } else {
      // 正常场景：限制输出长度
      maxTokens = Math.min(
        contextBasedOutput,
        config.maxOutputTokenSize
      );
    }

    // 确保不低于最小值
    const minTokens = config.minOutputTokens || this.DEFAULT_MIN_OUTPUT_TOKENS;
    if (maxTokens < minTokens) {
      maxTokens = minTokens;
      warnings.push(`输出token被调整到最小值(${minTokens})`);
    }

    // 确保为正数
    maxTokens = Math.max(maxTokens, 1);

    const isWithinLimits = options?.ignoreMaxOutputLimit 
      ? (maxTokens <= contextBasedOutput && estimatedInputTokens <= (config.maxInputTokenSize || config.contextWindowTokenSize))
      : (maxTokens <= config.maxOutputTokenSize && estimatedInputTokens <= (config.maxInputTokenSize || config.contextWindowTokenSize));

    return {
      maxTokens,
      estimatedInputTokens,
      availableOutputTokens: contextBasedOutput,
      isWithinLimits,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * 获取模型的推荐配置
   */
  static getRecommendedConfig(modelName: string): Partial<TokenCalculationConfig> {
    // 根据常见模型提供推荐配置
    const recommendations: Record<string, Partial<TokenCalculationConfig>> = {
      'gpt-4': {
        safetyMargin: 200,
        minOutputTokens: 150
      },
      'gpt-4-turbo': {
        safetyMargin: 300,
        minOutputTokens: 200
      },
      'claude-3-5-sonnet': {
        safetyMargin: 800, // 增加安全边距，因为token计算差异较大
        minOutputTokens: 200
      },
      'claude-3-5-haiku': {
        safetyMargin: 600, // 增加安全边距
        minOutputTokens: 100
      },
      'claude-3-opus': {
        safetyMargin: 700, // Claude系列统一增加安全边距
        minOutputTokens: 200
      }
    };

    // 模糊匹配模型名称
    for (const [key, config] of Object.entries(recommendations)) {
      if (modelName.toLowerCase().includes(key.toLowerCase())) {
        return config;
      }
    }

    // Claude系列的通用配置
    if (modelName.toLowerCase().includes('claude')) {
      return {
        safetyMargin: 700,
        minOutputTokens: 150
      };
    }

    return {};
  }

  /**
   * 详细的token计算分析（用于调试）
   */
  static analyzeTokenCalculation(
    modelConfig: ModelConfig,
    request: GenerateContentParameters
  ): {
    breakdown: {
      systemInstruction: number;
      textContent: number;
      imageContent: number;
      functionCalls: number;
      functionResponses: number;
      toolDefinitions: number;
      apiOverhead: number;
    };
    languageStats: {
      totalChineseChars: number;
      totalEnglishChars: number;
      totalOtherChars: number;
      chineseRatio: number;
    };
    total: number;
    authType: string;
  } {
    const authType = modelConfig.authType;
    const breakdown = {
      systemInstruction: 0,
      textContent: 0,
      imageContent: 0,
      functionCalls: 0,
      functionResponses: 0,
      toolDefinitions: 0,
      apiOverhead: 0
    };

    let totalChineseChars = 0;
    let totalEnglishChars = 0;
    let totalOtherChars = 0;

    // 系统指令
    if (request.config?.systemInstruction) {
      const instruction = request.config.systemInstruction;
      if (typeof instruction === 'string') {
        breakdown.systemInstruction = this.calculateTextTokens(instruction, authType);
        const stats = this.analyzeLanguage(instruction);
        totalChineseChars += stats.chineseChars;
        totalEnglishChars += stats.englishChars;
        totalOtherChars += stats.otherChars;
      }
    }

    // 对话内容详细分析
    const contents = Array.isArray(request.contents) ? request.contents : [request.contents];
    for (const content of contents) {
      if (content && typeof content === 'object' && 'parts' in content) {
        const parts = content.parts || [];
        for (const part of parts) {
          if (part.text) {
            const textTokens = this.calculateTextTokens(part.text, authType);
            breakdown.textContent += textTokens;
            
            const stats = this.analyzeLanguage(part.text);
            totalChineseChars += stats.chineseChars;
            totalEnglishChars += stats.englishChars;
            totalOtherChars += stats.otherChars;
            
            if (authType === 'anthropic') {
              breakdown.apiOverhead += Math.ceil(this.getAnthropicTypeOverhead('text') / this.ENGLISH_CHARS_PER_TOKEN);
            }
          }
          if (part.inlineData) {
            const imageTokens = this.calculateImageTokens(part.inlineData, authType);
            breakdown.imageContent += imageTokens;
            if (authType === 'anthropic') {
              breakdown.apiOverhead += Math.ceil(this.getAnthropicTypeOverhead('image') / this.ENGLISH_CHARS_PER_TOKEN);
            }
          }
          if (part.functionCall) {
            const callTokens = this.calculateFunctionCallTokens(part.functionCall, authType);
            breakdown.functionCalls += callTokens;
          }
          if (part.functionResponse) {
            const responseTokens = this.calculateFunctionResponseTokens(part.functionResponse, authType);
            breakdown.functionResponses += responseTokens;
          }
        }
      }
    }

    // 工具定义
    if (request.config?.tools) {
      try {
        const toolsJson = JSON.stringify(request.config.tools);
        breakdown.toolDefinitions = this.calculateTextTokens(toolsJson, authType);
        
        const stats = this.analyzeLanguage(toolsJson);
        totalChineseChars += stats.chineseChars;
        totalEnglishChars += stats.englishChars;
        totalOtherChars += stats.otherChars;
      } catch (error) {
        console.warn('Failed to stringify tools for analysis:', error);
      }
    }

    const total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
    const totalChars = totalChineseChars + totalEnglishChars + totalOtherChars;

    return {
      breakdown,
      languageStats: {
        totalChineseChars,
        totalEnglishChars,
        totalOtherChars,
        chineseRatio: totalChars > 0 ? totalChineseChars / totalChars : 0
      },
      total,
      authType
    };
  }

  /**
   * 打印详细的token计算分析
   */
  static printTokenAnalysis(
    modelConfig: ModelConfig,
    request: GenerateContentParameters
  ): void {
    const analysis = this.analyzeTokenCalculation(modelConfig, request);
    
    console.log(`\n🔍 Token计算详细分析 (${analysis.authType} API)`);
    console.log('=====================================');
    
    // 显示各部分token分布
    Object.entries(analysis.breakdown).forEach(([key, value]) => {
      if (value > 0) {
        const percentage = ((value / analysis.total) * 100).toFixed(1);
        console.log(`${key.padEnd(20)}: ${value.toString().padStart(4)} tokens (${percentage}%)`);
      }
    });
    
    console.log('─'.repeat(50));
    console.log(`${'总计'.padEnd(20)}: ${analysis.total.toString().padStart(4)} tokens`);
    
    // 显示语言统计信息
    const { languageStats } = analysis;
    if (languageStats.totalChineseChars > 0 || languageStats.totalEnglishChars > 0) {
      console.log('\n📊 语言组成分析:');
      console.log(`中文字符: ${languageStats.totalChineseChars} (${(languageStats.chineseRatio * 100).toFixed(1)}%)`);
      console.log(`英文字符: ${languageStats.totalEnglishChars} (${((languageStats.totalEnglishChars / (languageStats.totalChineseChars + languageStats.totalEnglishChars + languageStats.totalOtherChars)) * 100).toFixed(1)}%)`);
      if (languageStats.totalOtherChars > 0) {
        console.log(`其他字符: ${languageStats.totalOtherChars}`);
      }
      
      // 显示token效率
      const totalChars = languageStats.totalChineseChars + languageStats.totalEnglishChars + languageStats.totalOtherChars;
      if (totalChars > 0) {
        const avgCharsPerToken = totalChars / analysis.total;
        console.log(`平均字符/Token: ${avgCharsPerToken.toFixed(2)}`);
        
        // 给出优化建议
        if (languageStats.chineseRatio > 0.5 && analysis.authType === 'openai') {
          console.log('\n💡 优化建议: 当前内容中文占比较高，考虑使用Claude等对中文更友好的模型');
        } else if (languageStats.chineseRatio < 0.1 && analysis.authType === 'anthropic') {
          console.log('\n💡 优化建议: 当前内容主要为英文，GPT系列可能更经济');
        }
      }
    }
    
    if (analysis.breakdown.apiOverhead > 0) {
      const overheadPercentage = ((analysis.breakdown.apiOverhead / analysis.total) * 100).toFixed(1);
      console.log(`\n🔧 ${analysis.authType} API开销: ${analysis.breakdown.apiOverhead} tokens (${overheadPercentage}%)`);
    }
  }
}
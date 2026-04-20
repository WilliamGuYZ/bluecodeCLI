/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';

/**
 * Token使用情况追踪器
 * 用于收集和缓存实际的API返回的token使用信息
 */

/**
 * 🎯 计算请求内容的简单hash
 * 用于判断两次请求的内容是否相同
 */
export function hashRequestContent(contents: unknown): string {
  const contentStr = JSON.stringify(contents);
  return crypto.createHash('md5').update(contentStr).digest('hex');
}

export interface TokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  timestamp: number;
  // 🎯 新增：记录对应的请求内容hash，用于智能缓存
  contentHash?: string;
}

export interface UsageMetrics {
  // 最近一次请求的实际usage
  lastUsage: TokenUsageInfo | null;
  // 🎯 新增：最近N次请求的usage历史（用于更智能的缓存匹配）
  recentUsageHistory: TokenUsageInfo[];
  // 历史usage累计
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  // 估算准确度追踪
  estimationAccuracy: {
    samples: number;
    totalEstimatedInput: number;
    totalActualInput: number;
    averageError: number; // 平均误差百分比
  };
  // 🎯 新增：缓存命中统计
  cacheHitStats: {
    totalQueries: number;
    exactHits: number;
    estimationFallbacks: number;
  };
}

/**
 * Usage追踪器类
 * 负责收集、缓存和分析token使用情况
 */
export class UsageTracker {
  private metrics: UsageMetrics;
  private readonly maxSamples = 100; // 保留最近100次的估算准确度样本
  private readonly maxRecentHistory = 100; // 🎯 保留最近100次请求的usage历史

  constructor() {
    this.metrics = {
      lastUsage: null,
      recentUsageHistory: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCachedTokens: 0,
      estimationAccuracy: {
        samples: 0,
        totalEstimatedInput: 0,
        totalActualInput: 0,
        averageError: 0,
      },
      cacheHitStats: {
        totalQueries: 0,
        exactHits: 0,
        estimationFallbacks: 0,
      },
    };
  }

  /**
   * 记录实际的token使用情况
   */
  recordUsage(usage: TokenUsageInfo): void {
    this.metrics.lastUsage = usage;
    this.metrics.totalPromptTokens += usage.promptTokens;
    this.metrics.totalCompletionTokens += usage.completionTokens;
    if (usage.cachedTokens) {
      this.metrics.totalCachedTokens += usage.cachedTokens;
    }
    
    // 🎯 新增：维护最近N次请求的历史记录
    this.metrics.recentUsageHistory.push(usage);
    if (this.metrics.recentUsageHistory.length > this.maxRecentHistory) {
      this.metrics.recentUsageHistory.shift(); // 移除最旧的记录
    }
  }

  /**
   * 记录估算准确度
   * @param estimated 估算的输入token数
   * @param actual 实际的输入token数
   */
  recordEstimationAccuracy(estimated: number, actual: number): void {
    const accuracy = this.metrics.estimationAccuracy;
    
    accuracy.samples++;
    accuracy.totalEstimatedInput += estimated;
    accuracy.totalActualInput += actual;
    
    // 计算平均误差百分比
    if (accuracy.totalActualInput > 0) {
      const errorRate = Math.abs(accuracy.totalEstimatedInput - accuracy.totalActualInput) / accuracy.totalActualInput;
      accuracy.averageError = errorRate * 100;
    }
    
    // 如果样本过多，重置统计（保持最近的趋势）
    if (accuracy.samples > this.maxSamples) {
      accuracy.samples = Math.floor(this.maxSamples / 2);
      accuracy.totalEstimatedInput /= 2;
      accuracy.totalActualInput /= 2;
    }
  }

  /**
   * 获取最近一次的实际usage
   */
  getLastUsage(): TokenUsageInfo | null {
    return this.metrics.lastUsage;
  }

  /**
   * 获取完整的metrics
   */
  getMetrics(): UsageMetrics {
    return { ...this.metrics };
  }

  /**
   * 获取估算校正系数
   * 基于历史准确度，返回一个用于校正估算值的系数
   */
  getEstimationCorrectionFactor(): number {
    const accuracy = this.metrics.estimationAccuracy;
    
    // 样本不足时返回1.0（不校正）
    if (accuracy.samples < 5) {
      return 1.0;
    }
    
    // 计算校正系数
    if (accuracy.totalEstimatedInput > 0) {
      return accuracy.totalActualInput / accuracy.totalEstimatedInput;
    }
    
    return 1.0;
  }

  /**
   * 获取估算准确度报告
   */
  getAccuracyReport(): {
    samples: number;
    averageError: number;
    correctionFactor: number;
    isReliable: boolean;
  } {
    const accuracy = this.metrics.estimationAccuracy;
    const correctionFactor = this.getEstimationCorrectionFactor();
    
    return {
      samples: accuracy.samples,
      averageError: accuracy.averageError,
      correctionFactor,
      isReliable: accuracy.samples >= 10 && accuracy.averageError < 15, // 样本>=10且误差<15%认为可靠
    };
  }

  /**
   * 重置追踪器
   */
  reset(): void {
    this.metrics = {
      lastUsage: null,
      recentUsageHistory: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCachedTokens: 0,
      estimationAccuracy: {
        samples: 0,
        totalEstimatedInput: 0,
        totalActualInput: 0,
        averageError: 0,
      },
      cacheHitStats: {
        totalQueries: 0,
        exactHits: 0,
        estimationFallbacks: 0,
      },
    };
  }

  /**
   * 🎯 根据内容hash查找缓存的实际token数
   * 用于countTokens优化：如果请求内容与上次相同，直接返回实际值
   * 
   * @param contentHash 请求内容的hash值
   * @param enableDebugLog 是否启用调试日志（通过环境变量 DEBUG_TOKEN_CALCULATION 控制）
   * @returns 缓存的token数，如果未找到则返回null
   */
  getCachedTokensByContentHash(contentHash: string, enableDebugLog = false): number | null {
    this.metrics.cacheHitStats.totalQueries++;
    
    // 优先检查最近一次请求（最常见的情况）
    if (this.metrics.lastUsage?.contentHash === contentHash) {
      this.metrics.cacheHitStats.exactHits++;
      
      if (enableDebugLog) {
        console.log(`🎯 [UsageTracker] 缓存命中 (lastUsage): ${this.metrics.lastUsage.promptTokens} tokens`);
      }
      
      return this.metrics.lastUsage.promptTokens;
    }
    
    // 🎯 新增：在最近N次历史中查找匹配
    for (let i = this.metrics.recentUsageHistory.length - 1; i >= 0; i--) {
      const usage = this.metrics.recentUsageHistory[i];
      if (usage.contentHash === contentHash) {
        this.metrics.cacheHitStats.exactHits++;
        
        if (enableDebugLog) {
          console.log(`🎯 [UsageTracker] 缓存命中 (历史记录 #${i}): ${usage.promptTokens} tokens`);
        }
        
        return usage.promptTokens;
      }
    }
    
    // 未找到匹配
    this.metrics.cacheHitStats.estimationFallbacks++;
    
    if (enableDebugLog) {
      console.log(`🎯 [UsageTracker] 缓存未命中，将使用估算`);
    }
    
    return null;
  }

  /**
   * 🎯 新增：获取缓存命中率统计
   */
  getCacheHitStats(): {
    totalQueries: number;
    exactHits: number;
    estimationFallbacks: number;
    hitRate: number;
  } {
    const { totalQueries, exactHits, estimationFallbacks } = this.metrics.cacheHitStats;
    const hitRate = totalQueries > 0 ? (exactHits / totalQueries) * 100 : 0;
    
    return {
      totalQueries,
      exactHits,
      estimationFallbacks,
      hitRate,
    };
  }

  /**
   * 🎯 新增：增量计算 - 查找历史messages的实际token数
   * 用于优化：当前request包含历史messages + 新message时，
   * 可以使用历史的实际token数 + 新message的估算，提高准确度
   * 
   * @param historyContents 历史messages（不包含最新的message）
   * @returns 历史messages的实际token数，如果未找到则返回null
   */
  getHistoricalTokens(historyContents: unknown): number | null {
    const historyHash = hashRequestContent(historyContents);
    
    // 在最近的历史记录中查找匹配
    for (let i = this.metrics.recentUsageHistory.length - 1; i >= 0; i--) {
      const usage = this.metrics.recentUsageHistory[i];
      if (usage.contentHash === historyHash) {
        return usage.promptTokens;
      }
    }
    
    return null;
  }

  /**
   * 打印统计信息（用于调试）
   */
  printStats(): void {
    const report = this.getAccuracyReport();
    const cacheStats = this.getCacheHitStats();
    
    console.log('\n📊 Token Usage Statistics');
    console.log('═'.repeat(50));
    console.log(`Total Prompt Tokens:     ${this.metrics.totalPromptTokens.toLocaleString()}`);
    console.log(`Total Completion Tokens: ${this.metrics.totalCompletionTokens.toLocaleString()}`);
    console.log(`Total Cached Tokens:     ${this.metrics.totalCachedTokens.toLocaleString()}`);
    console.log(`Total Tokens:            ${(this.metrics.totalPromptTokens + this.metrics.totalCompletionTokens).toLocaleString()}`);
    
    if (this.metrics.lastUsage) {
      console.log('\n📝 Last Request:');
      console.log(`  Prompt:     ${this.metrics.lastUsage.promptTokens}`);
      console.log(`  Completion: ${this.metrics.lastUsage.completionTokens}`);
      if (this.metrics.lastUsage.cachedTokens) {
        console.log(`  Cached:     ${this.metrics.lastUsage.cachedTokens}`);
      }
    }
    
    if (report.samples > 0) {
      console.log('\n🎯 Estimation Accuracy:');
      console.log(`  Samples:           ${report.samples}`);
      console.log(`  Average Error:     ${report.averageError.toFixed(2)}%`);
      console.log(`  Correction Factor: ${report.correctionFactor.toFixed(3)}`);
      console.log(`  Reliability:       ${report.isReliable ? '✅ Reliable' : '⚠️ Needs more samples'}`);
    }
    
    // 🎯 新增：缓存命中率统计
    if (cacheStats.totalQueries > 0) {
      console.log('\n💾 Cache Performance:');
      console.log(`  Total Queries:     ${cacheStats.totalQueries}`);
      console.log(`  Exact Hits:        ${cacheStats.exactHits}`);
      console.log(`  Estimation Falls:  ${cacheStats.estimationFallbacks}`);
      console.log(`  Hit Rate:          ${cacheStats.hitRate.toFixed(2)}%`);
    }
    
    console.log('═'.repeat(50));
  }
}

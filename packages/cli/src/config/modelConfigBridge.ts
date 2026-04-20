/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI包的ModelConfig桥接器
 * 负责将CLI包的ModelConfig传递给Core包
 */

import { Config } from '@vivo/bluecode-cli-core';
import { ModelConfig } from './modelConfig.js';

/**
 * CLI包的ModelConfig桥接器
 */
export class CLIModelConfigBridge {
  /**
   * 将CLI包的ModelConfig转换为Core包可用的格式
   */
  static toCoreModelConfig(cliModelConfig: ModelConfig): any {
    return cliModelConfig;
  }

  /**
   * 将ModelConfig设置到Core包的Config中
   */
  static setModelConfigToCore(config: Config, cliModelConfig: ModelConfig): void {
    const coreModelConfig = this.toCoreModelConfig(cliModelConfig);
    
    // 使用类型断言调用setModelConfig方法
    (config as any).setModelConfig(coreModelConfig);
    
    // 验证传递是否成功
    const hasModelConfig = (config as any).hasModelConfig?.();
    if (!hasModelConfig) {
      console.warn('⚠️ ModelConfig传递验证失败');
    }
  }

  /**
   * 检查Core包是否支持ModelConfig
   */
  static checkCoreSupport(config: Config): boolean {
    return typeof (config as any).setModelConfig === 'function' &&
           typeof (config as any).getModelConfig === 'function';
  }

  /**
   * 安全地设置ModelConfig（带兼容性检查）
   */
  static safeSetModelConfig(config: Config, cliModelConfig: ModelConfig): boolean {
    try {
      if (!this.checkCoreSupport(config)) {
        console.warn('Core包不支持ModelConfig，使用环境变量方式');
        return false;
      }

      this.setModelConfigToCore(config, cliModelConfig);
      return true;
    } catch (error) {
      console.error('设置ModelConfig失败:', error);
      return false;
    }
  }

  /**
   * 获取当前Core包中的ModelConfig
   */
  static getCoreModelConfig(config: Config): any | undefined {
    try {
      if (!this.checkCoreSupport(config)) {
        return undefined;
      }
      return (config as any).getModelConfig();
    } catch (error) {
      console.error('获取Core ModelConfig失败:', error);
      return undefined;
    }
  }

  /**
   * 创建配置摘要用于日志
   */
  static createConfigSummary(cliModelConfig: ModelConfig): string {
    const hasTokenConfig = !!(
      cliModelConfig.contextWindowTokenSize &&
      cliModelConfig.maxOutputTokenSize
    );
    
    return `${cliModelConfig.name} (${cliModelConfig.authType}, ${hasTokenConfig ? '完整token配置' : '基础配置'})`;
  }
}
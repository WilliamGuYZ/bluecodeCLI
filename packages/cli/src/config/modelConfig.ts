/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getHost } from './hosts.js';
import { getUserIdFromLocal } from '../auth/storage.js';

// 基于model-config.json的模型配置接口定义
export interface ModelConfig {
  id: string;                    // 模型唯一标识
  name: string;                  // 模型显示名称
  description: string;           // 模型描述
  authType: string;              // 认证类型: "openai", "anthropic"
  config: {
    model: string;               // 实际模型名称
    baseUrl: string;             // API基础URL
    apiKey: string;              // API密钥
  };
  enabled: number;               // 1=可用, 0=禁用
  order: number;                 // 排序权重
  isPublic?: boolean;            // 是否为公开模型（true=公开模型，false=私有模型）
  users?: number[];              // 可访问此模型的用户ID列表（仅对isPublic=false的模型有效）
  // Token限制配置
  contextWindowTokenSize?: number;  // 上下文窗口总大小
  maxOutputTokenSize?: number;      // 最大输出token数
  maxInputTokenSize?: number;       // 最大输入token数
}

// API响应接口
interface ApiResponse {
  code: string;
  msg: string;
  data: ModelConfig[] | string; // 可能是数组或JSON字符串
}

// 模型配置管理类
export class ModelConfigManager {
  private static instance: ModelConfigManager;
  private modelList: ModelConfig[] = [];
  private currentModel: ModelConfig | null = null;
  private apiUrl: string = ''; // 动态设置，不再使用固定URL
  private currentUserId: string | null = null; // 当前用户ID

  private constructor() {}

  public static getInstance(): ModelConfigManager {
    if (!ModelConfigManager.instance) {
      ModelConfigManager.instance = new ModelConfigManager();
    }
    return ModelConfigManager.instance;
  }

  /**
   * 初始化模型配置
   * @param userId 可选的用户ID，用于检查私有模型访问权限
   */
  public async initialize(): Promise<void> {
    try {
      // 获取当前用户ID
      const userId = getUserIdFromLocal()
      if (userId) {
        this.currentUserId = userId;
      }

      // 加载模型配置
      try {
        await this.loadFromApi();
        // console.log('正在从API返回加载模型配置');
      } catch (apiError) {
        console.warn('API加载失败:', apiError);
      }
      
      // // 选择默认模型
      // this.selectDefaultModel();
      
      // 获取可用模型列表
      // const availableModels = this.getAvailableModels();
      // console.log(`已加载 ${availableModels.length} 个可用模型配置`);
      // if (this.currentModel) {
      //   console.log(`当前模型: ${this.currentModel.name}`);
      // }
    } catch (error) {
      console.error('初始化模型配置失败:', error);
      throw error;
    }
  }

  /**
   * 从本地文件加载配置（模拟API接口）
   */
  // private async loadFromLocalFile(): Promise<void> {
  //   try {
  //     if (!fs.existsSync(this.localConfigPath)) {
  //       throw new Error('model-config.json 文件不存在');
  //     }

  //     const fileContent = fs.readFileSync(this.localConfigPath, 'utf-8');
  //     const apiResponse = JSON.parse(fileContent);

  //     // 检查API响应格式
  //     if (apiResponse.code === '200' && Array.isArray(apiResponse.data)) {
  //       this.modelList = apiResponse.data;
  //     } else {
  //       throw new Error('配置文件格式错误');
  //     }
  //   } catch (error) {
  //     console.error('加载本地配置文件失败:', error);
  //     throw error;
  //   }
  // }

  /**
   * 从API获取配置
   * 使用动态域名获取模型配置列表
   */
  private async loadFromApi(): Promise<void> {
    try {
      // 动态获取可用的API域名
      const { host } = await getHost();
      this.apiUrl = `${host}/api/config/query?key=bluecode-cli.model-list`;

      // console.log('[模型配置] 使用API地址:', this.apiUrl ? '***' : undefined);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

      const response = await fetch(this.apiUrl, {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result: ApiResponse = await response.json();

      if (result.code === '200') {
        let modelData;

        // 处理data字段，可能是数组或JSON字符串
        if (Array.isArray(result.data)) {
          modelData = result.data;
        } else if (typeof result.data === 'string') {
          try {
            modelData = JSON.parse(result.data);
          } catch (parseError) {
            throw new Error('API返回的data字段JSON解析失败');
          }
        } else {
          throw new Error('API返回的data字段格式不正确');
        }

        if (Array.isArray(modelData)) {
          this.modelList = modelData;
          // console.log(`\n从API成功获取 ${modelData.length} 个模型配置`);
        } else {
          throw new Error('解析后的data不是数组格式');
        }
      } else {
        throw new Error(result.msg || '获取模型列表失败');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('API请求超时');
      }
      console.error('从API获取模型配置失败:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 选择默认模型
   */
  // private selectDefaultModel(): void {
  //   // 获取可用模型列表
  //   const availableModels = this.getAvailableModels();

  //   if (availableModels.length === 0) {
  //     console.warn('没有可用的模型');
  //     return;
  //   }

  //   // 选择第一个可用模型作为默认模型
  //   this.currentModel = availableModels[0];
  //   console.log(`默认选择模型: ${this.currentModel.name}`);
  // }

  /**
   * 获取可用模型列表（enabled=1且按order排序，根据用户权限过滤）
   *
   * 新的访问控制逻辑：
   * 1. 公开模型（isPublic=true） → 所有用户可访问
   * 2. 私有模型（isPublic=false） → 仅users列表中的用户可访问
   * 3. 无isPublic字段 → 默认为公开模型（向后兼容）
   */
  public getAvailableModels(): ModelConfig[] {
    return this.modelList
      .filter((model) => {
        // 1. 基础过滤：必须启用
        if (model.enabled !== 1) {
          return false;
        }

        // 2. 向后兼容：没有isPublic字段默认为公开模型
        if (model.isPublic === undefined) {
          return true;
        }

        // 3. 公开模型：所有人可访问
        if (model.isPublic === true) {
          return true;
        }

        // 4. 私有模型访问控制
        if (model.isPublic === false) {
          // 4a. 如果没有users字段或为空数组，拒绝访问
          if (!model.users || !Array.isArray(model.users) || model.users.length === 0) {
            return false;
          }
          
          // 4b. 检查当前用户是否在该模型的用户列表中
          if (!this.currentUserId) {
            return false;
          }
          
          return model.users.includes(Number(this.currentUserId));
        }

        return false;
      })
      .sort((a, b) => a.order - b.order);
  }

  /**
   * 根据认证类型分组获取模型
   */
  public getModelsByAuthType(authType: string): ModelConfig[] {
    return this.getAvailableModels().filter(
      (model) => model.authType === authType,
    );
  }

  /**
   * 获取所有认证类型
   */
  public getAuthTypes(): string[] {
    const authTypes = new Set(
      this.getAvailableModels().map((model) => model.authType),
    );
    return Array.from(authTypes);
  }

  /**
   * 获取当前选中的模型
   */
  public getCurrentModel(): ModelConfig | null {
    return this.currentModel;
  }

  /**
   * 设置当前模型
   */
  public setCurrentModel(modelId: string): boolean {
    const model = this.getAvailableModels().find((m) => m.id === modelId);
    if (model) {
      this.currentModel = model;
      return true;
    }
    console.warn(`未找到模型: ${modelId}`);
    return false;
  }

  /**
   * 根据id获取模型配置
   */
  public getModelById(id: string): ModelConfig | undefined {
    return this.modelList.find((model) => model.id === id);
  }

  /**
   * 获取模型的认证类型显示名称
   */
  public getAuthTypeDisplayName(authType: string): string {
    const authTypeMap: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
    };
    return authTypeMap[authType] || authType;
  }

  /**
   * 检查模型是否需要API密钥
   */
  public isApiKeyRequired(model: ModelConfig): boolean {
    return (
      model.config.apiKey !== 'CUSTOM_LLM_API_KEY' &&
      model.config.apiKey !== 'OPENAI_API_KEY' &&
      model.config.apiKey !== 'ANTHROPIC_API_KEY'
    );
  }

  /**
   * 获取模型的token配置信息
   */
  public getModelTokenConfig(modelId: string): {
    contextWindowTokenSize?: number;
    maxOutputTokenSize?: number;
    maxInputTokenSize?: number;
  } | null {
    const model = this.getModelById(modelId);
    if (!model) {
      return null;
    }

    return {
      contextWindowTokenSize: model.contextWindowTokenSize,
      maxOutputTokenSize: model.maxOutputTokenSize,
      maxInputTokenSize: model.maxInputTokenSize,
    };
  }

  /**
   * 检查模型是否有完整的token配置
   */
  public hasTokenConfig(modelId: string): boolean {
    const config = this.getModelTokenConfig(modelId);
    return !!(config?.contextWindowTokenSize && config?.maxOutputTokenSize);
  }
}

// 导出单例实例
export const modelConfigManager = ModelConfigManager.getInstance();

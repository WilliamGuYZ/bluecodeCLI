/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 模型工具类 - 核心模型管理功能
 * 
 * 这个文件是整个应用的模型管理核心，负责：
 * 
 * 🔧 **核心功能**:
 * - 动态模型配置管理（API + 本地文件双重支持）
 * - 模型切换和状态管理
 * - 环境变量设置和清理
 * - 认证类型转换和配置刷新
 * 
 * 🏗️ **架构设计**:
 * - 使用适配器模式包装 modelConfigManager
 * - 提供统一的异步接口供UI组件使用
 * - 支持多种认证类型（OpenAI、Anthropic、自定义LLM等）
 * 
 * 🔄 **工作流程**:
 * 1. 应用启动时初始化模型配置（从API或本地文件）
 * 2. 用户通过 /model 命令选择模型
 * 3. 系统切换模型并更新所有相关配置
 * 4. 持久化用户选择到设置文件
 * 
 * 📝 **重要说明**:
 * - 所有函数都是异步的，确保模型配置已初始化
 * - 环境变量管理确保不同模型间无配置冲突
 * - 支持优雅降级：API失败时自动使用本地配置
 */

import { Config, AuthType } from '@vivo/bluecode-cli-core';
import { SettingScope } from '../../config/settings.js';
import { modelConfigManager, ModelConfig } from '../../config/modelConfig.js';
import { CLIModelConfigBridge } from '../../config/modelConfigBridge.js';

/**
 * 模型配置初始化状态标志
 * 确保模型配置只初始化一次，避免重复的API调用
 */
let isModelConfigInitialized = false;

/**
 * 确保模型配置已初始化
 * 这是一个关键函数，负责：
 * 1. 检查是否已初始化，避免重复初始化
 * 2. 调用 modelConfigManager.initialize() 从API或本地文件加载配置
 * 3. 处理初始化失败的情况
 */
async function ensureModelConfigInitialized() {
  if (!isModelConfigInitialized) {
    try {
      await modelConfigManager.initialize();
      isModelConfigInitialized = true;
    } catch (error) {
      console.error('模型配置初始化失败:', error);
      throw error;
    }
  }
}

/**
 * 当前选中的模型ID
 * 用于在UI层面跟踪用户选择的模型，与modelConfigManager中的currentModel配合使用
 */
let currentSelectedModelId: string | null = null;

/**
 * 动态模型配置代理对象
 * 这是一个适配器模式的实现，将API获取的模型配置包装成统一的接口
 * 主要功能：
 * 1. 代理所有对 modelConfigManager 的调用
 * 2. 维护UI层面的当前选中模型状态
 * 3. 提供统一的模型操作接口
 */
const dynamicModelConfig = {
  /**
   * 获取所有可用模型列表
   * 返回已启用且按order排序的模型
   */
  getAvailableModels: () => {
    return modelConfigManager.getAvailableModels();
  },
  
  /**
   * 获取当前模型
   * 优先返回UI层面选中的模型，否则返回配置管理器中的当前模型
   */
  getCurrentModel: () => {
    if (currentSelectedModelId) {
      return modelConfigManager.getModelById(currentSelectedModelId) || modelConfigManager.getCurrentModel();
    }
    return modelConfigManager.getCurrentModel();
  },
  
  /**
   * 设置当前模型
   * 同时更新UI层面的选中状态和配置管理器中的当前模型
   */
  setCurrentModel: (id: string) => {
    console.log(`切换到模型: ${id}`);
    currentSelectedModelId = id;
    return modelConfigManager.setCurrentModel(id);
  },
  
  /**
   * 根据认证类型获取模型列表
   */
  getModelsByAuthType: (authType: string) => {
    return modelConfigManager.getModelsByAuthType(authType);
  },
  
  /**
   * 获取所有认证类型
   */
  getAuthTypes: () => {
    return modelConfigManager.getAuthTypes();
  },
  
  /**
   * 获取认证类型的显示名称
   */
  getAuthTypeDisplayName: (authType: string) => {
    return modelConfigManager.getAuthTypeDisplayName(authType);
  },
  
  /**
   * 根据ID获取模型配置
   */
  getModelById: (id: string) => {
    return modelConfigManager.getModelById(id);
  }
};

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  authType?: string;
  available?: boolean;
  current?: boolean;
}

/**
 * 获取可用模型列表
 * 这是一个核心函数，负责：
 * 1. 确保模型配置已初始化
 * 2. 从配置管理器获取可用模型
 * 3. 转换为UI组件需要的格式
 * 4. 标记当前选中的模型
 * 
 * @param config 可选的配置对象（暂未使用）
 * @returns Promise<ModelOption[]> UI组件使用的模型选项数组
 */
export async function getAvailableModels(config?: Config): Promise<ModelOption[]> {
  await ensureModelConfigInitialized();
  const models = dynamicModelConfig.getAvailableModels();
  const currentModel = dynamicModelConfig.getCurrentModel();
  
  return models.map((model: ModelConfig) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    authType: model.authType,
    available: true, // 从配置管理器获取的都是可用的
    current: currentModel?.id === model.id
  }));
}

/**
 * 按认证类型分组获取模型
 * 这个函数为ModelDialog组件提供分组显示的数据
 * 
 * 主要功能：
 * 1. 确保模型配置已初始化
 * 2. 获取所有认证类型
 * 3. 按认证类型分组模型
 * 4. 转换为UI组件格式并标记当前模型
 * 
 * @returns Promise<Record<string, ModelOption[]>> 按认证类型分组的模型字典
 */
export async function getModelsByAuthType(): Promise<Record<string, ModelOption[]>> {
  await ensureModelConfigInitialized();
  const authTypes = dynamicModelConfig.getAuthTypes();
  const result: Record<string, ModelOption[]> = {};
  const currentModel = dynamicModelConfig.getCurrentModel();
  
  authTypes.forEach((authType: string) => {
    const models = dynamicModelConfig.getModelsByAuthType(authType);
    result[authType] = models.map((model: ModelConfig) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      authType: model.authType,
      available: true,
      current: currentModel?.id === model.id
    }));
  });
  
  return result;
}

/**
 * 获取认证类型的显示名称
 * 将内部的认证类型标识转换为用户友好的显示名称
 * 
 * @param authType 认证类型标识（如 'openai', 'anthropic'）
 * @returns string 显示名称（如 'OpenAI', 'Anthropic'）
 */
export function getAuthTypeDisplayName(authType: string): string {
  return dynamicModelConfig.getAuthTypeDisplayName(authType);
}

/**
 * 设置模型对应的环境变量
 * 这是一个关键函数，负责根据选中的模型配置设置相应的环境变量
 * 不同的认证类型需要设置不同的环境变量组合
 * 
 * 支持的认证类型：
 * - openai: 设置 OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
 * - anthropic: 设置 ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL  
 * 
 * @param modelConfig 模型配置对象
 */
function setEnvironmentVariablesForModel(modelConfig: any): void {
  if (!modelConfig || !modelConfig.config) {
    console.error('Invalid model config for setting environment variables');
    return;
  }
  
  // 清除之前的环境变量，避免不同模型间的配置冲突
  clearModelEnvironmentVariables();

  const { authType, config: modelConf } = modelConfig;
  switch (authType) {
    case 'openai':
      if (modelConf.apiKey) {
        process.env['OPENAI_API_KEY'] = modelConf.apiKey;
      }
      if (modelConf.baseUrl) {
        process.env['OPENAI_BASE_URL'] = modelConf.baseUrl;
      }
      if (modelConf.model) {
        process.env['OPENAI_MODEL'] = modelConf.model;
      }
      break;
      
    case 'anthropic':
      if (modelConf.apiKey) {
        process.env['ANTHROPIC_API_KEY'] = modelConf.apiKey;
      }
      if (modelConf.baseUrl) {
        process.env['ANTHROPIC_BASE_URL'] = modelConf.baseUrl;
      }
      if (modelConf.model) {
        process.env['ANTHROPIC_MODEL'] = modelConf.model;
      }
      break;
      
    default:
      console.warn(`[ENV VARS] Unknown authType: ${authType}`);
  }
}

/**
 * 清除模型相关的环境变量
 * 在切换模型前清除所有相关环境变量，避免配置冲突
 * 
 * 清除的环境变量包括：
 * - OpenAI相关: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL等
 * - Anthropic相关: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
 * - 自定义LLM相关: CUSTOM_LLM_API_KEY, CUSTOM_LLM_BASE_URL, CUSTOM_LLM_MODEL
 * - 通用: DEFAULT_MODEL
 */
function clearModelEnvironmentVariables(): void {
  // OpenAI
  delete process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_BASE_URL'];
  delete process.env['OPENAI_MODEL'];
  delete process.env['OPENAI_ORGANIZATION'];
  delete process.env['OPENAI_PROJECT'];
  
  // Anthropic
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_BASE_URL'];
  delete process.env['ANTHROPIC_MODEL'];
  
  // Custom LLM
  delete process.env['CUSTOM_LLM_API_KEY'];
  delete process.env['CUSTOM_LLM_BASE_URL'];
  delete process.env['CUSTOM_LLM_MODEL'];
  
  // 也清除DEFAULT_MODEL，让新模型生效
  delete process.env['DEFAULT_MODEL'];
}

/**
 * 切换到指定的模型
 * 
 * @param modelId 模型ID
 * @param config 配置对象
 * @param settings 设置对象
 * @returns Promise<boolean> 切换是否成功
 */
export async function switchToModel(modelId: string, config: Config, settings: any): Promise<boolean> {
  try {
    console.log(`[SWITCH MODEL] Starting switch to model: ${modelId}`);
    console.log(`[SWITCH MODEL] Current authType before switch: ${config.getContentGeneratorConfig()?.authType}`);
    
    await ensureModelConfigInitialized();
    const success = dynamicModelConfig.setCurrentModel(modelId);
    if (success) {
      // 同时更新config中的模型
      const modelConfig = dynamicModelConfig.getModelById(modelId);
      if (modelConfig && modelConfig.config) {
        console.log(`[SWITCH MODEL] Target model config - authType: ${modelConfig.authType}, model: ${modelConfig.config.model}`);
        
        // 始终设置环境变量，确保 refreshAuth 能正确读取配置
        setEnvironmentVariablesForModel(modelConfig);
        
        // 优先尝试直接传递ModelConfig到Core包
        const modelConfigSet = CLIModelConfigBridge.safeSetModelConfig(config, modelConfig);
        console.log(`[SWITCH MODEL] ModelConfig set via bridge: ${modelConfigSet}`);
        
        config.setModel(modelConfig.config.model);
        config.setCustomData("modelName", modelConfig.name);
        process.env['DEFAULT_MODEL'] = modelConfig.config.model; // 更新DEFAULT_MODEL环境变量，供其他组件使用
        // 更新Config认证类型，确保使用正确的API适配器
        const newAuthType = modelConfig.authType;
        try {
          let authTypeEnum: AuthType; // 将字符串认证类型转换为AuthType枚举
          switch (newAuthType) {
            case 'openai':
              authTypeEnum = AuthType.USE_OPENAI;
              break;
            case 'anthropic':
              authTypeEnum = AuthType.USE_ANTHROPIC;
              break;
            case 'anthropic-claude':
              authTypeEnum = AuthType.USE_ANTHROPIC;
              break;
            case 'gemini':
              authTypeEnum = AuthType.USE_GEMINI;
              break;
            case 'vertex-ai':
              authTypeEnum = AuthType.USE_VERTEX_AI;
              break;
            case 'cloud-shell':
              authTypeEnum = AuthType.CLOUD_SHELL;
              break;
            case 'oauth-personal':
              authTypeEnum = AuthType.LOGIN_WITH_GOOGLE;
              break;
            default:
              console.warn(`Unknown authType: ${newAuthType}, skipping config refresh`);
              return false;
          }
          
          console.log(`[CONFIG REFRESH] Refreshing auth config from ${config.getContentGeneratorConfig()?.authType} to ${authTypeEnum}`);
          await config.refreshAuth(authTypeEnum);
          console.log(`[CONFIG REFRESH] Auth config refreshed successfully to ${config.getContentGeneratorConfig()?.authType}`);
        } catch (error) {
          console.error(`[CONFIG REFRESH] Failed to refresh auth config:`, error);
          // 如果认证刷新失败，则模型切换失败
          return false;
        }
        
        // 如果提供了设置对象，持久化用户的选择
        if (settings && settings.setValue) {
          try {
            // 使用正确的SettingScope枚举保存用户级别的设置
            settings.setValue(SettingScope.User, 'selectedAuthType', newAuthType);
            settings.setValue(SettingScope.User, 'selectedModelId', modelId);
          } catch (error) {
            console.error('Error updating selectedAuthType/selectedModelId:', error);
          }
        } else {
          console.error('Settings object or setValue method not available for selectedAuthType/selectedModelId update');
        }
      }
    }
    
    console.log(`[SWITCH MODEL] Switch completed successfully: ${success}`);
    console.log(`[SWITCH MODEL] Final authType after switch: ${config.getContentGeneratorConfig()?.authType}`);
    return success;
  } catch (error) {
    console.error('[SWITCH MODEL] Failed to switch model:', error);
    return false;
  }
}

/**
 * 获取当前模型信息
 * 返回当前选中模型的详细信息，格式化为UI组件使用的格式
 * 
 * @param config 可选的配置对象（暂未使用）
 * @returns Promise<ModelOption | null> 当前模型信息或null
 */
export async function getCurrentModel(config?: Config): Promise<ModelOption | null> {
  await ensureModelConfigInitialized();
  const currentModel = dynamicModelConfig.getCurrentModel();
  if (!currentModel) return null;

  return {
    id: currentModel.id,
    name: currentModel.name,
    description: currentModel.description,
    authType: currentModel.authType,
    available: true,
    current: true
  };
}

/**
 * 根据ID获取模型信息
 * 查找指定ID的模型并返回格式化的模型信息
 * 
 * @param modelId 模型ID
 * @returns Promise<ModelOption | undefined> 模型信息或undefined（如果未找到）
 */
export async function getModelById(modelId: string): Promise<ModelOption | undefined> {
  await ensureModelConfigInitialized();
  const model = dynamicModelConfig.getModelById(modelId);
  if (!model) return undefined;
  
  const currentModel = dynamicModelConfig.getCurrentModel();
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    authType: model.authType,
    available: true,
    current: currentModel?.id === model.id
  };
}

/**
 * 根据认证类型获取模型显示名称
 * 如果不提供认证类型，返回当前模型的名称
 * 
 * @param authType 可选的认证类型
 * @returns string 模型显示名称
 */
export function getModelDisplayName(authType?: string): string {
  if (!authType) {
    const currentModel = dynamicModelConfig.getCurrentModel();
    return currentModel ? currentModel.name : 'Unknown Model';
  }
  
  const models = dynamicModelConfig.getModelsByAuthType(authType);
  return models.length > 0 ? models[0].name : 'Unknown Model';
}

/**
 * 初始化默认模型环境变量
 * 专门用于 gemini.tsx 的同步初始化，设置默认模型的环境变量
 * 
 * 主要功能：
 * 1. 获取优先级最高的可用模型（按order排序）
 * 2. 设置对应的环境变量
 * 3. 返回模型信息供调用者使用
 * 
 * @returns Promise<{authType: string, model: string} | null> 默认模型信息或null
 */
export async function initializeDefaultModelEnvironment(): Promise<{ authType: string; model: string } | null> {
  try {
    await ensureModelConfigInitialized();
    // 获取排序第一的模型作为默认模型
    const availableModels = dynamicModelConfig.getAvailableModels();
    if (availableModels.length === 0) {
      console.log('No available models found for environment initialization');
      return null;
    }

    const defaultModel = availableModels[0]; // 已经按order排序
    console.log(`[ENV INIT] Setting default model: ${defaultModel.name} (${defaultModel.authType})`);

    // 设置对应的环境变量
    setEnvironmentVariablesForModel(defaultModel);
    
    return {
      authType: defaultModel.authType,
      model: defaultModel.config.model
    };
  } catch (error) {
    console.error('Failed to initialize default model environment:', error);
    return null;
  }
}

/**
 * 从设置中初始化当前模型ID
 * 读取用户设置中保存的模型ID，并设置为当前选中模型
 * 
 * @param settings 设置对象，包含用户的模型选择
 */
export function initializeCurrentModelFromSettings(settings: any): void {
  const selectedModelId = settings.merged?.selectedModelId;
  if (selectedModelId) {
    currentSelectedModelId = selectedModelId;
    console.log(`Initialized current model ID from settings: ${selectedModelId}`);
  }
}

/**
 * 初始化默认模型和认证类型
 * 这是应用启动时的关键初始化函数，负责：
 * 1. 检查用户是否已有模型选择
 * 2. 如果有，使用用户选择的模型
 * 3. 如果没有，选择优先级最高的默认模型
 * 4. 设置相应的环境变量和配置
 * 
 * @param config 配置对象
 * @param settings 设置对象
 * @returns Promise<boolean> 初始化是否成功
 */
export async function initializeDefaultModel(config: Config, settings: any): Promise<boolean> {
  try {
    await ensureModelConfigInitialized();
    // 检查是否已有selectedAuthType
    const currentAuthType = settings.merged?.security?.auth?.selectedType;
    if (currentAuthType) {
      // console.log(`\nAlready have selectedAuthType: ${currentAuthType}`);
      
      // 检查是否有selectedModelId
      const selectedModelId = settings.merged?.selectedModelId;
      if (selectedModelId) {
        // 使用指定的模型ID
        const availableModels = dynamicModelConfig.getAvailableModels();
        const selectedModel = availableModels.find((m: ModelConfig) => m.id === selectedModelId);
        
        if (selectedModel && selectedModel.config) {
          // console.log(`Using selected model: ${selectedModel.name}`);
          currentSelectedModelId = selectedModelId; // 更新当前选中的模型ID
          
          // 优先尝试直接传递ModelConfig到Core包
          CLIModelConfigBridge.safeSetModelConfig(config, selectedModel);
          // 回退到环境变量方式
          setEnvironmentVariablesForModel(selectedModel);
          
          config.setModel(selectedModel.config.model);
          config.setCustomData("modelName", selectedModel.name);
          // 设置DEFAULT_MODEL环境变量
          process.env['DEFAULT_MODEL'] = selectedModel.config.model;
          return true;
        } else {
          console.log(`Selected model '${selectedModelId}' not found or invalid config, falling back to default for authType`);
        }
      }
      
      // 如果没有selectedModelId或找不到对应模型，则使用order排序优先级最高的模型
      const availableModels = dynamicModelConfig.getAvailableModels();

      let currentModel = null;
      let needsAuthTypeUpdate = false;
      
      // 获取所有匹配的authType的模型，并按order排序选择优先级最高的
      const matchingModels = availableModels.filter((m: ModelConfig) => m.authType === currentAuthType);
      if (matchingModels.length > 0) {
        // 按order排序，选择order最小的（优先级最高的）
        currentModel = matchingModels.sort((a: ModelConfig, b: ModelConfig) => a.order - b.order)[0];
      } else if (availableModels.length > 0) {
        console.log(`No models found for authType: ${currentAuthType}, use default type.`);
        currentModel = availableModels.sort((a: ModelConfig, b: ModelConfig) => a.order - b.order)[0];
        needsAuthTypeUpdate = true; // 标记需要更新authType
      } 
      
      if (currentModel && currentModel.config) {
        // console.log(`Setting environment variables for existing model: ${currentModel.name}`);
        currentSelectedModelId = currentModel.id; // 更新当前选中的模型ID
        
        // 优先尝试直接传递ModelConfig到Core包
        const modelConfigSet = CLIModelConfigBridge.safeSetModelConfig(config, currentModel);
        if(modelConfigSet){
          config.setModel(currentModel.config.model);
          config.setCustomData("modelName", currentModel.name);
        }
        
        // 将key打入环境变量，适配器从这里面读取的key
        setEnvironmentVariablesForModel(currentModel);
        // 设置DEFAULT_MODEL环境变量
        process.env['DEFAULT_MODEL'] = currentModel.config.model;
        if (settings && settings.setValue) {
          try {
            // 如果需要更新authType（因为原authType没有可用模型），则同时更新
            if (needsAuthTypeUpdate) {
              settings.setValue(SettingScope.User, 'selectedAuthType', currentModel.authType);
              console.log(`Updated selectedAuthType from ${currentAuthType} to ${currentModel.authType}`);
            }
            settings.setValue(SettingScope.User, 'selectedModelId', currentModel.id);
          } catch (error) {
            console.error('Error updating selectedAuthType/selectedModelId:', error);
          }
        }
      } else {
        console.log(`No models to use for authType: ${currentAuthType}`);
      }
      return true;
    }

    // 获取所有可用模型并按order排序，选择优先级最高的作为默认模型
    const availableModels = dynamicModelConfig.getAvailableModels();
    if (availableModels.length === 0) {
      console.log('No available models found');
      return false;
    }

    // 按order排序，选择order最小的（优先级最高的）作为默认模型
    const sortedModels = availableModels.sort((a: ModelConfig, b: ModelConfig) => a.order - b.order);
    const defaultModel = sortedModels[0];
    // console.log(`\nFound ${availableModels.length} available models, selected default: ${defaultModel.name} (order: ${defaultModel.order})`);

    // 设置默认的authType
    // console.log('Settings object:', settings);
    // console.log('Settings.setValue method:', typeof settings?.setValue);
    
    if (settings && settings.setValue) {
      try {
        // 初始化过程中，会从接口返回的 defaultModel.authType 设置 selectedAuthType
        settings.setValue(SettingScope.User, 'selectedAuthType', defaultModel.authType);
        settings.setValue(SettingScope.User, 'selectedModelId', defaultModel.id);
        // console.log(`Set default selectedAuthType to: ${defaultModel.authType}`);
        
        // 验证设置是否成功
        // setTimeout(() => {
        //   console.log('Verification - selectedAuthType after setting:', settings.merged?.selectedAuthType);
        // }, 100);
      } catch (error) {
        console.error('Error setting selectedAuthType:', error);
      }
    } else {
      console.error('Settings object or setValue method not available');
      console.error('Settings:', settings);
      console.error('setValue type:', typeof settings?.setValue);
    }

    // 设置默认的model
    if (defaultModel.config) {
      currentSelectedModelId = defaultModel.id; // 更新当前选中的模型ID
      
      // 优先尝试直接传递ModelConfig到Core包
      const modelConfigSet = CLIModelConfigBridge.safeSetModelConfig(config, defaultModel);
      if (!modelConfigSet) {
        // 回退到环境变量方式
        setEnvironmentVariablesForModel(defaultModel);
      }
      
      config.setModel(defaultModel.config.model);
      config.setCustomData("modelName", defaultModel.name);
      // 设置对应的环境变量
      setEnvironmentVariablesForModel(defaultModel);
      
      // 设置DEFAULT_MODEL环境变量
      process.env['DEFAULT_MODEL'] = defaultModel.config.model;
    }

    return true;
  } catch (error) {
    console.error('Failed to initialize default model:', error);
    return false;
  }
}
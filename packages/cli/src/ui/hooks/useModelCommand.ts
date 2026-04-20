/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { AuthType, Config } from '@vivo/bluecode-cli-core';
import { switchToModel } from '../utils/modelUtils.js';
import { HistoryItem, MessageType } from '../types.js';

/**
 * 模型命令的自定义Hook
 * 
 * 这个Hook管理模型对话框的状态和模型切换逻辑
 * 参考了useThemeCommand和useAuthCommand的实现模式
 */
export function useModelCommand(
  addItem: (item: HistoryItem, timestamp: number) => void,  // 用于向历史记录添加消息的函数
  config: Config,                                           // 配置对象
  settings?: any,                                           // 设置对象，用于更新selectedAuthType
  currentAuthType?: AuthType                                // 当前的认证类型，用于确定当前使用的模型
) {
  // 模型对话框的开关状态 - 控制对话框是否显示
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  
  // 模型切换过程中的加载状态 - 用于显示"正在切换"的提示
  const [isModelSwitching, setIsModelSwitching] = useState(false);

  /**
   * 打开模型对话框
   * 
   * 这个函数会被传递给slashCommandProcessor，
   * 当用户输入/model命令时会被调用
   */
  const openModelDialog = useCallback(() => {
    setIsModelDialogOpen(true);  // 设置对话框状态为打开
  }, []);

  /**
   * 关闭模型对话框
   * 
   * 当用户按ESC键或选择完模型后会被调用
   */
  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);  // 设置对话框状态为关闭
  }, []);

  /**
   * 处理模型选择
   * 
   * @param modelId - 选中的模型ID
   */
  /**
   * 处理模型选择的核心逻辑
   * 
   * 这个函数在用户在ModelDialog中选择模型时被调用
   * 它负责执行实际的模型切换并提供用户反馈
   */
  const handleModelSelect = useCallback(async (modelId: string) => {
    setIsModelSwitching(true);  // 显示加载状态
    
    try {
      // 调用模型切换逻辑，传递settings以更新authType
      const success = await switchToModel(modelId, config, settings);
      
      if (success) {
        // 切换成功，向聊天历史添加成功消息
        addItem(
          {
            type: MessageType.INFO,
            text: `Successfully switched to model: ${modelId}`,
          } as HistoryItem,
          Date.now()
        );
        
        // 关闭对话框，返回到正常聊天界面
        closeModelDialog();
      } else {
        // 切换失败，显示错误消息但保持对话框打开
        addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to switch to model: ${modelId}`,
          } as HistoryItem,
          Date.now()
        );
      }
    } catch (error) {
      // 处理异常情况（网络错误、权限问题等）
      addItem(
        {
          type: MessageType.ERROR,
          text: `Error switching model: ${error instanceof Error ? error.message : String(error)}`,
        } as HistoryItem,
        Date.now()
      );
    } finally {
      setIsModelSwitching(false);  // 无论成功失败都要隐藏加载状态
    }
  }, [currentAuthType, addItem, closeModelDialog]);

  // 返回所有需要的状态和函数，供App.tsx使用
  return {
    isModelDialogOpen,    // 对话框是否打开的状态
    isModelSwitching,     // 是否正在切换模型的状态
    openModelDialog,      // 打开对话框的函数
    closeModelDialog,     // 关闭对话框的函数
    handleModelSelect,    // 处理模型选择的函数
  };
}

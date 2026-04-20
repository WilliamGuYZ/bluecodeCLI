/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 模型选择对话框组件
 * 
 * 这个组件提供了一个交互式的用户界面，让用户可以：
 * 1. 查看所有可用的AI模型（按认证类型分组）
 * 2. 看到哪些模型可用/不可用
 * 3. 选择并切换到不同的模型
 * 4. 使用键盘进行导航和选择
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getModelsByAuthType, switchToModel, getAuthTypeDisplayName, ModelOption } from '../utils/modelUtils.js';
import { Config } from '@vivo/bluecode-cli-core';
import { Colors } from '../colors.js';
/**
 * ModelDialog组件的属性接口
 */
interface ModelDialogProps {
  onClose: () => void;              // 关闭对话框的回调函数
  config: Config;                   // 配置对象
  settings?: any;                   // 设置对象，用于更新selectedAuthType
}

/**
 * ModelDialog 主组件
 * 
 * @param onClose - 关闭对话框的函数
 * @param config - 配置对象
 * @returns React组件
 */
export function ModelDialog({ onClose, config, settings }: ModelDialogProps): React.ReactElement {
  // 状态管理：存储扁平化的模型列表（包含分组标题）
  const [flatModels, setFlatModels] = useState<ModelOption[]>([]);

  // 状态管理：当前选中的模型索引（用于键盘导航）
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 状态管理：是否正在切换模型（显示加载状态）
  const [isLoading, setIsLoading] = useState(false);

  /**
   * 组件初始化和更新效果
   * 
   * 当组件挂载时：
   * 1. 获取按认证类型分组的模型列表
   * 2. 扁平化处理，插入分组标题
   * 3. 找到当前正在使用的模型并定位
   */
  useEffect(() => {
    const loadModels = async () => {
      try {
        const modelsByAuthType = await getModelsByAuthType();
        const flattened = ([] as ModelOption[]).concat(
          ...Object.values(modelsByAuthType)
        );
        setFlatModels(flattened);
        // 当前模型
        const currentModelIndex = flattened.findIndex(m => m.current);
        // 设置选中索引到当前模型，如果没有找到则默认为第一个非标题项
        if (currentModelIndex >= 0) {
          setSelectedIndex(currentModelIndex);
        } else {
          // 找到第一个非分组标题的项目
          // const firstModelIndex = flattened.findIndex(item => !item.isGroupHeader);
          setSelectedIndex(0);
        }
      } catch (error) {
        console.error('Failed to load models in ModelDialog:', error);
      }
    };
    loadModels();
  }, []);

  /**
   * 获取下一个可选择的模型索引
   */
  const getNextSelectableIndex = (currentIndex: number, direction: 'up' | 'down'): number => {
    const step = direction === 'up' ? -1 : 1;
    let nextIndex = currentIndex + step;
    if (nextIndex < 0) {
      nextIndex = flatModels.length - 1;
    } else if (nextIndex >= flatModels.length) {
      nextIndex = 0;
    }
    return nextIndex;
  };

  /**
   * 键盘输入处理器
   */
  useInput(async (input, key) => {
    // ESC键：取消操作，关闭对话框
    if (key.escape) {
      onClose();
      return;
    }

    // 上箭头：向上移动到下一个可选择的模型
    if (key.upArrow) {
      const nextIndex = getNextSelectableIndex(selectedIndex, 'up');
      setSelectedIndex(nextIndex);
      return;
    }

    // 下箭头：向下移动到下一个可选择的模型
    if (key.downArrow) {
      const nextIndex = getNextSelectableIndex(selectedIndex, 'down');
      setSelectedIndex(nextIndex);
      return;
    }

    // 回车键：确认选择当前高亮的模型
    if (key.return) {
      const selectedModel = flatModels[selectedIndex];

      // 检查是否为分组标题或不可用模型
      if (!selectedModel.available) {
        return;
      }

      // 显示加载状态
      setIsLoading(true);

      // 尝试切换到选中的模型
      const success = await switchToModel(selectedModel.id, config, settings);

      // 隐藏加载状态
      setIsLoading(false);

      // 如果切换成功，关闭对话框
      if (success) {
        onClose();
      }
      return;
    }
  });

  /**
   * 组件渲染函数
   */
  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor={Colors.Gray}
    >
      {/* 对话框标题 */}
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentPurple}>{'> '}选择模型</Text>
      </Box>

      {/* 条件渲染：加载状态 vs 模型列表 */}
      {isLoading ? (
        // 加载状态：显示切换进度
        <Box>
          <Text color="yellow">正在切换模型...</Text>
        </Box>
      ) : (
        // 正常状态：显示模型列表和操作说明
        <>
          {/* 模型列表 */}
          <Box flexDirection="column">
            {flatModels.map((item, index) => {
              // 渲染模型选项
              const isSelected = selectedIndex === index;
              const isAvailable = item.available;
              const isCurrent = item.current;

              let numberColor = Colors.Foreground;
              if (isSelected) {
                numberColor = Colors.AccentGreen;
              } else if (!isAvailable) {
                numberColor = Colors.Gray;
              }
              
              const numberColumnWidth = String(flatModels.length).length;
              const itemNumberText = `${String(index + 1).padStart(
                numberColumnWidth,
              )}.`;
              return (
                <Box key={item.id} alignItems="center">
                  <Box minWidth={2} flexShrink={0}>
                    <Text color={isSelected ? Colors.AccentGreen : Colors.Foreground}>
                      {isSelected ? '●' : ' '}
                    </Text>
                  </Box>
                  <Box
                    marginRight={1}
                    flexShrink={0}
                    minWidth={itemNumberText.length}
                  >
                    <Text color={numberColor}>{itemNumberText}</Text>
                  </Box>
                  <Text
                    color={!isAvailable ? 'gray' : isSelected ? Colors.AccentGreen : Colors.Foreground
                    }
                  >
                    {item.name}
                    {item.description ? ` - ${item.description}` : ''}
                    {isCurrent ? ' (当前)' : ''}
                    {!isAvailable ? ' (不可用)' : ''}
                  </Text>
                </Box>
              );
            }
            )}
          </Box>

          {/* 操作说明区域 */}
          <Box marginTop={1} flexDirection="column">
            <Text color={Colors.Gray}>
              （使用 ↑↓ 导航，使用 Enter 选择，使用 ESC 取消）
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
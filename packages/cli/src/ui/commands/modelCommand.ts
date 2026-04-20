/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, OpenDialogActionReturn, SlashCommand } from './types.js';

/**
 * 模型切换命令定义
 * 
 * 这个文件定义了 /model 和 /m 命令的基本信息和行为
 * 当用户输入这些命令时，系统会知道如何处理它们
 */
export const modelCommand: SlashCommand = {
  // 命令的主要名称，用户可以输入 /model 来触发
  name: 'model',
  
  // 命令的别名，用户也可以输入 /m 来触发同样的功能
  // altNames: ['m'],
  
  // 命令的描述，会显示在 /help 命令的输出中
  description: '切换模型',
  
  // 命令类型：内置命令（区别于用户自定义命令或MCP命令）
  kind: CommandKind.BUILT_IN,
  
  /**
   * 命令的执行逻辑
   * 
   * @param _context - 命令执行上下文（当前未使用，所以用_前缀）
   * @param _args - 命令参数（当前未使用）
   * @returns OpenDialogActionReturn - 返回一个"打开对话框"的指令
   * 
   * 这个函数告诉系统：当用户输入 /model 时，应该打开一个类型为 'model' 的对话框
   */
  action: (_context, _args): OpenDialogActionReturn => ({
    type: 'dialog',        // 指示这是一个"打开对话框"的动作
    dialog: 'model',       // 指定要打开的对话框类型
  }),
};

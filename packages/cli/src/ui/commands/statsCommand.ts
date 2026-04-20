/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemStats } from '../types.js';
import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';

export const statsCommand: SlashCommand = {
  name: 'stats',
  altNames: ['usage'],
  description: '检查会话统计信息 用法：/stats [model|tools]',
  kind: CommandKind.BUILT_IN,
  action: (context: CommandContext) => {
    const now = new Date();
    const { sessionStartTime } = context.session.stats;
    if (!sessionStartTime) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Session start time is unavailable, cannot calculate stats.',
        },
        Date.now(),
      );
      return;
    }
    const wallDuration = now.getTime() - sessionStartTime.getTime();

    const statsItem: HistoryItemStats = {
      type: MessageType.STATS,
      duration: formatDuration(wallDuration),
    };

    context.ui.addItem(statsItem, Date.now());
  },
  subCommands: [
    {
      name: 'model',
      description: '显示特定模型的使用情况统计信息',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        context.ui.addItem(
          {
            type: MessageType.MODEL_STATS,
          },
          Date.now(),
        );
      },
    },
    {
      name: 'tools',
      description: '显示特定工具的使用情况统计信息.',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        context.ui.addItem(
          {
            type: MessageType.TOOL_STATS,
          },
          Date.now(),
        );
      },
    },
  ],
};

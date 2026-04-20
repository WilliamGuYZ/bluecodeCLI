/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandContext,
  SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';

export const extensionsCommand: SlashCommand = {
  name: 'extensions',
  description: '列出活动扩展',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext): Promise<void> => {
    const activeExtensions = context.services.config
      ?.getExtensions()
      .filter((ext) => ext.isActive);
    if (!activeExtensions || activeExtensions.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: '没有活动扩展',
        },
        Date.now(),
      );
      return;
    }

    const extensionLines = activeExtensions.map(
      (ext) => `  - \u001b[36m${ext.name} (v${ext.version})\u001b[0m`,
    );
    const message = `活动扩展:\n\n${extensionLines.join('\n')}\n`;

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: message,
      },
      Date.now(),
    );
  },
};

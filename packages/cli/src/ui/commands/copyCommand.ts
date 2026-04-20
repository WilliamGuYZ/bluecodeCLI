/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyToClipboard } from '../utils/commandUtils.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';

export const copyCommand: SlashCommand = {
  name: 'copy',
  description: '将最后的结果或代码片段复制到剪贴板',
  kind: CommandKind.BUILT_IN,
  action: async (context, _args): Promise<SlashCommandActionReturn | void> => {
    const chat = await context.services.config?.getGeminiClient()?.getChat();
    const history = chat?.getHistory();

    // Get the last message from the AI (model role)
    const lastAiMessage = history
      ? history.filter((item) => item.role === 'model').pop()
      : undefined;

    if (!lastAiMessage) {
      return {
        type: 'message',
        messageType: 'info',
        content: '历史记录中无输出',
      };
    }
    // Extract text from the parts
    const lastAiOutput = lastAiMessage.parts
      ?.filter((part) => part.text)
      .map((part) => part.text)
      .join('');

    if (lastAiOutput) {
      try {
        await copyToClipboard(lastAiOutput);

        return {
          type: 'message',
          messageType: 'info',
          content: '最后的输出已复制到剪贴板',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.debug(message);

        return {
          type: 'message',
          messageType: 'error',
          content: `无法复制到剪贴板. ${message}`,
        };
      }
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: '最后的 AI 输出不包含要复制的文本.',
      };
    }
  },
};

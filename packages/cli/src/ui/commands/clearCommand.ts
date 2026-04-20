/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { uiTelemetryService } from '@vivo/bluecode-cli-core';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { randomUUID } from 'node:crypto';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: '清除屏幕和对话历史记录',
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
    const geminiClient = context.services.config?.getGeminiClient();
    const config = context.services.config;

    // Generate new session ID BEFORE resetChat so the new ChatRecordingService
    // will use this new ID in its constructor
    if (config) {
      const newSessionId = randomUUID();
      config.setSessionId(newSessionId);
    }

    if (geminiClient) {
      context.ui.setDebugMessage('清除终端并重置聊天');
      // If resetChat fails, the exception will propagate and halt the command,
      // which is the correct behavior to signal a failure to the user.
      await geminiClient.resetChat();
    } else {
      context.ui.setDebugMessage('清除终端');
    }

    uiTelemetryService.resetLastPromptTokenCount();
    context.ui.clear();
  },
};

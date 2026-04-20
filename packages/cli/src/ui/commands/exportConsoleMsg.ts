/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { sessionId } from '@vivo/bluecode-cli-core';
import { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import fs from 'node:fs';
import path from 'node:path';

export const exportConsoleCommand: SlashCommand = {
  name: 'export-console',
  altNames: ['exportc'],
  kind: CommandKind.BUILT_IN,
  description: '将当前控制台消息导出到带时间戳的文件',
  action: async (context) => {
    const messages = context.ui.getConsoleMessages?.() || [];
    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .split('Z')[0];
    const fileName = `console-${timestamp}.log`;
    const filePath = path.join(process.cwd(), fileName);

    // 最后一次id
    const lastPromptId = context.services.config?.getGeminiClient().getLastPromptId() || 'unknown'
    const SessionId = context.services.config?.getSessionId() ||  'unknown'
    const exportData = {
      SessionId,
      lastPromptId,
      messages
    }
    const content = JSON.stringify(exportData, null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
    return {
      type: 'message',
      messageType: 'info',
      content: `已将 ${messages.length} 条控制台消息（prompt_id：${lastPromptId} 和 SessionId：${sessionId}）导出到 ${filePath}`,
    };
  },
};

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import open from 'open';
import process from 'node:process';
import {
  CommandContext,
  SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';

export const docsCommand: SlashCommand = {
  name: 'docs',
  description: '在浏览器中打开完整的 BlueCode CLI 文档',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext): Promise<void> => {
    const docsUrl = 'https://aicode.vivo.xyz/docs/';

    if (process.env['SANDBOX'] && process.env['SANDBOX'] !== 'sandbox-exec') {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `请在浏览器中打开以下 URL 来查看文档:\n${docsUrl}`,
        },
        Date.now(),
      );
    } else {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `在浏览器中打开文档: ${docsUrl}`,
        },
        Date.now(),
      );
      await open(docsUrl);
    }
  },
};

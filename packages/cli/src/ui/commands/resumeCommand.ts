/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /resume slash command for browsing and resuming auto-saved sessions.
 */

import type { SlashCommand, OpenDialogActionReturn } from './types.js';
import { CommandKind } from './types.js';

export const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Browse and resume auto-saved conversations',
  kind: CommandKind.BUILT_IN,

  action: (): OpenDialogActionReturn => {
    return {
      type: 'dialog',
      dialog: 'sessionBrowser',
    };
  },
};

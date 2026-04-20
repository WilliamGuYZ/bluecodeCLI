/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type OpenDialogActionReturn,
  type SlashCommand,
} from './types.js';

export const editorCommand: SlashCommand = {
  name: 'editor',
  description: '设置外部编辑器偏好',
  kind: CommandKind.BUILT_IN,
  action: (): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'editor',
  }),
};

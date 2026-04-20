/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resumeCommand } from './resumeCommand.js';
import { type CommandContext, CommandKind } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('resumeCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should have the correct name and description', () => {
    expect(resumeCommand.name).toBe('resume');
    expect(resumeCommand.description).toBe(
      'Browse and resume auto-saved conversations'
    );
  });

  it('should be a built-in command', () => {
    expect(resumeCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should return a dialog action to open the session browser', () => {
    if (!resumeCommand.action) {
      throw new Error('The resume command must have an action.');
    }
    const result = resumeCommand.action(mockContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'sessionBrowser',
    });
  });
});

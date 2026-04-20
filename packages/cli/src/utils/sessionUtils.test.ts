/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  cleanMessage,
  extractFirstUserMessage,
  formatRelativeTime,
  getSessionFiles,
  getAllSessionFiles,
  SessionSelector,
  RESUME_LATEST,
  type SessionInfo,
  type SessionFileEntry,
} from './sessionUtils.js';
import type { ConversationRecord, MessageRecord } from '@vivo/bluecode-cli-core';
import type { Config } from '@vivo/bluecode-cli-core';

// Mock fs module
vi.mock('node:fs/promises');

describe('sessionUtils', () => {
  describe('cleanMessage', () => {
    it('should remove excessive whitespace', () => {
      const input = 'Hello   World\n\n  Test';
      const result = cleanMessage(input);
      expect(result).toBe('Hello World Test');
    });

    it('should trim leading and trailing whitespace', () => {
      const input = '  Hello  ';
      const result = cleanMessage(input);
      expect(result).toBe('Hello');
    });

    it('should handle empty string', () => {
      const result = cleanMessage('');
      expect(result).toBe('');
    });
  });

  describe('extractFirstUserMessage', () => {
    it('should extract first user message', () => {
      const messages: MessageRecord[] = [
        { id: 'test-msg-2', type: 'user', content: 'Hello AI', timestamp: '2024-01-01' },
        { id: 'test-msg-3', type: 'gemini', content: 'Hi there', timestamp: '2024-01-01' },
      ];
      const result = extractFirstUserMessage(messages);
      expect(result).toBe('Hello AI');
    });

    it('should truncate long messages', () => {
      const longMessage = 'a'.repeat(100);
      const messages: MessageRecord[] = [
        { id: 'test-msg-4', type: 'user', content: longMessage, timestamp: '2024-01-01' },
      ];
      const result = extractFirstUserMessage(messages);
      expect(result).toBe('a'.repeat(60) + '...');
      expect(result.length).toBe(63);
    });

    it('should handle object content', () => {
      const messages: MessageRecord[] = [
        {
          id: 'test-msg-5',
          type: 'user',
          content: { text: 'Hello' } as any,
          timestamp: '2024-01-01',
        },
      ];
      const result = extractFirstUserMessage(messages);
      expect(result).toContain('text');
    });

    it('should return "Empty session" when no user messages', () => {
      const messages: MessageRecord[] = [
        { id: 'test-msg-6', type: 'gemini', content: 'AI message only', timestamp: '2024-01-01' },
      ];
      const result = extractFirstUserMessage(messages);
      expect(result).toBe('Empty session');
    });

    it('should return "Empty session" for empty array', () => {
      const result = extractFirstUserMessage([]);
      expect(result).toBe('Empty session');
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should format time in short style', () => {
      const timestamp = new Date('2024-01-01T10:00:00Z').toISOString();
      expect(formatRelativeTime(timestamp, 'short')).toBe('2h ago');
    });

    it('should format days', () => {
      const timestamp = new Date('2023-12-30T12:00:00Z').toISOString();
      expect(formatRelativeTime(timestamp, 'short')).toBe('2d ago');
    });

    it('should format minutes', () => {
      const timestamp = new Date('2024-01-01T11:45:00Z').toISOString();
      expect(formatRelativeTime(timestamp, 'short')).toBe('15m ago');
    });

    it('should return "just now" for recent time', () => {
      const timestamp = new Date('2024-01-01T11:59:30Z').toISOString();
      expect(formatRelativeTime(timestamp, 'short')).toBe('just now');
    });

    it('should format time in long style', () => {
      const timestamp = new Date('2024-01-01T10:00:00Z').toISOString();
      expect(formatRelativeTime(timestamp, 'long')).toBe('2 hours ago');
    });

    it('should handle singular in long style', () => {
      const timestamp = new Date('2024-01-01T11:00:00Z').toISOString();
      expect(formatRelativeTime(timestamp, 'long')).toBe('1 hour ago');
    });

    it('should default to short style', () => {
      const timestamp = new Date('2024-01-01T10:00:00Z').toISOString();
      expect(formatRelativeTime(timestamp)).toBe('2h ago');
    });
  });

  describe('getAllSessionFiles', () => {
    let mockConfig: Config;

    beforeEach(() => {
      mockConfig = {
        getTmpDir: vi.fn().mockReturnValue('/tmp/test'),
      } as unknown as Config;
    });

    it('should load valid session files', async () => {
      const mockFiles = ['session-123.json', 'session-456.json'];
      const mockConversation: ConversationRecord = {
        sessionId: '123',
        projectHash: 'test-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        messages: [
          { id: 'test-msg-7', type: 'user', content: 'Hello', timestamp: '2024-01-01' },
        ],
      };

      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify(mockConversation)
      );

      const result = await getAllSessionFiles(mockConfig);

      expect(result).toHaveLength(2);
      expect(result[0].data).toEqual(mockConversation);
      expect(result[0].filePath).toContain('session-123.json');
    });

    it('should handle corrupted session files', async () => {
      const mockFiles = ['session-123.json'];
      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.readFile).mockResolvedValue('invalid json');

      const result = await getAllSessionFiles(mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0].data).toBeNull();
      expect(result[0].error).toBeDefined();
    });

    it('should return empty array when directory does not exist', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));

      const result = await getAllSessionFiles(mockConfig);

      expect(result).toEqual([]);
    });

    it('should filter non-session files', async () => {
      const mockFiles = ['session-123.json', 'other.txt', 'test.json'];
      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({}));

      const result = await getAllSessionFiles(mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0].filePath).toContain('session-123.json');
    });
  });

  describe('getSessionFiles', () => {
    let mockConfig: Config;

    beforeEach(() => {
      mockConfig = {
        getTmpDir: vi.fn().mockReturnValue('/tmp/test'),
      } as unknown as Config;
    });

    it('should return valid sessions sorted by lastUpdated', async () => {
      const mockFiles = ['session-1.json', 'session-2.json'];
      const conversation1: ConversationRecord = {
        sessionId: '1',
        projectHash: 'test-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        messages: [
          { id: 'test-msg-8', type: 'user', content: 'First', timestamp: '2024-01-01' },
        ],
      };
      const conversation2: ConversationRecord = {
        sessionId: '2',
        projectHash: 'test-hash',
        startTime: '2024-01-02T00:00:00Z',
        lastUpdated: '2024-01-02T00:00:00Z',
        messages: [
          { id: 'test-msg-9', type: 'user', content: 'Second', timestamp: '2024-01-02' },
        ],
      };

      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(conversation1))
        .mockResolvedValueOnce(JSON.stringify(conversation2));

      const result = await getSessionFiles(mockConfig);

      expect(result).toHaveLength(2);
      // Most recent first
      expect(result[0].id).toBe('2');
      expect(result[1].id).toBe('1');
    });

    it('should filter out sessions without user or assistant messages', async () => {
      const mockFiles = ['session-1.json'];
      const conversation: ConversationRecord = {
        sessionId: '1',
        projectHash: 'test-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T00:00:00Z',
        messages: [],
      };

      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conversation));

      const result = await getSessionFiles(mockConfig);

      expect(result).toHaveLength(0);
    });

    it('should populate SessionInfo correctly', async () => {
      const mockFiles = ['session-1.json'];
      const conversation: ConversationRecord = {
        sessionId: 'test-id',
        projectHash: 'test-hash',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T12:00:00Z',
        summary: 'Test summary',
        messages: [
          { id: 'test-msg-11', type: 'user', content: 'Hello world', timestamp: '2024-01-01' },
          { id: 'test-msg-12', type: 'gemini', content: 'Hi there', timestamp: '2024-01-01' },
        ],
      };

      vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conversation));

      const result = await getSessionFiles(mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'test-id',
        startTime: '2024-01-01T00:00:00Z',
        lastUpdated: '2024-01-01T12:00:00Z',
        messageCount: 2,
        summary: 'Test summary',
        firstUserMessage: 'Hello world',
      });
      expect(result[0].filePath).toContain('session-1.json');
    });
  });

  describe('SessionSelector', () => {
    let mockConfig: Config;
    let selector: SessionSelector;

    beforeEach(() => {
      mockConfig = {
        getTmpDir: vi.fn().mockReturnValue('/tmp/test'),
      } as unknown as Config;
      selector = new SessionSelector(mockConfig);
    });

    describe('listSessions', () => {
      it('should list sessions', async () => {
        const mockFiles = ['session-1.json'];
        const conversation: ConversationRecord = {
          sessionId: '1',
          projectHash: 'test-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messages: [
            { id: 'test-msg-13', type: 'user', content: 'Test', timestamp: '2024-01-01' },
          ],
        };

        vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conversation));

        const result = await selector.listSessions();

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('1');
      });
    });

    describe('findSession', () => {
      beforeEach(() => {
        const mockFiles = ['session-1.json', 'session-2.json'];
        const conversation1: ConversationRecord = {
          sessionId: 'uuid-123',
          projectHash: 'test-hash',
          startTime: '2024-01-02T00:00:00Z',
          lastUpdated: '2024-01-02T00:00:00Z',
          messages: [
            { id: 'test-msg-14', type: 'user', content: 'Second', timestamp: '2024-01-02' },
          ],
        };
        const conversation2: ConversationRecord = {
          sessionId: 'uuid-456',
          projectHash: 'test-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messages: [
            { id: 'test-msg-15', type: 'user', content: 'First', timestamp: '2024-01-01' },
          ],
        };

        vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
        vi.mocked(fs.readFile)
          .mockResolvedValueOnce(JSON.stringify(conversation1))
          .mockResolvedValueOnce(JSON.stringify(conversation2));
      });

      it('should find session by UUID', async () => {
        const result = await selector.findSession('uuid-456');

        expect(result).toBeDefined();
        expect(result?.id).toBe('uuid-456');
      });

      it('should find session by 1-based index', async () => {
        const result = await selector.findSession('1');

        expect(result).toBeDefined();
        expect(result?.id).toBe('uuid-123'); // Most recent
      });

      it('should find session by 2nd index', async () => {
        const result = await selector.findSession('2');

        expect(result).toBeDefined();
        expect(result?.id).toBe('uuid-456');
      });

      it('should return undefined for invalid UUID', async () => {
        const result = await selector.findSession('invalid-uuid');

        expect(result).toBeUndefined();
      });

      it('should return undefined for out of range index', async () => {
        const result = await selector.findSession('10');

        expect(result).toBeUndefined();
      });

      it('should return undefined for invalid index', async () => {
        const result = await selector.findSession('0');

        expect(result).toBeUndefined();
      });
    });

    describe('resolveSession', () => {
      beforeEach(() => {
        const mockFiles = ['session-1.json'];
        const conversation: ConversationRecord = {
          sessionId: 'test-id',
          projectHash: 'test-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messages: [
            { id: 'test-msg-16', type: 'user', content: 'Test message', timestamp: '2024-01-01' },
          ],
        };

        vi.mocked(fs.readdir).mockResolvedValue(mockFiles as any);
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conversation));
      });

      it('should resolve "latest" to most recent session', async () => {
        const result = await selector.resolveSession(RESUME_LATEST);

        expect(result.found).toBe(true);
        expect(result.sessionData).toBeDefined();
        expect(result.displayInfo?.id).toBe('test-id');
      });

      it('should resolve by UUID', async () => {
        const result = await selector.resolveSession('test-id');

        expect(result.found).toBe(true);
        expect(result.sessionData).toBeDefined();
      });

      it('should resolve by index', async () => {
        const result = await selector.resolveSession('1');

        expect(result.found).toBe(true);
        expect(result.sessionData).toBeDefined();
      });

      it('should return error when no sessions found', async () => {
        vi.mocked(fs.readdir).mockResolvedValue([] as any);

        const result = await selector.resolveSession(RESUME_LATEST);

        expect(result.found).toBe(false);
        expect(result.error).toBe('No sessions found');
      });

      it('should return error when session not found', async () => {
        const result = await selector.resolveSession('invalid-id');

        expect(result.found).toBe(false);
        expect(result.error).toContain('Session not found');
      });
    });

    describe('selectSession', () => {
      it('should load session data', async () => {
        const sessionInfo: SessionInfo = {
          id: 'test-id',
          filePath: '/tmp/test/chats/session-1.json',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messageCount: 1,
          firstUserMessage: 'Test',
        };
        const conversation: ConversationRecord = {
          sessionId: 'test-id',
          projectHash: 'test-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messages: [
            { id: 'test-msg-17', type: 'user', content: 'Test', timestamp: '2024-01-01' },
          ],
        };

        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(conversation));

        const result = await selector.selectSession(sessionInfo);

        expect(result.found).toBe(true);
        expect(result.sessionData).toBeDefined();
        expect(result.sessionData?.conversation).toEqual(conversation);
        expect(result.sessionData?.filePath).toBe(sessionInfo.filePath);
      });

      it('should return error when file read fails', async () => {
        const sessionInfo: SessionInfo = {
          id: 'test-id',
          filePath: '/tmp/test/chats/session-1.json',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:00Z',
          messageCount: 1,
          firstUserMessage: 'Test',
        };

        vi.mocked(fs.readFile).mockRejectedValue(new Error('Read error'));

        const result = await selector.selectSession(sessionInfo);

        expect(result.found).toBe(false);
        expect(result.error).toContain('Failed to load session');
      });
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  parseRetentionPeriod,
  validateRetentionConfig,
  cleanupExpiredSessions,
  type SessionRetentionConfig,
} from './sessionCleanup.js';
import type { Config } from '@vivo/bluecode-cli-core';

// Mock dependencies
vi.mock('node:fs/promises');
vi.mock('./sessionUtils.js', () => ({
  getAllSessionFiles: vi.fn(),
}));

import { getAllSessionFiles } from './sessionUtils.js';

describe('sessionCleanup', () => {
  describe('parseRetentionPeriod', () => {
    it('should parse hours', () => {
      expect(parseRetentionPeriod('24h')).toBe(24 * 60 * 60 * 1000);
      expect(parseRetentionPeriod('1h')).toBe(60 * 60 * 1000);
    });

    it('should parse days', () => {
      expect(parseRetentionPeriod('7d')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseRetentionPeriod('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('should parse weeks', () => {
      expect(parseRetentionPeriod('1w')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseRetentionPeriod('2w')).toBe(14 * 24 * 60 * 60 * 1000);
    });

    it('should throw error for invalid format', () => {
      expect(() => parseRetentionPeriod('invalid')).toThrow(
        'Invalid retention period format'
      );
      expect(() => parseRetentionPeriod('10')).toThrow();
      expect(() => parseRetentionPeriod('10x')).toThrow();
    });
  });

  describe('validateRetentionConfig', () => {
    it('should validate enabled config with maxAge', () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '30d',
      };
      expect(validateRetentionConfig(config)).toBe(true);
    });

    it('should validate enabled config with maxCount', () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxCount: 10,
      };
      expect(validateRetentionConfig(config)).toBe(true);
    });

    it('should validate disabled config', () => {
      const config: SessionRetentionConfig = {
        enabled: false,
      };
      expect(validateRetentionConfig(config)).toBe(true);
    });

    it('should reject invalid maxAge format', () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: 'invalid',
      };
      expect(validateRetentionConfig(config)).toBe(false);
    });

    it('should reject invalid minRetention format', () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        minRetention: 'bad',
      };
      expect(validateRetentionConfig(config)).toBe(false);
    });

    it('should reject maxCount less than 1', () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxCount: 0,
      };
      expect(validateRetentionConfig(config)).toBe(false);
    });

    it('should accept maxCount of 1', () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxCount: 1,
      };
      expect(validateRetentionConfig(config)).toBe(true);
    });
  });

  describe('cleanupExpiredSessions', () => {
    let mockConfig: Config;

    beforeEach(() => {
      mockConfig = {
        getTmpDir: vi.fn().mockReturnValue('/tmp/test'),
      } as unknown as Config;
      vi.clearAllMocks();
    });

    it('should return empty result when disabled', async () => {
      const config: SessionRetentionConfig = {
        enabled: false,
      };

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('should delete corrupted session files', async () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '30d',
      };

      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: null,
          error: 'Parse error',
        },
      ]);
      vi.mocked(fs.unlink).mockResolvedValue();

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(1);
      expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(
        '/tmp/test/chats/session-1.json'
      );
    });

    it('should delete sessions older than maxAge', async () => {
      const now = new Date('2024-01-31T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '30d',
        minRetention: '1d',
      };

      // Session 31 days old (should be deleted)
      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'old-session',
            projectHash: 'test-hash',
            startTime: '2024-01-01T00:00:00Z',
            lastUpdated: '2023-12-31T00:00:00Z',
            messages: [],
          },
        },
      ]);
      vi.mocked(fs.unlink).mockResolvedValue();

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(1);
      expect(vi.mocked(fs.unlink)).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should keep sessions younger than maxAge', async () => {
      const now = new Date('2024-01-31T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '30d',
        minRetention: '1d',
      };

      // Session 20 days old (should be kept)
      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'recent-session',
            projectHash: 'test-hash',
            startTime: '2024-01-11T00:00:00Z',
            lastUpdated: '2024-01-11T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(1);
      expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should respect minRetention period', async () => {
      const now = new Date('2024-01-02T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '1d',
        minRetention: '2d',
      };

      // Session 1 day old but within minRetention (should be kept)
      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'recent-session',
            projectHash: 'test-hash',
            startTime: '2024-01-01T00:00:00Z',
            lastUpdated: '2024-01-01T12:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(1);

      vi.useRealTimers();
    });

    it('should keep only maxCount sessions', async () => {
      const now = new Date('2024-01-10T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxCount: 2,
        minRetention: '1d',
      };

      // 3 sessions, all old enough
      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'session-1',
            projectHash: 'test-hash',
            startTime: '2024-01-08T00:00:00Z',
            lastUpdated: '2024-01-08T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
        {
          filePath: '/tmp/test/chats/session-2.json',
          data: {
            sessionId: 'session-2',
            projectHash: 'test-hash',
            startTime: '2024-01-07T00:00:00Z',
            lastUpdated: '2024-01-07T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
        {
          filePath: '/tmp/test/chats/session-3.json',
          data: {
            sessionId: 'session-3',
            projectHash: 'test-hash',
            startTime: '2024-01-06T00:00:00Z',
            lastUpdated: '2024-01-06T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);
      vi.mocked(fs.unlink).mockResolvedValue();

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(1);
      expect(result.retained).toBe(2);
      // Should keep 2 most recent (session-1 and session-2)
      expect(vi.mocked(fs.unlink)).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should never delete current session', async () => {
      const now = new Date('2024-01-31T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '1d',
        minRetention: '1d',
      };

      const currentSessionId = 'current-session';

      // Session is old but is current session
      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: currentSessionId,
            projectHash: 'test-hash',
            startTime: '2024-01-01T00:00:00Z',
            lastUpdated: '2024-01-01T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);

      const result = await cleanupExpiredSessions(
        mockConfig,
        config,
        currentSessionId
      );

      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(1);
      expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should delete activity log alongside session file', async () => {
      const now = new Date('2024-01-31T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '1d',
        minRetention: '1d',
      };

      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'old-session',
            projectHash: 'test-hash',
            startTime: '2024-01-01T00:00:00Z',
            lastUpdated: '2024-01-01T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);
      vi.mocked(fs.unlink).mockResolvedValue();

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(1);
      expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(
        '/tmp/test/chats/session-1.json'
      );
      expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(
        '/tmp/test/chats/session-1-activity.json'
      );

      vi.useRealTimers();
    });

    it('should handle errors during deletion', async () => {
      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '1d',
      };

      const now = new Date('2024-01-31T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'session-1',
            projectHash: 'test-hash',
            startTime: '2024-01-01T00:00:00Z',
            lastUpdated: '2024-01-01T00:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Delete failed'));

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Failed to delete session');

      vi.useRealTimers();
    });

    it('should handle errors for corrupted file deletion', async () => {
      const config: SessionRetentionConfig = {
        enabled: true,
      };

      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: null,
          error: 'Parse error',
        },
      ]);
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Delete failed'));

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Failed to delete corrupted file');
    });

    it('should use default minRetention when not specified', async () => {
      const now = new Date('2024-01-02T12:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const config: SessionRetentionConfig = {
        enabled: true,
        maxAge: '1d',
        // minRetention not specified, should default to 1d
      };

      // Session 1 day old (should be kept due to default minRetention)
      vi.mocked(getAllSessionFiles).mockResolvedValue([
        {
          filePath: '/tmp/test/chats/session-1.json',
          data: {
            sessionId: 'recent-session',
            projectHash: 'test-hash',
            startTime: '2024-01-01T00:00:00Z',
            lastUpdated: '2024-01-01T12:00:00Z',
            messages: [{ id: 'cleanup-msg-1', type: 'user', content: 'Test', timestamp: '' }],
          },
        },
      ]);

      const result = await cleanupExpiredSessions(mockConfig, config);

      expect(result.deleted).toBe(0);
      expect(result.retained).toBe(1);

      vi.useRealTimers();
    });
  });
});

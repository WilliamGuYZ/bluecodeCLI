/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useSessionBrowser,
  convertSessionToHistoryFormats,
} from './useSessionBrowser.js';
import type { Config, ConversationRecord, ResumedSessionData } from '@vivo/bluecode-cli-core';
import type { SessionInfo } from '../../utils/sessionUtils.js';

// Mock sessionUtils
vi.mock('../../utils/sessionUtils.js', () => ({
  SessionSelector: vi.fn().mockImplementation(() => ({
    selectSession: vi.fn(),
  })),
}));

import { SessionSelector } from '../../utils/sessionUtils.js';

describe('useSessionBrowser', () => {
  let mockConfig: Config;
  let mockOnLoadHistory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getGeminiClient: vi.fn().mockReturnValue({
        getChatRecordingService: vi.fn().mockReturnValue({
          deleteSession: vi.fn(),
        }),
      }),
    } as unknown as Config;
    mockOnLoadHistory = vi.fn().mockResolvedValue(undefined);
  });

  describe('state management', () => {
    it('should initialize with browser closed', () => {
      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      expect(result.current.isSessionBrowserOpen).toBe(false);
    });

    it('should open browser', () => {
      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      act(() => {
        result.current.openSessionBrowser();
      });

      expect(result.current.isSessionBrowserOpen).toBe(true);
    });

    it('should close browser', () => {
      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      act(() => {
        result.current.openSessionBrowser();
      });
      expect(result.current.isSessionBrowserOpen).toBe(true);

      act(() => {
        result.current.closeSessionBrowser();
      });
      expect(result.current.isSessionBrowserOpen).toBe(false);
    });
  });

  describe('handleResumeSession', () => {
    const mockSession: SessionInfo = {
      id: 'test-session',
      filePath: '/tmp/test/session.json',
      startTime: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T00:00:00Z',
      messageCount: 2,
      firstUserMessage: 'Hello',
    };

    const mockConversation: ConversationRecord = {
      sessionId: 'test-session',
      projectHash: 'test-hash',
      startTime: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T00:00:00Z',
      messages: [
        { id: 'browser-msg-1', type: 'user', content: 'Hello', timestamp: '2024-01-01' },
        { id: 'browser-msg-2', type: 'gemini', content: 'Hi there', timestamp: '2024-01-01' },
      ],
    };

    it('should resume session and close browser', async () => {
      const mockSelectSession = vi.fn().mockResolvedValue({
        found: true,
        sessionData: {
          conversation: mockConversation,
          filePath: '/tmp/test/session.json',
        },
      });

      vi.mocked(SessionSelector).mockImplementation(
        () =>
          ({
            selectSession: mockSelectSession,
          }) as any
      );

      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      act(() => {
        result.current.openSessionBrowser();
      });

      await act(async () => {
        await result.current.handleResumeSession(mockSession);
      });

      expect(mockOnLoadHistory).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Array),
        expect.objectContaining({
          conversation: mockConversation,
          filePath: '/tmp/test/session.json',
        })
      );
      expect(result.current.isSessionBrowserOpen).toBe(false);
    });

    it('should not call onLoadHistory when session not found', async () => {
      const mockSelectSession = vi.fn().mockResolvedValue({
        found: false,
        error: 'Session not found',
      });

      vi.mocked(SessionSelector).mockImplementation(
        () =>
          ({
            selectSession: mockSelectSession,
          }) as any
      );

      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      await act(async () => {
        await result.current.handleResumeSession(mockSession);
      });

      expect(mockOnLoadHistory).not.toHaveBeenCalled();
    });

    it('should not call onLoadHistory when config is null', async () => {
      const { result } = renderHook(() =>
        useSessionBrowser(null, mockOnLoadHistory)
      );

      await act(async () => {
        await result.current.handleResumeSession(mockSession);
      });

      expect(mockOnLoadHistory).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteSession', () => {
    const mockSession: SessionInfo = {
      id: 'test-session',
      filePath: '/tmp/test/session.json',
      startTime: '2024-01-01T00:00:00Z',
      lastUpdated: '2024-01-01T00:00:00Z',
      messageCount: 1,
      firstUserMessage: 'Test',
    };

    it('should call deleteSession on recording service', async () => {
      const mockDeleteSession = vi.fn();
      mockConfig = {
        getGeminiClient: vi.fn().mockReturnValue({
          getChatRecordingService: vi.fn().mockReturnValue({
            deleteSession: mockDeleteSession,
          }),
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      await act(async () => {
        await result.current.handleDeleteSession(mockSession);
      });

      expect(mockDeleteSession).toHaveBeenCalledWith(mockSession.filePath);
    });

    it('should handle null config', async () => {
      const { result } = renderHook(() =>
        useSessionBrowser(null, mockOnLoadHistory)
      );

      // Should not throw
      await act(async () => {
        await result.current.handleDeleteSession(mockSession);
      });
    });

    it('should handle missing recording service', async () => {
      mockConfig = {
        getGeminiClient: vi.fn().mockReturnValue({
          getChatRecordingService: vi.fn().mockReturnValue(undefined),
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useSessionBrowser(mockConfig, mockOnLoadHistory)
      );

      // Should not throw
      await act(async () => {
        await result.current.handleDeleteSession(mockSession);
      });
    });
  });
});

describe('convertSessionToHistoryFormats', () => {
  it('should convert user messages', () => {
    const messages: ConversationRecord['messages'] = [
      { id: 'browser-msg-3', type: 'user', content: 'Hello', timestamp: '2024-01-01' },
    ];

    const result = convertSessionToHistoryFormats(messages);

    expect(result.uiHistory).toHaveLength(1);
    expect(result.uiHistory[0]).toEqual({
      type: 'user',
      text: 'Hello',
    });

    expect(result.clientHistory).toHaveLength(1);
    expect(result.clientHistory[0]).toEqual({
      role: 'user',
      parts: [{ text: 'Hello' }],
    });
  });

  it('should convert gemini messages', () => {
    const messages: ConversationRecord['messages'] = [
      { id: 'browser-msg-4', type: 'gemini', content: 'Hi there', timestamp: '2024-01-01' },
    ];

    const result = convertSessionToHistoryFormats(messages);

    expect(result.uiHistory).toHaveLength(1);
    expect(result.uiHistory[0]).toEqual({
      type: 'gemini',
      text: 'Hi there',
    });

    expect(result.clientHistory).toHaveLength(1);
    expect(result.clientHistory[0]).toEqual({
      role: 'model',
      parts: [{ text: 'Hi there' }],
    });
  });

  it('should handle object content', () => {
    const messages: ConversationRecord['messages'] = [
      { id: 'browser-msg-5', type: 'user', content: { text: 'Hello' } as any, timestamp: '2024-01-01' },
    ];

    const result = convertSessionToHistoryFormats(messages);

    expect(result.uiHistory[0].text).toBe('{"text":"Hello"}');
  });

  it('should skip info messages', () => {
    const messages: ConversationRecord['messages'] = [
      { id: 'browser-msg-7', type: 'user', content: 'Hello', timestamp: '2024-01-01' },
    ];

    const result = convertSessionToHistoryFormats(messages);

    expect(result.uiHistory).toHaveLength(1);
    expect(result.uiHistory[0].type).toBe('user');
  });

  it('should handle tool calls in gemini messages', () => {
    const messages: ConversationRecord['messages'] = [
      {
        id: 'browser-msg-8',
        type: 'gemini',
        content: 'Let me help',
        timestamp: '2024-01-01',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'read_file',
            args: { path: '/test.txt' },
            result: 'file content',
            status: 'success' as const,
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      },
    ];

    const result = convertSessionToHistoryFormats(messages);

    // Should have: model message, function call, function response
    expect(result.clientHistory).toHaveLength(3);

    // First is the text response
    expect(result.clientHistory[0]).toEqual({
      role: 'model',
      parts: [{ text: 'Let me help' }],
    });

    // Second is the function call
    expect(result.clientHistory[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'read_file',
            args: { path: '/test.txt' },
          },
        },
      ],
    });

    // Third is the function response
    expect(result.clientHistory[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            response: { result: 'file content' },
          },
        },
      ],
    });
  });

  it('should handle tool calls without result', () => {
    const messages: ConversationRecord['messages'] = [
      {
        id: 'browser-msg-9',
        type: 'gemini',
        content: 'Processing',
        timestamp: '2024-01-01',
        toolCalls: [
          {
            id: 'tc-2',
            name: 'some_tool',
            args: { param: 'value' },
            status: 'scheduled' as const,
            timestamp: '2024-01-01T00:00:00Z',
            // No result
          },
        ],
      },
    ];

    const result = convertSessionToHistoryFormats(messages);

    // Should have: model message, function call (no response)
    expect(result.clientHistory).toHaveLength(2);
  });

  it('should handle tool calls with undefined args', () => {
    const messages: ConversationRecord['messages'] = [
      {
        id: 'browser-msg-10',
        type: 'gemini',
        content: 'Running',
        timestamp: '2024-01-01',
        toolCalls: [
          {
            id: 'tc-3',
            name: 'simple_tool',
            args: {},
            result: 'done',
            status: 'success' as const,
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      },
    ];

    const result = convertSessionToHistoryFormats(messages);

    // Function call should have empty args object
    expect(result.clientHistory[1]).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'simple_tool',
            args: {},
          },
        },
      ],
    });
  });

  it('should handle multiple tool calls', () => {
    const messages: ConversationRecord['messages'] = [
      {
        id: 'browser-msg-11',
        type: 'gemini',
        content: 'Working',
        timestamp: '2024-01-01',
        toolCalls: [
          { id: 'tc-4', name: 'tool1', args: {}, result: 'r1', status: 'success' as const, timestamp: '2024-01-01T00:00:00Z' },
          { id: 'tc-5', name: 'tool2', args: {}, result: 'r2', status: 'success' as const, timestamp: '2024-01-01T00:00:00Z' },
        ],
      },
    ];

    const result = convertSessionToHistoryFormats(messages);

    // Should have: model message, 2x (function call + function response)
    expect(result.clientHistory).toHaveLength(5);
  });

  it('should handle empty messages array', () => {
    const result = convertSessionToHistoryFormats([]);

    expect(result.uiHistory).toEqual([]);
    expect(result.clientHistory).toEqual([]);
  });

  it('should convert full conversation correctly', () => {
    const messages: ConversationRecord['messages'] = [
      { id: 'browser-msg-12', type: 'user', content: 'Hello', timestamp: '2024-01-01' },
      { id: 'browser-msg-13', type: 'gemini', content: 'Hi', timestamp: '2024-01-01' },
      { id: 'browser-msg-14', type: 'user', content: 'How are you?', timestamp: '2024-01-01' },
      { id: 'browser-msg-15', type: 'gemini', content: 'Good, thanks!', timestamp: '2024-01-01' },
    ];

    const result = convertSessionToHistoryFormats(messages);

    expect(result.uiHistory).toHaveLength(4);
    expect(result.clientHistory).toHaveLength(4);

    // Verify alternating roles
    expect(result.clientHistory[0].role).toBe('user');
    expect(result.clientHistory[1].role).toBe('model');
    expect(result.clientHistory[2].role).toBe('user');
    expect(result.clientHistory[3].role).toBe('model');
  });
});

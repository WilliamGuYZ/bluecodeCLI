/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionResume } from './useSessionResume.js';
import type { Config, ResumedSessionData, ConversationRecord } from '@vivo/bluecode-cli-core';
import type { HistoryItemWithoutId } from '../types.js';
import type { Content } from '@google/genai';

// Mock convertSessionToHistoryFormats
vi.mock('./useSessionBrowser.js', () => ({
  convertSessionToHistoryFormats: vi.fn().mockReturnValue({
    uiHistory: [{ type: 'user', text: 'Hello' }],
    clientHistory: [{ role: 'user', parts: [{ text: 'Hello' }] }],
  }),
}));

import { convertSessionToHistoryFormats } from './useSessionBrowser.js';

describe('useSessionResume', () => {
  let mockConfig: Config;
  let mockAddHistoryItems: ReturnType<typeof vi.fn>;
  let mockRefreshStatic: ReturnType<typeof vi.fn>;
  let mockSetQuittingMessages: ReturnType<typeof vi.fn>;
  let mockResumeChat: ReturnType<typeof vi.fn>;

  const mockConversation: ConversationRecord = {
    sessionId: 'test-session',
    projectHash: 'test-hash',
    startTime: '2024-01-01T00:00:00Z',
    lastUpdated: '2024-01-01T00:00:00Z',
    messages: [
      { id: 'resume-msg-1', type: 'user', content: 'Hello', timestamp: '2024-01-01' },
      { id: 'resume-msg-2', type: 'gemini', content: 'Hi there', timestamp: '2024-01-01' },
    ],
  };

  const mockResumedSessionData: ResumedSessionData = {
    conversation: mockConversation,
    filePath: '/tmp/test/session.json',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockResumeChat = vi.fn().mockResolvedValue(undefined);
    mockAddHistoryItems = vi.fn();
    mockRefreshStatic = vi.fn();
    mockSetQuittingMessages = vi.fn();

    mockConfig = {
      getGeminiClient: vi.fn().mockReturnValue({
        resumeChat: mockResumeChat,
      }),
    } as unknown as Config;
  });

  describe('loadHistoryForResume', () => {
    it('should clear quitting messages', async () => {
      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      const uiHistory: HistoryItemWithoutId[] = [{ type: 'user', text: 'Hello' }];
      const clientHistory: Content[] = [{ role: 'user', parts: [{ text: 'Hello' }] }];

      await act(async () => {
        await result.current.loadHistoryForResume(uiHistory, clientHistory, mockResumedSessionData);
      });

      expect(mockSetQuittingMessages).toHaveBeenCalledWith(null);
    });

    it('should add history items to UI', async () => {
      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      const uiHistory: HistoryItemWithoutId[] = [
        { type: 'user', text: 'Hello' },
        { type: 'gemini', text: 'Hi there' },
      ];
      const clientHistory: Content[] = [];

      await act(async () => {
        await result.current.loadHistoryForResume(uiHistory, clientHistory, mockResumedSessionData);
      });

      expect(mockAddHistoryItems).toHaveBeenCalledWith(uiHistory);
    });

    it('should call refreshStatic', async () => {
      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      expect(mockRefreshStatic).toHaveBeenCalled();
    });

    it('should call resumeChat on Gemini client', async () => {
      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      const clientHistory: Content[] = [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi' }] },
      ];

      await act(async () => {
        await result.current.loadHistoryForResume([], clientHistory, mockResumedSessionData);
      });

      expect(mockResumeChat).toHaveBeenCalledWith(clientHistory, mockResumedSessionData);
    });

    it('should not call resumeChat when config is null', async () => {
      const { result } = renderHook(() =>
        useSessionResume({
          config: null,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      expect(mockResumeChat).not.toHaveBeenCalled();
      // Other callbacks should still be called
      expect(mockSetQuittingMessages).toHaveBeenCalledWith(null);
      expect(mockAddHistoryItems).toHaveBeenCalled();
      expect(mockRefreshStatic).toHaveBeenCalled();
    });

    it('should not call resumeChat when geminiClient is not available', async () => {
      mockConfig = {
        getGeminiClient: vi.fn().mockReturnValue(null),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      expect(mockResumeChat).not.toHaveBeenCalled();
    });

    it('should prevent concurrent calls with isResuming guard', async () => {
      // Create a slow resumeChat that we can control
      let resolveResumeChat: () => void;
      const slowResumeChat = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveResumeChat = resolve;
        });
      });

      mockConfig = {
        getGeminiClient: vi.fn().mockReturnValue({
          resumeChat: slowResumeChat,
        }),
      } as unknown as Config;

      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      // Start first call (won't complete)
      const firstCall = act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      // Start second call immediately
      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      // Only first call should have triggered callbacks
      expect(mockSetQuittingMessages).toHaveBeenCalledTimes(1);
      expect(mockAddHistoryItems).toHaveBeenCalledTimes(1);

      // Complete the first call
      resolveResumeChat!();
      await firstCall;
    });

    it('should reset isResuming after completion', async () => {
      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      // First call
      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      // Second call should work after first completes
      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      expect(mockSetQuittingMessages).toHaveBeenCalledTimes(2);
      expect(mockAddHistoryItems).toHaveBeenCalledTimes(2);
    });

    it('should reset isResuming even if resumeChat throws', async () => {
      mockResumeChat.mockRejectedValueOnce(new Error('Resume failed'));

      const { result } = renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      // First call (will throw)
      await act(async () => {
        try {
          await result.current.loadHistoryForResume([], [], mockResumedSessionData);
        } catch {
          // Expected
        }
      });

      // Second call should still work
      await act(async () => {
        await result.current.loadHistoryForResume([], [], mockResumedSessionData);
      });

      expect(mockSetQuittingMessages).toHaveBeenCalledTimes(2);
    });
  });

  describe('auto-resume on startup', () => {
    it('should auto-resume when resumedSessionData is provided', async () => {
      renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          resumedSessionData: mockResumedSessionData,
          isAuthenticating: false,
        })
      );

      await waitFor(() => {
        expect(convertSessionToHistoryFormats).toHaveBeenCalledWith(
          mockResumedSessionData.conversation.messages
        );
      });

      expect(mockSetQuittingMessages).toHaveBeenCalledWith(null);
      expect(mockAddHistoryItems).toHaveBeenCalled();
      expect(mockRefreshStatic).toHaveBeenCalled();
      expect(mockResumeChat).toHaveBeenCalled();
    });

    it('should wait for authentication to complete before resuming', async () => {
      const { rerender } = renderHook(
        ({ isAuthenticating }) =>
          useSessionResume({
            config: mockConfig,
            addHistoryItems: mockAddHistoryItems,
            refreshStatic: mockRefreshStatic,
            setQuittingMessages: mockSetQuittingMessages,
            resumedSessionData: mockResumedSessionData,
            isAuthenticating,
          }),
        { initialProps: { isAuthenticating: true } }
      );

      // Should not resume while authenticating
      expect(mockAddHistoryItems).not.toHaveBeenCalled();

      // Complete authentication
      rerender({ isAuthenticating: false });

      await waitFor(() => {
        expect(mockAddHistoryItems).toHaveBeenCalled();
      });
    });

    it('should not auto-resume without resumedSessionData', () => {
      renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          isAuthenticating: false,
        })
      );

      expect(convertSessionToHistoryFormats).not.toHaveBeenCalled();
      expect(mockAddHistoryItems).not.toHaveBeenCalled();
    });

    it('should not auto-resume without geminiClient', () => {
      mockConfig = {
        getGeminiClient: vi.fn().mockReturnValue(null),
      } as unknown as Config;

      renderHook(() =>
        useSessionResume({
          config: mockConfig,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          resumedSessionData: mockResumedSessionData,
          isAuthenticating: false,
        })
      );

      expect(convertSessionToHistoryFormats).not.toHaveBeenCalled();
      expect(mockAddHistoryItems).not.toHaveBeenCalled();
    });

    it('should not auto-resume with null config', () => {
      renderHook(() =>
        useSessionResume({
          config: null,
          addHistoryItems: mockAddHistoryItems,
          refreshStatic: mockRefreshStatic,
          setQuittingMessages: mockSetQuittingMessages,
          resumedSessionData: mockResumedSessionData,
          isAuthenticating: false,
        })
      );

      expect(convertSessionToHistoryFormats).not.toHaveBeenCalled();
      expect(mockAddHistoryItems).not.toHaveBeenCalled();
    });

    it('should not resume twice (hasResumedRef guard)', async () => {
      const { rerender } = renderHook(
        ({ config }) =>
          useSessionResume({
            config,
            addHistoryItems: mockAddHistoryItems,
            refreshStatic: mockRefreshStatic,
            setQuittingMessages: mockSetQuittingMessages,
            resumedSessionData: mockResumedSessionData,
            isAuthenticating: false,
          }),
        { initialProps: { config: mockConfig } }
      );

      await waitFor(() => {
        expect(mockAddHistoryItems).toHaveBeenCalledTimes(1);
      });

      // Trigger re-render with same config
      rerender({ config: mockConfig });

      // Should still be called only once
      expect(mockAddHistoryItems).toHaveBeenCalledTimes(1);
    });

    it('should resume when geminiClient becomes available', async () => {
      const configWithoutClient = {
        getGeminiClient: vi.fn().mockReturnValue(null),
      } as unknown as Config;

      const { rerender } = renderHook(
        ({ config }) =>
          useSessionResume({
            config,
            addHistoryItems: mockAddHistoryItems,
            refreshStatic: mockRefreshStatic,
            setQuittingMessages: mockSetQuittingMessages,
            resumedSessionData: mockResumedSessionData,
            isAuthenticating: false,
          }),
        { initialProps: { config: configWithoutClient } }
      );

      // Should not resume without geminiClient
      expect(mockAddHistoryItems).not.toHaveBeenCalled();

      // Update config with available geminiClient
      rerender({ config: mockConfig });

      await waitFor(() => {
        expect(mockAddHistoryItems).toHaveBeenCalled();
      });
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook for handling session resume logic.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { Content } from '@google/genai';
import type { Config, ResumedSessionData } from '@vivo/bluecode-cli-core';
import type { HistoryItemWithoutId } from '../types.js';
import { convertSessionToHistoryFormats } from './useSessionBrowser.js';

interface UseSessionResumeParams {
  config: Config | null;
  addHistoryItems: (items: HistoryItemWithoutId[]) => void;
  refreshStatic: () => void;
  setQuittingMessages: (messages: null) => void;
  resumedSessionData?: ResumedSessionData;
  isAuthenticating: boolean;
}

interface UseSessionResumeReturn {
  loadHistoryForResume: (
    uiHistory: HistoryItemWithoutId[],
    clientHistory: Content[],
    resumedData: ResumedSessionData
  ) => Promise<void>;
}

/**
 * Hook for managing session resume state and logic.
 */
export function useSessionResume({
  config,
  addHistoryItems,
  refreshStatic,
  setQuittingMessages,
  resumedSessionData,
  isAuthenticating,
}: UseSessionResumeParams): UseSessionResumeReturn {
  const hasResumedRef = useRef(false);
  const isResuming = useRef(false);

  /**
   * Loads history from a resumed session into the UI and Gemini client.
   */
  const loadHistoryForResume = useCallback(
    async (
      uiHistory: HistoryItemWithoutId[],
      clientHistory: Content[],
      resumedData: ResumedSessionData
    ) => {
      if (isResuming.current) {
        return;
      }
      isResuming.current = true;

      try {
        // Clear any quitting messages
        setQuittingMessages(null);

        // Add history items to UI
        addHistoryItems(uiHistory);
        refreshStatic();

        // Resume chat in Gemini client
        const geminiClient = config?.getGeminiClient();
        if (geminiClient) {
          await geminiClient.resumeChat(clientHistory, resumedData);
        }
      } finally {
        isResuming.current = false;
      }
    },
    [config, addHistoryItems, refreshStatic, setQuittingMessages]
  );

  // Auto-resume on startup if resumedSessionData is provided
  useEffect(() => {
    // Only resume when not authenticating and haven't resumed yet
    // Check for geminiClient availability instead of separate initialization state
    const geminiClient = config?.getGeminiClient();
    if (
      resumedSessionData &&
      geminiClient &&
      !isAuthenticating &&
      !hasResumedRef.current
    ) {
      hasResumedRef.current = true;

      const { uiHistory, clientHistory } = convertSessionToHistoryFormats(
        resumedSessionData.conversation.messages
      );

      loadHistoryForResume(uiHistory, clientHistory, resumedSessionData);
    }
  }, [
    config,
    resumedSessionData,
    isAuthenticating,
    loadHistoryForResume,
  ]);

  return {
    loadHistoryForResume,
  };
}

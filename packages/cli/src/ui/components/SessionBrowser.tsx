/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionBrowser component for interactive session selection.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Config } from '@vivo/bluecode-cli-core';
import type { SessionInfo } from '../../utils/sessionUtils.js';
import { getSessionFiles, formatRelativeTime } from '../../utils/sessionUtils.js';
import { Colors } from '../colors.js';

const PAGE_SIZE = 10;

type SortField = 'date' | 'messages' | 'name';
type SortOrder = 'asc' | 'desc';

interface SessionBrowserProps {
  config: Config;
  currentSessionId?: string;
  onResumeSession: (session: SessionInfo) => void;
  onDeleteSession: (session: SessionInfo) => Promise<void>;
  onExit: () => void;
}

interface SessionBrowserState {
  sessions: SessionInfo[];
  selectedIndex: number;
  searchMode: boolean;
  searchQuery: string;
  sortField: SortField;
  sortOrder: SortOrder;
  isLoading: boolean;
  error: string | null;
  page: number;
}

/**
 * Gets display text for sort order based on field.
 */
function getSortOrderDisplay(field: SortField, order: SortOrder): string {
  if (field === 'date') {
    return order === 'desc' ? 'old→new' : 'new→old';
  }
  if (field === 'messages') {
    return order === 'desc' ? 'most→least' : 'least→most';
  }
  // name
  return order === 'desc' ? 'Z→A' : 'A→Z';
}

/**
 * Sorts sessions by the given field and order.
 */
function sortSessions(
  sessions: SessionInfo[],
  field: SortField,
  order: SortOrder
): SessionInfo[] {
  const sorted = [...sessions].sort((a, b) => {
    let comparison = 0;
    switch (field) {
      case 'date':
        // desc = old → new (oldest first), asc = new → old (newest first)
        comparison =
          new Date(a.lastUpdated).getTime() -
          new Date(b.lastUpdated).getTime();
        break;
      case 'messages':
        comparison = b.messageCount - a.messageCount;
        break;
      case 'name':
        comparison = (a.firstUserMessage ?? '').localeCompare(
          b.firstUserMessage ?? ''
        );
        break;
    }
    return order === 'desc' ? comparison : -comparison;
  });
  return sorted;
}

/**
 * Filters sessions by search query.
 */
function filterSessions(
  sessions: SessionInfo[],
  query: string
): SessionInfo[] {
  if (!query.trim()) {
    return sessions;
  }
  const lowerQuery = query.toLowerCase();
  return sessions.filter(
    (s) =>
      s.id.toLowerCase().includes(lowerQuery) ||
      s.firstUserMessage?.toLowerCase().includes(lowerQuery) ||
      s.summary?.toLowerCase().includes(lowerQuery)
  );
}

export function SessionBrowser({
  config,
  currentSessionId,
  onResumeSession,
  onDeleteSession,
  onExit,
}: SessionBrowserProps): React.ReactElement {
  const [state, setState] = useState<SessionBrowserState>({
    sessions: [],
    selectedIndex: 0,
    searchMode: false,
    searchQuery: '',
    sortField: 'date',
    sortOrder: 'asc',
    isLoading: true,
    error: null,
    page: 0,
  });

  // Load sessions on mount
  useEffect(() => {
    async function loadSessions() {
      try {
        const sessions = await getSessionFiles(config);
        setState((prev) => ({
          ...prev,
          sessions,
          isLoading: false,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error:
            error instanceof Error ? error.message : 'Failed to load sessions',
        }));
      }
    }
    loadSessions();
  }, [config]);

  // Compute filtered and sorted sessions using useMemo (not useEffect + setState)
  const filteredSessions = useMemo(() => {
    const filtered = filterSessions(state.sessions, state.searchQuery);
    return sortSessions(filtered, state.sortField, state.sortOrder);
  }, [state.sessions, state.searchQuery, state.sortField, state.sortOrder]);

  // Reset selection when sort or search changes
  const sortField = state.sortField;
  const sortOrder = state.sortOrder;
  const searchQuery = state.searchQuery;
  useEffect(() => {
    setState((prev) => ({
      ...prev,
      selectedIndex: 0,
      page: 0,
    }));
  }, [sortField, sortOrder, searchQuery]);

  // Paginated sessions
  const paginatedSessions = useMemo(() => {
    const start = state.page * PAGE_SIZE;
    return filteredSessions.slice(start, start + PAGE_SIZE);
  }, [filteredSessions, state.page]);

  const totalPages = Math.ceil(filteredSessions.length / PAGE_SIZE);

  // Handle keyboard input
  useInput((input, key) => {
    if (state.searchMode) {
      if (key.escape || key.return) {
        setState((prev) => ({ ...prev, searchMode: false }));
        return;
      }
      if (key.backspace || key.delete) {
        setState((prev) => ({
          ...prev,
          searchQuery: prev.searchQuery.slice(0, -1),
        }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setState((prev) => ({
          ...prev,
          searchQuery: prev.searchQuery + input,
        }));
      }
      return;
    }

    // Navigation
    if (key.upArrow || input === 'k') {
      setState((prev) => ({
        ...prev,
        selectedIndex: Math.max(0, prev.selectedIndex - 1),
      }));
      return;
    }
    if (key.downArrow || input === 'j') {
      setState((prev) => ({
        ...prev,
        selectedIndex: Math.min(
          paginatedSessions.length - 1,
          prev.selectedIndex + 1
        ),
      }));
      return;
    }

    // Page navigation
    if (key.pageUp || input === 'u') {
      setState((prev) => ({
        ...prev,
        page: Math.max(0, prev.page - 1),
        selectedIndex: 0,
      }));
      return;
    }
    if (key.pageDown || input === 'd') {
      setState((prev) => ({
        ...prev,
        page: Math.min(totalPages - 1, prev.page + 1),
        selectedIndex: 0,
      }));
      return;
    }

    // First/Last
    if (input === 'g') {
      setState((prev) => ({ ...prev, page: 0, selectedIndex: 0 }));
      return;
    }
    if (input === 'G') {
      setState((prev) => ({
        ...prev,
        page: totalPages - 1,
        selectedIndex: Math.min(
          PAGE_SIZE - 1,
          filteredSessions.length - (totalPages - 1) * PAGE_SIZE - 1
        ),
      }));
      return;
    }

    // Search
    if (input === '/') {
      setState((prev) => ({ ...prev, searchMode: true, searchQuery: '' }));
      return;
    }

    // Sort
    if (input === 's') {
      setState((prev) => {
        const fields: SortField[] = ['date', 'messages', 'name'];
        const currentIdx = fields.indexOf(prev.sortField);
        const nextField = fields[(currentIdx + 1) % fields.length];
        return { ...prev, sortField: nextField };
      });
      return;
    }
    if (input === 'r') {
      setState((prev) => ({
        ...prev,
        sortOrder: prev.sortOrder === 'asc' ? 'desc' : 'asc',
      }));
      return;
    }

    // Delete
    if (input === 'x') {
      const selected = paginatedSessions[state.selectedIndex];
      if (selected && selected.id !== currentSessionId) {
        onDeleteSession(selected).then(() => {
          setState((prev) => ({
            ...prev,
            sessions: prev.sessions.filter((s) => s.id !== selected.id),
          }));
        });
      }
      return;
    }

    // Select/Resume
    if (key.return) {
      const selected = paginatedSessions[state.selectedIndex];
      if (selected && selected.id !== currentSessionId) {
        onResumeSession(selected);
      }
      return;
    }

    // Exit
    if (key.escape || input === 'q' || input === 'Q') {
      onExit();
      return;
    }
  });

  // Loading state
  if (state.isLoading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={Colors.AccentCyan}>Loading sessions...</Text>
      </Box>
    );
  }

  // Error state
  if (state.error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={Colors.AccentRed}>Error: {state.error}</Text>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    );
  }

  // Empty state
  if (filteredSessions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={Colors.AccentYellow}>
          {state.searchQuery
            ? `No sessions match "${state.searchQuery}"`
            : 'No saved sessions found'}
        </Text>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentCyan}>
          Session Browser
        </Text>
        <Text dimColor>
          {' '}
          ({filteredSessions.length} sessions, page {state.page + 1}/
          {totalPages})
        </Text>
      </Box>

      {/* Search indicator */}
      {state.searchMode && (
        <Box marginBottom={1}>
          <Text color={Colors.AccentYellow}>Search: </Text>
          <Text>{state.searchQuery}</Text>
          <Text color={Colors.Gray}>_</Text>
        </Box>
      )}

      {/* Sort indicator */}
      <Box marginBottom={1}>
        <Text dimColor>
          Sort: {state.sortField} ({getSortOrderDisplay(state.sortField, state.sortOrder)})
        </Text>
      </Box>

      {/* Session list */}
      <Box flexDirection="column">
        {paginatedSessions.map((session, idx) => {
          const isSelected = idx === state.selectedIndex;
          const isCurrent = session.id === currentSessionId;

          return (
            <Box key={session.id}>
              <Text
                color={isSelected ? Colors.AccentCyan : isCurrent ? Colors.AccentYellow : undefined}
                dimColor={isCurrent}
                inverse={isSelected}
              >
                {isSelected ? '> ' : '  '}
                {state.page * PAGE_SIZE + idx + 1}.{' '}
                {session.firstUserMessage ?? 'Empty session'}
                {isCurrent && ' (current)'}
              </Text>
              <Text dimColor>
                {' '}
                - {session.messageCount} msgs,{' '}
                {formatRelativeTime(session.lastUpdated)}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Help */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          j/k navigate | Enter resume | / search | x delete | s sort | r
          reverse | q quit
        </Text>
      </Box>
    </Box>
  );
}

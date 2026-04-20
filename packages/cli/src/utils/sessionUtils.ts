/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session utility functions for discovering, loading, and managing saved sessions.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ConversationRecord,
  type ResumedSessionData,
  type MessageRecord,
  type Config,
  isAssistantMessage,
} from '@vivo/bluecode-cli-core';

export const SESSION_FILE_PREFIX = 'session-';

export const RESUME_LATEST = 'latest';

/**
 * Information about a saved session for display purposes.
 */
export interface SessionInfo {
  /** Unique session ID (UUID) */
  id: string;
  /** Full path to the session file */
  filePath: string;
  /** When the session started */
  startTime: string;
  /** When the session was last updated */
  lastUpdated: string;
  /** Number of messages in the session */
  messageCount: number;
  /** AI-generated summary if available */
  summary?: string;
  /** First user message for display */
  firstUserMessage?: string;
  /** Full content for search (lazy loaded) */
  fullContent?: string;
}

/**
 * Result of session selection.
 */
export interface SessionSelectionResult {
  found: boolean;
  sessionPath?: string;
  sessionData?: ResumedSessionData;
  displayInfo?: SessionInfo;
  error?: string;
}

/**
 * Entry for a session file, including corrupted files.
 */
export interface SessionFileEntry {
  filePath: string;
  data: ConversationRecord | null;
  error?: string;
}

/**
 * Cleans a message for display by removing excessive whitespace.
 */
export function cleanMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts the first user message from a session for display.
 */
export function extractFirstUserMessage(messages: MessageRecord[]): string {
  const firstUserMsg = messages.find((m) => m.type === 'user');
  if (!firstUserMsg) {
    return 'Empty session';
  }

  const content =
    typeof firstUserMsg.content === 'string'
      ? firstUserMsg.content
      : JSON.stringify(firstUserMsg.content);

  const cleaned = cleanMessage(content);
  return cleaned.length > 60 ? cleaned.slice(0, 60) + '...' : cleaned;
}

/**
 * Formats a timestamp as relative time (e.g., "2 hours ago").
 */
export function formatRelativeTime(
  timestamp: string,
  style: 'short' | 'long' = 'short'
): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (style === 'short') {
    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    return 'just now';
  }

  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMins > 0) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Gets the chat directory path for session storage.
 */
function getChatDirectory(config: Config): string {
  const tmpDir = config.storage.getProjectTempDir();
  return path.join(tmpDir, 'chats');
}

/**
 * Checks if a session has at least one user or assistant message.
 */
function hasUserOrAssistantMessage(conversation: ConversationRecord): boolean {
  return conversation.messages.some(
    (msg: MessageRecord) => msg.type === 'user' || isAssistantMessage(msg)
  );
}

/**
 * Loads all session files, including corrupted ones.
 */
export async function getAllSessionFiles(
  config: Config
): Promise<SessionFileEntry[]> {
  const chatDir = getChatDirectory(config);

  try {
    const files = await fs.readdir(chatDir);
    const sessionFiles = files.filter(
      (f) => f.startsWith(SESSION_FILE_PREFIX) && f.endsWith('.json')
    );

    const entries: SessionFileEntry[] = [];

    for (const fileName of sessionFiles) {
      const filePath = path.join(chatDir, fileName);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content) as ConversationRecord;
        entries.push({ filePath, data });
      } catch (error) {
        entries.push({
          filePath,
          data: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Loads valid session files only.
 * Deduplicates by sessionId, keeping the most recently updated version.
 */
export async function getSessionFiles(config: Config): Promise<SessionInfo[]> {
  const entries = await getAllSessionFiles(config);

  // Use Map to deduplicate by sessionId, keeping the most recently updated
  const sessionMap = new Map<string, SessionInfo>();

  for (const entry of entries) {
    if (!entry.data || !hasUserOrAssistantMessage(entry.data)) {
      continue;
    }

    const sessionInfo: SessionInfo = {
      id: entry.data.sessionId,
      filePath: entry.filePath,
      startTime: entry.data.startTime,
      lastUpdated: entry.data.lastUpdated,
      messageCount: entry.data.messages.length,
      summary: entry.data.summary,
      firstUserMessage: extractFirstUserMessage(entry.data.messages),
    };

    const existing = sessionMap.get(sessionInfo.id);
    if (
      !existing ||
      new Date(sessionInfo.lastUpdated).getTime() >
        new Date(existing.lastUpdated).getTime()
    ) {
      sessionMap.set(sessionInfo.id, sessionInfo);
    }
  }

  const sessions = Array.from(sessionMap.values());

  // Sort by lastUpdated descending (most recent first)
  sessions.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
  );

  return sessions;
}

/**
 * Session selector for finding and loading sessions.
 */
export class SessionSelector {
  constructor(private config: Config) {}

  /**
   * Lists all available sessions.
   */
  async listSessions(): Promise<SessionInfo[]> {
    return getSessionFiles(this.config);
  }

  /**
   * Finds a session by UUID or 1-based index.
   */
  async findSession(identifier: string): Promise<SessionInfo | undefined> {
    const sessions = await this.listSessions();

    // Try as UUID first
    const byId = sessions.find((s) => s.id === identifier);
    if (byId) {
      return byId;
    }

    // Try as 1-based index
    const index = parseInt(identifier, 10);
    if (!isNaN(index) && index >= 1 && index <= sessions.length) {
      return sessions[index - 1];
    }

    return undefined;
  }

  /**
   * Resolves a resume argument to session data.
   * @param resumeArg - "latest", UUID, or 1-based index
   */
  async resolveSession(resumeArg: string): Promise<SessionSelectionResult> {
    const sessions = await this.listSessions();

    if (sessions.length === 0) {
      return { found: false, error: 'No sessions found' };
    }

    let session: SessionInfo | undefined;

    if (resumeArg === RESUME_LATEST) {
      session = sessions[0]; // Already sorted by most recent
    } else {
      session = await this.findSession(resumeArg);
    }

    if (!session) {
      return { found: false, error: `Session not found: ${resumeArg}` };
    }

    return this.selectSession(session);
  }

  /**
   * Loads full session data for a given session info.
   */
  async selectSession(sessionInfo: SessionInfo): Promise<SessionSelectionResult> {
    try {
      const content = await fs.readFile(sessionInfo.filePath, 'utf-8');
      const conversation = JSON.parse(content) as ConversationRecord;

      return {
        found: true,
        sessionPath: sessionInfo.filePath,
        sessionData: {
          conversation,
          filePath: sessionInfo.filePath,
        },
        displayInfo: sessionInfo,
      };
    } catch (error) {
      return {
        found: false,
        error: `Failed to load session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

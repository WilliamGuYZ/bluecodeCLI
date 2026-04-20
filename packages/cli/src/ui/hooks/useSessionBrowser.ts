/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook for managing the session browser UI state and interactions.
 */

import { useState, useCallback } from 'react';
import type { Content, Part, PartListUnion } from '@google/genai';
import type {
  Config,
  ResumedSessionData,
  ConversationRecord,
  ToolCallRecord,
  Status,
  ToolResultDisplay,
} from '@vivo/bluecode-cli-core';
import { isAssistantMessage } from '@vivo/bluecode-cli-core';
import type { SessionInfo } from '../../utils/sessionUtils.js';
import { SessionSelector } from '../../utils/sessionUtils.js';
import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';
import { stripThinkContent } from '../utils/thinkFilters.js';

/**
 * Truncates text to a maximum length and adds ellipsis if needed.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}

/**
 * Formats tool description from tool call record with detailed information.
 */
function formatToolDescription(toolCall: ToolCallRecord): string {
  if (toolCall.displayName) {
    return toolCall.displayName;
  }

  // Extract description from args
  if (
    toolCall.args.description &&
    typeof toolCall.args.description === 'string'
  ) {
    return toolCall.args.description;
  }

  // Generate detailed description based on tool type
  const args = toolCall.args;

  switch (toolCall.name) {
    case 'read_file':
    case 'read':
      if (args.absolute_path || args.file_path || args.filePath) {
        const path = args.absolute_path || args.file_path || args.filePath;
        return `Read file: ${path}`;
      }
      break;

    case 'read_many_files':
      // ReadManyFiles can have: paths, include, exclude
      if (args.paths && Array.isArray(args.paths)) {
        const pathCount = args.paths.length;
        const includePatterns =
          args.include && Array.isArray(args.include) ? args.include : [];
        const excludePatterns =
          args.exclude && Array.isArray(args.exclude) ? args.exclude : [];

        // Build description parts
        const parts: string[] = [];

        // Show path count and first few paths
        if (pathCount === 1) {
          parts.push(`Read files in: ${args.paths[0]}`);
        } else if (pathCount <= 3) {
          parts.push(`Read files in: ${args.paths.join(', ')}`);
        } else {
          parts.push(
            `Read files in ${pathCount} paths: ${args.paths.slice(0, 2).join(', ')}...`,
          );
        }

        // Add include patterns if present
        if (includePatterns.length > 0) {
          if (includePatterns.length === 1) {
            parts.push(`include: ${includePatterns[0]}`);
          } else {
            parts.push(
              `include: ${includePatterns.slice(0, 2).join(', ')}${includePatterns.length > 2 ? '...' : ''}`,
            );
          }
        }

        // Add exclude patterns if present
        if (excludePatterns.length > 0) {
          if (excludePatterns.length === 1) {
            parts.push(`exclude: ${excludePatterns[0]}`);
          } else {
            parts.push(
              `exclude: ${excludePatterns.slice(0, 2).join(', ')}${excludePatterns.length > 2 ? '...' : ''}`,
            );
          }
        }

        return parts.join(' | ');
      }
      break;

    case 'write_file':
    case 'write':
      if (args.file_path || args.filePath) {
        const path = args.file_path || args.filePath;
        return `Write file: ${path}`;
      }
      break;

    case 'edit':
    case 'replace':
      if (args.file_path || args.filePath) {
        const path = args.file_path || args.filePath;
        return `Edit file: ${path}`;
      }
      break;

    case 'run_shell_command':
    case 'bash':
    case 'shell':
      if (args.command) {
        const cmd = String(args.command);
        const truncated = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
        return `Run: ${truncated}`;
      }
      break;

    case 'glob':
    case 'find_files':
      if (args.pattern) {
        return `Find files: ${args.pattern}`;
      }
      break;

    case 'grep':
    case 'search':
      if (args.pattern) {
        return `Search: ${args.pattern}`;
      }
      break;

    case 'task':
      if (args.prompt) {
        const prompt = String(args.prompt);
        const truncated =
          prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt;
        return `Task: ${truncated}`;
      }
      break;

    default:
      // For other tools, try to find a meaningful parameter
      if (args.path) {
        return `${toolCall.name}: ${args.path}`;
      }
      if (args.url) {
        return `${toolCall.name}: ${args.url}`;
      }
      if (args.name) {
        return `${toolCall.name}: ${args.name}`;
      }
  }

  // Default to tool name
  return toolCall.name;
}

/**
 * Formats tool result for display.
 */
function formatToolResult(result: PartListUnion | null): string {
  if (!result) return '';

  if (typeof result === 'string') {
    return result;
  }

  if (Array.isArray(result)) {
    return result
      .map((part) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

/**
 * Maps storage status to UI status for historical tool calls.
 * For historical records, we treat scheduled/validating as success since they're in the past.
 */
function mapStatusToToolCallStatus(
  status: Status,
  hasResult: boolean,
): ToolCallStatus {
  // If the tool call has a result, it was executed successfully
  if (hasResult && (status === 'scheduled' || status === 'validating')) {
    return ToolCallStatus.Success;
  }

  const statusMap: Record<Status, ToolCallStatus> = {
    validating: ToolCallStatus.Success, // Historical validating means it was validated
    scheduled: ToolCallStatus.Success, // Historical scheduled means it was executed
    executing: ToolCallStatus.Executing,
    success: ToolCallStatus.Success,
    error: ToolCallStatus.Error,
    cancelled: ToolCallStatus.Canceled,
    awaiting_approval: ToolCallStatus.Confirming,
  };

  return statusMap[status] || ToolCallStatus.Success;
}

/**
 * Converts stored session messages to UI and client history formats.
 */
export function convertSessionToHistoryFormats(
  messages: ConversationRecord['messages'],
): {
  uiHistory: HistoryItemWithoutId[];
  clientHistory: Content[];
} {
  const uiHistory: HistoryItemWithoutId[] = [];
  const clientHistory: Content[] = [];

  for (const msg of messages) {
    if (msg.type === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);

      // Truncate user message for UI display (max 200 characters)
      const displayText = truncateText(content, 200);

      uiHistory.push({
        type: 'user',
        text: displayText,
      });

      // Keep full content for client history (Gemini API needs complete context)
      clientHistory.push({
        role: 'user',
        parts: [{ text: content }] as Part[],
      });
    } else if (isAssistantMessage(msg)) {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);

      // Add assistant message to UI history if there's text content
      if (content.trim()) {
        uiHistory.push({
          type: 'gemini',
          text: stripThinkContent(content),
        });
      }

      clientHistory.push({
        role: 'model',
        parts: [{ text: content }] as Part[],
      });

      // Handle tool calls if present
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Convert tool calls to UI display format
        const toolDisplays: IndividualToolCallDisplay[] = msg.toolCalls.map(
          (toolCall) => ({
            callId: toolCall.id,
            name: toolCall.name,
            description:
              toolCall.description || formatToolDescription(toolCall),
            resultDisplay: toolCall.resultDisplay
              ? toolCall.resultDisplay
              : toolCall.result
                ? formatToolResult(toolCall.result)
                : undefined,
            status: mapStatusToToolCallStatus(
              toolCall.status,
              !!toolCall.result,
            ),
            confirmationDetails: undefined, // Historical records don't need confirmation
            renderOutputAsMarkdown: toolCall.renderOutputAsMarkdown,
          }),
        );

        // Add tool group to UI history
        uiHistory.push({
          type: 'tool_group',
          tools: toolDisplays,
        });

        for (const toolCall of msg.toolCalls) {
          // Add function call to client history
          clientHistory.push({
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: toolCall.name,
                  args: toolCall.args || {},
                },
              },
            ] as Part[],
          });

          // Add function response if available
          if (toolCall.result !== undefined) {
            clientHistory.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: toolCall.name,
                    response: { result: toolCall.result },
                  },
                },
              ] as Part[],
            });
          }
        }
      }
    }
  }

  return { uiHistory, clientHistory };
}

interface UseSessionBrowserReturn {
  isSessionBrowserOpen: boolean;
  openSessionBrowser: () => void;
  closeSessionBrowser: () => void;
  handleResumeSession: (session: SessionInfo) => Promise<void>;
  handleDeleteSession: (session: SessionInfo) => Promise<void>;
}

/**
 * Hook for managing session browser state and interactions.
 */
export function useSessionBrowser(
  config: Config | null,
  onLoadHistory: (
    uiHistory: HistoryItemWithoutId[],
    clientHistory: Content[],
    resumedSessionData: ResumedSessionData
  ) => Promise<void>
): UseSessionBrowserReturn {
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);

  const openSessionBrowser = useCallback(() => {
    setIsSessionBrowserOpen(true);
  }, []);

  const closeSessionBrowser = useCallback(() => {
    setIsSessionBrowserOpen(false);
  }, []);

  const handleResumeSession = useCallback(
    async (session: SessionInfo) => {
      if (!config) {
        return;
      }

      const selector = new SessionSelector(config);
      const result = await selector.selectSession(session);

      if (!result.found || !result.sessionData) {
        return;
      }

      const { uiHistory, clientHistory } = convertSessionToHistoryFormats(
        result.sessionData.conversation.messages
      );

      await onLoadHistory(uiHistory, clientHistory, result.sessionData);
      closeSessionBrowser();
    },
    [config, onLoadHistory, closeSessionBrowser]
  );

  const handleDeleteSession = useCallback(
    async (session: SessionInfo) => {
      if (!config) {
        return;
      }

      const recordingService = config.getGeminiClient()?.getChatRecordingService();
      if (recordingService) {
        recordingService.deleteSession(session.filePath);
      }
    },
    [config]
  );

  return {
    isSessionBrowserOpen,
    openSessionBrowser,
    closeSessionBrowser,
    handleResumeSession,
    handleDeleteSession,
  };
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'node:fs/promises';
import React from 'react';
import { Text } from 'ink';
import { Colors } from '../colors.js';
import type {
  CommandContext,
  SlashCommand,
  MessageActionReturn,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { decodeTagName } from '@vivo/bluecode-cli-core';
import path from 'node:path';
import type { HistoryItemWithoutId } from '../types.js';
import { MessageType } from '../types.js';

interface ChatDetail {
  name: string;
  mtime: Date;
}

const getSavedChatTags = async (
  context: CommandContext,
  mtSortDesc: boolean,
): Promise<ChatDetail[]> => {
  const cfg = context.services.config;
  const geminiDir = cfg?.storage?.getProjectTempDir();
  if (!geminiDir) {
    return [];
  }
  try {
    const file_head = 'checkpoint-';
    const file_tail = '.json';
    const files = await fsPromises.readdir(geminiDir);
    const chatDetails: Array<{ name: string; mtime: Date }> = [];

    for (const file of files) {
      if (file.startsWith(file_head) && file.endsWith(file_tail)) {
        const filePath = path.join(geminiDir, file);
        const stats = await fsPromises.stat(filePath);
        const tagName = file.slice(file_head.length, -file_tail.length);
        chatDetails.push({
          name: decodeTagName(tagName),
          mtime: stats.mtime,
        });
      }
    }

    chatDetails.sort((a, b) =>
      mtSortDesc
        ? b.mtime.getTime() - a.mtime.getTime()
        : a.mtime.getTime() - b.mtime.getTime(),
    );

    return chatDetails;
  } catch (_err) {
    return [];
  }
};

const listCommand: SlashCommand = {
  name: 'list',
  description: '列出已保存的对话检查点',
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<MessageActionReturn> => {
    const chatDetails = await getSavedChatTags(context, false);
    if (chatDetails.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: '未找到已保存的对话检查点.',
      };
    }

    const maxNameLength = Math.max(
      ...chatDetails.map((chat) => chat.name.length),
    );

    let message = '已保存对话列表:\n\n';
    for (const chat of chatDetails) {
      const paddedName = chat.name.padEnd(maxNameLength, ' ');
      // const isoString = chat.mtime.toISOString();
      // const match = isoString.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
      // const formattedDate = match ? `${match[1]} ${match[2]}` : 'Invalid Date';
      const pad = (n: number) => String(n).padStart(2, '0');
      const d = chat.mtime;
      const formattedDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      message += `  - \u001b[36m${paddedName}\u001b[0m  \u001b[90m(saved on ${formattedDate})\u001b[0m\n`;
    }
    message += `\n\u001b[90mNote: Newest last, oldest first\u001b[0m`;
    return {
      type: 'message',
      messageType: 'info',
      content: message,
    };
  },
};

const saveCommand: SlashCommand = {
  name: 'save',
  description:
    '将当前对话保存为检查点 用法：/chat save <tag>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const tag = args.trim();
    if (!tag) {
      return {
        type: 'message',
        messageType: 'error',
        content: '缺少标签 用法：/chat save <tag>',
      };
    }

    const { logger, config } = context.services;
    await logger.initialize();

    if (!context.overwriteConfirmed) {
      const exists = await logger.checkpointExists(tag);
      if (exists) {
        return {
          type: 'confirm_action',
          prompt: React.createElement(
            Text,
            null,
            '标签 ',
            React.createElement(Text, { color: Colors.AccentPurple }, tag),
            '已经存在，是否覆盖？',
          ),
          originalInvocation: {
            raw: context.invocation?.raw || `/chat save ${tag}`,
          },
        };
      }
    }

    const chat = await config?.getGeminiClient()?.getChat();
    if (!chat) {
      return {
        type: 'message',
        messageType: 'error',
        content: '没有可用的聊天客户端来保存对话',
      };
    }

    const history = chat.getHistory();
    if (history.length > 2) {
      await logger.saveCheckpoint(history, tag);
      return {
        type: 'message',
        messageType: 'info',
        content: `标签: ${decodeTagName(tag)} 对话检查点已保存`,
      };
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: '未找到要保存的对话',
      };
    }
  },
};

const resumeCommand: SlashCommand = {
  name: 'resume',
  altNames: ['load'],
  description:
    '从检查点恢复对话 用法：/chat resume <tag>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const tag = args.trim();
    if (!tag) {
      return {
        type: 'message',
        messageType: 'error',
        content: '缺少标签 用法：/chat resume <tag>',
      };
    }

    const { logger } = context.services;
    await logger.initialize();
    const conversation = await logger.loadCheckpoint(tag);

    if (conversation.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: `未找到: ${decodeTagName(tag)} 检查点`,
      };
    }

    const rolemap: { [key: string]: MessageType } = {
      user: MessageType.USER,
      model: MessageType.GEMINI,
    };

    const uiHistory: HistoryItemWithoutId[] = [];
    let hasSystemPrompt = false;
    let i = 0;

    for (const item of conversation) {
      i += 1;
      const text =
        item.parts
          ?.filter((m) => !!m.text)
          .map((m) => m.text)
          .join('') || '';
      if (!text) {
        continue;
      }
      if (i === 1 && text.match(/context for our chat/)) {
        hasSystemPrompt = true;
      }
      if (i > 2 || !hasSystemPrompt) {
        uiHistory.push({
          type: (item.role && rolemap[item.role]) || MessageType.GEMINI,
          text,
        } as HistoryItemWithoutId);
      }
    }
    return {
      type: 'load_history',
      history: uiHistory,
      clientHistory: conversation,
    };
  },
  completion: async (context, partialArg) => {
    const chatDetails = await getSavedChatTags(context, true);
    return chatDetails
      .map((chat) => chat.name)
      .filter((name) => name.startsWith(partialArg));
  },
};

const deleteCommand: SlashCommand = {
  name: 'delete',
  description: '删除对话检查点 用法：/chat delete <tag>',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const tag = args.trim();
    if (!tag) {
      return {
        type: 'message',
        messageType: 'error',
        content: '缺少标签 用法：/chat delete <tag>',
      };
    }

    const { logger } = context.services;
    await logger.initialize();
    const deleted = await logger.deleteCheckpoint(tag);

    if (deleted) {
      return {
        type: 'message',
        messageType: 'info',
        content: `对话检查点'${decodeTagName(tag)}' 已被删除`,
      };
    } else {
      return {
        type: 'message',
        messageType: 'error',
        content: `Error: 未找到带有标签 '${decodeTagName(tag)}' 的检查点`,
      };
    }
  },
  completion: async (context, partialArg) => {
    const chatDetails = await getSavedChatTags(context, true);
    return chatDetails
      .map((chat) => chat.name)
      .filter((name) => name.startsWith(partialArg));
  },
};

export const chatCommand: SlashCommand = {
  name: 'chat',
  description: '管理对话历史',
  kind: CommandKind.BUILT_IN,
  subCommands: [listCommand, saveCommand, resumeCommand, deleteCommand],
};

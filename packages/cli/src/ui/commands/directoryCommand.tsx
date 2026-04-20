/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadServerHierarchicalMemory } from '@vivo/bluecode-cli-core';

export function expandHomeDir(p: string): string {
  if (!p) {
    return '';
  }
  let expandedPath = p;
  if (p.toLowerCase().startsWith('%userprofile%')) {
    expandedPath = os.homedir() + p.substring('%userprofile%'.length);
  } else if (p === '~' || p.startsWith('~/')) {
    expandedPath = os.homedir() + p.substring(1);
  }
  return path.normalize(expandedPath);
}

export const directoryCommand: SlashCommand = {
  name: 'directory',
  altNames: ['dir'],
  description: '管理工作区目录',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'add',
      description:
        '将目录添加到工作区 使用逗号分隔多个路径',
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args: string) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;
        const [...rest] = args.split(' ');

        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: '配置不可用',
            },
            Date.now(),
          );
          return;
        }

        const workspaceContext = config.getWorkspaceContext();

        const pathsToAdd = rest
          .join(' ')
          .split(',')
          .filter((p) => p);
        if (pathsToAdd.length === 0) {
          addItem(
            {
              type: MessageType.ERROR,
              text: '请提供至少一条要添加的路径',
            },
            Date.now(),
          );
          return;
        }

        if (config.isRestrictiveSandbox()) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content:
              '沙盒配置文件不支持 /directory add 命令. 请在启动会话时使用 --include-directories 命令选项来启用此功能',
          };
        }

        const added: string[] = [];
        const errors: string[] = [];

        for (const pathToAdd of pathsToAdd) {
          try {
            workspaceContext.addDirectory(expandHomeDir(pathToAdd.trim()));
            added.push(pathToAdd.trim());
          } catch (e) {
            const error = e as Error;
            errors.push(`Error adding '${pathToAdd.trim()}': ${error.message}`);
          }
        }

        try {
          if (config.shouldLoadMemoryFromIncludeDirectories()) {
            const { memoryContent, fileCount } =
              await loadServerHierarchicalMemory(
                config.getWorkingDir(),
                [
                  ...config.getWorkspaceContext().getDirectories(),
                  ...pathsToAdd,
                ],
                config.getDebugMode(),
                config.getFileService(),
                config.getExtensionContextFilePaths(),
                context.services.settings.merged.context?.importFormat ||
                  'tree', // Use setting or default to 'tree'
                config.getFileFilteringOptions(),
                context.services.settings.merged.context?.discoveryMaxDirs,
              );
            config.setUserMemory(memoryContent);
            config.setGeminiMdFileCount(fileCount);
            context.ui.setGeminiMdFileCount(fileCount);
          }
          addItem(
            {
              type: MessageType.INFO,
              text: `成功从以下目录添加 AGENTS.md 文件（如果存在：\n- ${added.join('\n- ')}`,
            },
            Date.now(),
          );
        } catch (error) {
          errors.push(`Error refreshing memory: ${(error as Error).message}`);
        }

        if (added.length > 0) {
          const gemini = config.getGeminiClient();
          if (gemini) {
            await gemini.addDirectoryContext();
          }
          addItem(
            {
              type: MessageType.INFO,
              text: `成功添加目录:\n- ${added.join('\n- ')}`,
            },
            Date.now(),
          );
        }

        if (errors.length > 0) {
          addItem(
            { type: MessageType.ERROR, text: errors.join('\n') },
            Date.now(),
          );
        }
        return;
      },
    },
    {
      name: 'show',
      description: '显示所有目录的工作区目录',
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;
        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: '配置不可用',
            },
            Date.now(),
          );
          return;
        }
        const workspaceContext = config.getWorkspaceContext();
        const directories = workspaceContext.getDirectories();
        const directoryList = directories.map((dir) => `- ${dir}`).join('\n');
        addItem(
          {
            type: MessageType.INFO,
            text: `当前工作区目录:\n${directoryList}`,
          },
          Date.now(),
        );
      },
    },
  ],
};

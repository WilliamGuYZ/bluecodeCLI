/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { IDEServer } from './ide-server.js';
import { DiffContentProvider, DiffManager } from './diff-manager.js';
import { createLogger } from './utils/logger.js';

const INFO_MESSAGE_SHOWN_KEY = 'geminiCliInfoMessageShown';
export const DIFF_SCHEME = 'gemini-diff';

let ideServer: IDEServer;
let logger: vscode.OutputChannel;

let log: (message: string) => void = () => {};


// 在右侧打开终端并运行blue-code
async function startBlueCodeInRightTerminal(context: vscode.ExtensionContext) {
  // 确保工作区路径有效
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length !== 1) {
    vscode.window.showErrorMessage("BlueCode CLI 需要单个工作区文件夹");
    return;
  }

  const workspacePath = workspaceFolders[0].uri.fsPath;

  // 查找现有的BlueCode CLI终端
  let terminal = vscode.window.terminals.find(t => t.name === "BlueCode CLI");

  if (terminal) {
    // 如果已存在，直接显示在右侧
    terminal.show(true);
  } else {
    // 创建新的终端，使用ViewColumn.Two确保在右侧区域
    terminal = vscode.window.createTerminal({
      name: "BlueCode CLI",
      location: { viewColumn: vscode.ViewColumn.Two },
      cwd: workspacePath,
      iconPath: vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png')
    });
  }

  // 延迟执行以确保终端完全创建并移动到右侧
  setTimeout(() => {
    terminal.show(true);
    terminal.sendText("npx bluecode");
  }, 100);
}

export async function activate(context: vscode.ExtensionContext) {
  logger = vscode.window.createOutputChannel('BlueCode CLI IDE Companion');
  log = createLogger(context, logger);

  // logger.show();

  // 详细的启动日志
  log('🚀 Extension activation started');
  log(`Extension Mode: ${context.extensionMode === 1 ? 'Development' : 'Production'}`);
  log(`Extension Path: ${context.extensionPath}`);
  log("🔧 Extension activated in console");
  console.log('Extension Context:', {
    mode: context.extensionMode,
    path: context.extensionPath,
    globalStoragePath: context.globalStorageUri?.fsPath
  });

  const diffContentProvider = new DiffContentProvider();
  const diffManager = new DiffManager(log, diffContentProvider);

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === DIFF_SCHEME) {
        diffManager.cancelDiff(doc.uri);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      diffContentProvider,
    ),
    vscode.commands.registerCommand(
      'cli.diff.accept',
      (uri?: vscode.Uri) => {
        const docUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (docUri && docUri.scheme === DIFF_SCHEME) {
          diffManager.acceptDiff(docUri);
        }
      },
    ),
    vscode.commands.registerCommand(
      'cli.diff.cancel',
      (uri?: vscode.Uri) => {
        const docUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (docUri && docUri.scheme === DIFF_SCHEME) {
          diffManager.cancelDiff(docUri);
        }
      },
    ),
  );

  ideServer = new IDEServer(log, diffManager);
  try {
    await ideServer.start(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to start IDE server: ${message}`);
  }

  if (!context.globalState.get(INFO_MESSAGE_SHOWN_KEY)) {
    void vscode.window.showInformationMessage(
      'Bluecode CLI Companion extension successfully installed.',
    );
    context.globalState.update(INFO_MESSAGE_SHOWN_KEY, true);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ideServer.updateWorkspacePath();
    }),
    vscode.commands.registerCommand(
      'bluecode-cli.startInRightTerminal', 
      () => startBlueCodeInRightTerminal(context) // 传入
    ),
    vscode.commands.registerCommand('bluecode-cli.runBlueCodeCLI', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showInformationMessage(
          'No folder open. Please open a folder to run Bluecode CLI.',
        );
        return;
      }

      let selectedFolder: vscode.WorkspaceFolder | undefined;
      if (workspaceFolders.length === 1) {
        selectedFolder = workspaceFolders[0];
      } else {
        selectedFolder = await vscode.window.showWorkspaceFolderPick({
          placeHolder: 'Select a folder to run Bluecode CLI in',
        });
      }

      if (selectedFolder) {
        const geminiCmd = 'npx bluecode';
        const terminal = vscode.window.createTerminal({
          name: `Bluecode CLI (${selectedFolder.name})`,
          cwd: selectedFolder.uri.fsPath,
        });
        terminal.show();
        terminal.sendText(geminiCmd);
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  log('Extension deactivated');
  try {
    if (ideServer) {
      await ideServer.stop();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to stop IDE server during deactivation: ${message}`);
  } finally {
    if (logger) {
      logger.dispose();
    }
  }
}

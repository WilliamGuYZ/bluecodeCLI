/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink';
import { AppWrapper } from './ui/App.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import { readStdin } from './utils/readStdin.js';
import { basename } from 'node:path';
import v8 from 'node:v8';
import os from 'node:os';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import { start_sandbox } from './utils/sandbox.js';
import { DnsResolutionOrder, LoadedSettings, ensureDefaultSessionRetention } from './config/settings.js';
import { loadSettings } from './config/settings.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { loadExtensions } from './config/extension.js';
import { cleanupCheckpoints, registerCleanup } from './utils/cleanup.js';
import { getCliVersion } from './utils/version.js';
import {
  SessionSelector,
  RESUME_LATEST,
  formatRelativeTime,
} from './utils/sessionUtils.js';
import { Config } from '@vivo/bluecode-cli-core';
import type { ResumedSessionData } from '@vivo/bluecode-cli-core';
import {
  sessionId,
  logUserPrompt,
  AuthType,
  getOauthClient,
  logIdeConnection,
  IdeConnectionEvent,
  IdeConnectionType,
  FatalConfigError,
} from '@vivo/bluecode-cli-core';
import { validateAuthMethod } from './config/auth.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { detectAndEnableKittyProtocol } from './ui/utils/kittyProtocolDetector.js';
import { checkForUpdates } from './ui/utils/updateCheck.js';
import { handleAutoUpdate } from './utils/handleAutoUpdate.js';
import { appEvents, AppEvent } from './utils/events.js';
import { initializeDefaultModel } from './ui/utils/modelUtils.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import { runZedIntegration } from './zed-integration/zedIntegration.js';
import { initUser } from './auth/login.js';
import { isUserAccess } from './auth/index.js';
// import { CliPluginUpdater } from '@vivo/bluecode-cli-core'
// 添加global类型声明
declare global {
  var preloadedEnv: {
    authType: string;
    model: string;
    OPENAI_API_KEY?: string;
    OPENAI_BASE_URL?: string;
    OPENAI_MODEL?: string;
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    CUSTOM_LLM_API_KEY?: string;
    CUSTOM_LLM_BASE_URL?: string;
    CUSTOM_LLM_MODEL?: string;
  } | undefined;
}

export function validateDnsResolutionOrder(
  order: string | undefined,
): DnsResolutionOrder {
  const defaultValue: DnsResolutionOrder = 'ipv4first';
  if (order === undefined) {
    return defaultValue;
  }
  if (order === 'ipv4first' || order === 'verbatim') {
    return order;
  }
  // We don't want to throw here, just warn and use the default.
  console.warn(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`,
  );
  return defaultValue;
}

function getNodeMemoryArgs(config: Config): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (config.getDebugMode()) {
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['GEMINI_CLI_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (config.getDebugMode()) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

async function relaunchWithAdditionalArgs(additionalArgs: string[]) {
  const nodeArgs = [...additionalArgs, ...process.argv.slice(1)];
  const newEnv = { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true' };

  const child = spawn(process.execPath, nodeArgs, {
    stdio: 'inherit',
    env: newEnv,
  });

  await new Promise((resolve) => child.on('close', resolve));
  process.exit(0);
}

export function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on('unhandledRejection', (reason, _promise) => {
    const errorMessage = `=========================================
This is an unexpected error. Please file a bug report using the /bug tool.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: ${reason}${reason instanceof Error && reason.stack
        ? `
Stack trace:
${reason.stack}`
        : ''
      }`;
    appEvents.emit(AppEvent.LogError, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit(AppEvent.OpenDebugConsole);
    }
  });
}

export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string,
  resumedSessionData?: ResumedSessionData,
) {
  const version = await getCliVersion();
  // Detect and enable Kitty keyboard protocol once at startup
  await detectAndEnableKittyProtocol();
  setWindowTitle(basename(workspaceRoot), settings);
  const instance = render(
    <React.StrictMode>
      <SettingsContext.Provider value={settings}>
        <AppWrapper
          config={config}
          settings={settings}
          startupWarnings={startupWarnings}
          version={version}
          resumedSessionData={resumedSessionData}
        />
      </SettingsContext.Provider>
    </React.StrictMode>,
    { exitOnCtrlC: false, isScreenReaderEnabled: config.getScreenReader() },
  );

  checkForUpdates()
    .then((info) => {
      handleAutoUpdate(info, settings, config.getProjectRoot());
    })
    .catch((err) => {
      // Silently ignore update check errors.
      if (config.getDebugMode()) {
        console.error('Update check failed:', err);
      }
    });

  registerCleanup(() => instance.unmount());
}

export async function main() {
  // // 打印进程内存信息                                                                               
  // const heapStats = v8.getHeapStatistics();                                                         
  // const heapSizeMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);                           
  // const totalHeapSizeMB = Math.round(heapStats.total_heap_size / 1024 / 1024);                      
  // const usedHeapSizeMB = Math.round(heapStats.used_heap_size / 1024 / 1024);                        

  // console.log('\n[BlueCode CLI] ===== 内存信息 =====');                                             
  // console.log(`[BlueCode CLI] Node.js 最大堆内存限制: ${heapSizeMB} MB`);                           
  // console.log(`[BlueCode CLI] 当前进程 PID: ${process.pid}`);                                       
  // console.log(`[BlueCode CLI] 总堆内存大小: ${totalHeapSizeMB} MB`);                                
  // console.log(`[BlueCode CLI] 已使用堆内存: ${usedHeapSizeMB} MB`);                                 
  // console.log(`[BlueCode CLI] 可用堆内存: ${heapSizeMB - usedHeapSizeMB} MB`);                      
  // console.log('[BlueCode CLI] =========================\n');  

  // 先进行用户认证
  // console.log('\n[AUTH] Initializing user authentication...');
  let authenticatedUserId: string | undefined;
  try {
    const userId = await initUser();
    authenticatedUserId = userId || undefined;
    // This avoids timing issues where the LLM adapter is created before we can call config.setCustomData().
    if (authenticatedUserId) {
      process.env['BLUECODE_USER_ID'] = authenticatedUserId;
    }
    if (userId) {
      // 判断用户是否在白名单中
      const canAccess = await isUserAccess(userId)
      if (!canAccess) {
        console.warn('[AUTH] Authentication failed: permission denied.');
        process.exit(1);
      }
    }
  } catch (error) {
    console.warn('[AUTH] Authentication failed:', error);
    process.exit(1);
  }

  setupUnhandledRejectionHandler();
  // updateCliPlugin(); // 更新插件
  const workspaceRoot = process.cwd();
  const settings = loadSettings(workspaceRoot);

  // Ensure default sessionRetention config is written on first launch
  ensureDefaultSessionRetention(settings);

  await cleanupCheckpoints();
  if (settings.errors.length > 0) {
    const errorMessages = settings.errors.map(
      (error) => `Error in ${error.path}: ${error.message}`,
    );
    throw new FatalConfigError(
      `${errorMessages.join('\n')}\nPlease fix the configuration file(s) and try again.`,
    );
  }

  const argv = await parseArguments(settings.merged);
  const extensions = loadExtensions(workspaceRoot);
  const config = await loadCliConfig(
    settings.merged, // 系统，用户，项目配置settings.json 文件
    extensions,
    sessionId,
    argv, // --help 参数
  );

  // 使userId能够传递给core/llm里的anthropic-adapter
  if (authenticatedUserId) {
    config.setCustomData('userId', authenticatedUserId);
  }

  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: config.getDebugMode(),
  });
  consolePatcher.patch();
  registerCleanup(consolePatcher.cleanup);

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder),
  );

  if (argv.promptInteractive && !process.stdin.isTTY) {
    console.error(
      'Error: The --prompt-interactive flag is not supported when piping input from stdin.',
    );
    process.exit(1);
  }

  if (config.getListExtensions()) {
    console.log('Installed extensions:');
    for (const extension of extensions) {
      console.log(`- ${extension.config.name}`);
    }
    process.exit(0);
  }

  // Handle --list-sessions
  if (argv.listSessions) {
    const selector = new SessionSelector(config);
    const sessions = await selector.listSessions();

    if (sessions.length === 0) {
      console.log('No saved sessions found.');
    } else {
      console.log('Available sessions:');
      sessions.forEach((session, idx) => {
        const time = formatRelativeTime(session.lastUpdated, 'long');
        console.log(
          `  ${idx + 1}. ${session.firstUserMessage ?? 'Empty'} (${session.messageCount} msgs, ${time})`
        );
      });
    }
    process.exit(0);
  }

  setMaxSizedBoxDebugging(config.getDebugMode());

  // 在config.initialize()之前先设置模型配置
  // console.log('[MODEL-INIT] Initializing model configuration...');
  const modelInitSuccess = await initializeDefaultModel(config, settings);
  if (!modelInitSuccess) {
    console.warn('[MODEL-INIT] Failed to initialize model configuration');
    process.exit(1);
  }

  await config.initialize();

  // @ts-expect-error selectedAuthType 为首次加载时兜底选项
  const authType = settings.merged?.security?.auth?.selectedType || settings.merged?.selectedAuthType
  // 确保认证配置正确设置，这样contentGeneratorConfig才不会为undefined
  if (authType) {
    try {
      // console.log(`[AUTH-CONFIG] Setting auth type: ${settings.merged?.security?.auth?.selectedType}`);
      await config.refreshAuth(authType);
      // console.log(`[AUTH-CONFIG] Auth config refreshed successfully`);
    } catch (error) {
      console.error(`[AUTH-CONFIG] Failed to refresh auth config:`, error);
    }
  }

  // 在initialize之后再次确保模型设置正确
  if (modelInitSuccess) {
    let currentModel = config.getModel();
    // 如果模型被重置，重新应用
    if (currentModel !== process.env.DEFAULT_MODEL && process.env.DEFAULT_MODEL) {
      config.setModel(process.env.DEFAULT_MODEL);
    }
  }
  // Empty key causes issues with the GoogleGenAI package.
  if (process.env['GEMINI_API_KEY']?.trim() === '') {
    delete process.env['GEMINI_API_KEY'];
  }

  if (process.env['GOOGLE_API_KEY']?.trim() === '') {
    delete process.env['GOOGLE_API_KEY'];
  }

  if (config.getIdeMode()) {
    await config.getIdeClient().connect();
    logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.START));
  }

  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);

  if (settings.merged.ui?.theme) {
    if (!themeManager.setActiveTheme(settings.merged.ui?.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in App.tsx will handle opening the dialog.
      console.warn(`Warning: Theme "${settings.merged.ui?.theme}" not found.`);
    }
  }

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env['SANDBOX']) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory
      ? getNodeMemoryArgs(config)
      : [];
    const sandboxConfig = config.getSandbox();
    if (sandboxConfig) {
      if (
        settings.merged.security?.auth?.selectedType &&
        !settings.merged.security?.auth?.useExternal
      ) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(
            settings.merged.security.auth.selectedType,
          );
          if (err) {
            throw new Error(err);
          }
          // prompts在这获取
          await config.refreshAuth(settings.merged?.security?.auth?.selectedType); 
        } catch (err) {
          console.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      let stdinData = '';
      if (!process.stdin.isTTY) {
        stdinData = await readStdin();
      }

      // This function is a copy of the one from sandbox.ts
      // It is moved here to decouple sandbox.ts from the CLI's argument structure.
      const injectStdinIntoArgs = (
        args: string[],
        stdinData?: string,
      ): string[] => {
        const finalArgs = [...args];
        if (stdinData) {
          const promptIndex = finalArgs.findIndex(
            (arg) => arg === '--prompt' || arg === '-p',
          );
          if (promptIndex > -1 && finalArgs.length > promptIndex + 1) {
            // If there's a prompt argument, prepend stdin to it
            finalArgs[promptIndex + 1] =
              `${stdinData}\n\n${finalArgs[promptIndex + 1]}`;
          } else {
            // If there's no prompt argument, add stdin as the prompt
            finalArgs.push('--prompt', stdinData);
          }
        }
        return finalArgs;
      };

      const sandboxArgs = injectStdinIntoArgs(process.argv, stdinData);

      await start_sandbox(sandboxConfig, memoryArgs, config, sandboxArgs);
      process.exit(0);
    } else {
      // Not in a sandbox and not entering one, so relaunch with additional
      // arguments to control memory usage if needed.
      if (memoryArgs.length > 0) {
        await relaunchWithAdditionalArgs(memoryArgs);
        process.exit(0);
      }
    }
  }

  if (
    settings.merged.security?.auth?.selectedType ===
      AuthType.LOGIN_WITH_GOOGLE &&
    config.isBrowserLaunchSuppressed()
  ) {
    // Do oauth before app renders to make copying the link possible.
    await getOauthClient(settings.merged.security.auth.selectedType, config);
  }

  if (config.getExperimentalZedIntegration()) {
    return runZedIntegration(config, settings, extensions, argv);
  }

  let input = config.getQuestion();
  const startupWarnings = [
    ...(await getStartupWarnings()),
    ...(await getUserStartupWarnings(workspaceRoot)),
  ];

  // Clean up expired sessions based on retention settings
  const sessionRetention = settings.merged.general?.sessionRetention;
  if (sessionRetention?.enabled) {
    try {
      const { cleanupExpiredSessions } = await import(
        './utils/sessionCleanup.js'
      );
      const result = await cleanupExpiredSessions(config, {
        enabled: true,
        maxAge: sessionRetention.maxAge,
        maxCount: sessionRetention.maxCount,
        minRetention: sessionRetention.minRetention,
      });
      if (result.deleted > 0) {
        console.log(`Cleaned up ${result.deleted} expired session(s)`);
      }
    } catch (error) {
      // Log but don't fail on cleanup errors
      console.warn(
        'Session cleanup warning:',
        error instanceof Error ? error.message : error
      );
    }
  }

  // Handle --resume argument
  let resumedSessionData: ResumedSessionData | undefined;
  if (argv.resume) {
    const selector = new SessionSelector(config);
    // If --resume is used without a value, yargs returns true; treat as "latest"
    const resumeArg = typeof argv.resume === 'string' ? argv.resume : RESUME_LATEST;
    const result = await selector.resolveSession(resumeArg);

    if (!result.found) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    resumedSessionData = result.sessionData;
    console.log(
      `Resuming session: ${result.displayInfo?.firstUserMessage ?? result.sessionPath}`
    );
  }

  // Render UI, passing necessary config values. Check that there is no command line question.
  if (config.isInteractive()) {
    await startInteractiveUI(
      config,
      settings,
      startupWarnings,
      workspaceRoot,
      resumedSessionData
    );
    return;
  }
  // If not a TTY, read from stdin
  // This is for cases where the user pipes input directly into the command
  if (!process.stdin.isTTY) {
    const stdinData = await readStdin();
    if (stdinData) {
      input = `${stdinData}\n\n${input}`;
    }
  }
  if (!input) {
    console.error(
      `No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.`,
    );
    process.exit(1);
  }

  const prompt_id = Math.random().toString(16).slice(2);
  logUserPrompt(config, {
    'event.name': 'user_prompt',
    'event.timestamp': new Date().toISOString(),
    prompt: input,
    prompt_id,
    auth_type: config.getContentGeneratorConfig()?.authType,
    prompt_length: input.length,
    modelName: config.getCustomData<string>("modelName")
  });  // 数据埋点 用户提示输入

  const nonInteractiveConfig = await validateNonInteractiveAuth(
    settings.merged.security?.auth?.selectedType,
    settings.merged.security?.auth?.useExternal,
    config,
  );

  if (config.getDebugMode()) {
    console.log('Session ID: %s', sessionId);
  }

  // 获取输出格式参数，默认为 'text'
  // 验证并转换输出格式，确保类型安全
  const outputFormatValue = argv.outputFormat;
  const validFormats: Array<'text' | 'json' | 'stream-json'> = ['text', 'json', 'stream-json'];
  const outputFormat: 'text' | 'json' | 'stream-json' = 
    (outputFormatValue && validFormats.includes(outputFormatValue as any))
      ? (outputFormatValue as 'text' | 'json' | 'stream-json')
      : 'text';

  // 运行非交互模式，传入输出格式参数
  await runNonInteractive(nonInteractiveConfig, input, prompt_id, outputFormat);
  process.exit(0);
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui?.hideWindowTitle) {
    const windowTitle = (
      process.env['CLI_TITLE'] || `Bluecode - ${title}`
    ).replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1F\x7F]/g,
      '',
    );
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}

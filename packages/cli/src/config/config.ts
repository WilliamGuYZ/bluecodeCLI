/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import process from 'node:process';
import { mcpCommand } from '../commands/mcp.js';
import {
  TelemetryTarget,
  FileFilteringOptions,
  MCPServerConfig,
} from '@vivo/bluecode-cli-core';
import { extensionsCommand } from '../commands/extensions.js';
import {
  Config,
  loadServerHierarchicalMemory,
  setGeminiMdFilename as setServerGeminiMdFilename,
  getCurrentGeminiMdFilename,
  ApprovalMode,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
  FileDiscoveryService,
  ShellTool,
  EditTool,
  WriteFileTool,
} from '@vivo/bluecode-cli-core';
import { Settings } from './settings.js';

import { Extension } from './extension.js';
import { annotateActiveExtensions } from './extension.js';
import { getCliVersion } from '../utils/version.js';
import { loadSandboxConfig } from './sandboxConfig.js';
import { resolvePath } from '../utils/resolvePath.js';
import { getHost } from './hosts.js';

import { isWorkspaceTrusted } from './trustedFolders.js';

// Simple console logger for now - replace with actual logger if available
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) => console.error('[ERROR]', ...args),
};

export interface CliArgs {
  model: string | undefined;
  sandbox: boolean | string | undefined;
  sandboxImage: string | undefined;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  allFiles: boolean | undefined;
  showMemoryUsage: boolean | undefined;
  yolo: boolean | undefined;
  approvalMode: string | undefined;
  telemetry: boolean | undefined;
  checkpointing: boolean | undefined;
  telemetryTarget: string | undefined;
  telemetryOtlpEndpoint: string | undefined;
  telemetryOtlpProtocol: string | undefined;
  telemetryLogPrompts: boolean | undefined;
  telemetryOutfile: string | undefined;
  allowedMcpServerNames: string[] | undefined;
  allowedTools: string[] | undefined;
  experimentalAcp: boolean | undefined;
  extensions: string[] | undefined;
  listExtensions: boolean | undefined;
  proxy: string | undefined;
  includeDirectories: string[] | undefined;
  screenReader: boolean | undefined;
  outputFormat: string | undefined;
  version: string | undefined;
  listSessions: boolean | undefined;
  resume: string | boolean | undefined;
}

export async function parseArguments(settings: Settings): Promise<CliArgs> {
  const yargsInstance = yargs(hideBin(process.argv))
    .locale('en')
    .scriptName('bluecode')
    .usage(
      'Usage: bluecode [options] [command]\n\nBlueCode CLI - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
    )
    .command('$0', 'Launch BlueCode CLI', (yargsInstance) =>
      yargsInstance
        .option('model', {
          alias: 'm',
          type: 'string',
          description: `Model`,
          default: process.env.DEFAULT_MODEL || DEFAULT_GEMINI_MODEL, // 环境定义 || model.ts 
        })
        .option('prompt', {
          alias: 'p',
          type: 'string',
          description: 'Prompt. Appended to input on stdin (if any).',
        })
        .option('prompt-interactive', {
          alias: 'i',
          type: 'string',
          description:
            'Execute the provided prompt and continue in interactive mode',
        })
        .option('sandbox', {
          alias: 's',
          type: 'boolean',
          description: 'Run in sandbox?',
        })
        .option('sandbox-image', {
          type: 'string',
          description: 'Sandbox image URI.',
        })
        .option('debug', {
          alias: 'd',
          type: 'boolean',
          description: 'Run in debug mode?',
          default: false,
        })
        .option('all-files', {
          alias: ['a'],
          type: 'boolean',
          description: 'Include ALL files in context?',
          default: false,
        })
        .option('show-memory-usage', {
          type: 'boolean',
          description: 'Show memory usage in status bar',
          default: false,
        })
        .option('yolo', {
          alias: 'y',
          type: 'boolean',
          description:
            'Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?',
          default: false,
        })
        .option('approval-mode', {
          type: 'string',
          choices: ['default', 'auto_edit', 'yolo'],
          description:
            'Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools)',
        })
        .option('telemetry', {
          type: 'boolean',
          description:
            'Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.',
        })
        .option('telemetry-target', {
          type: 'string',
          choices: ['local', 'gcp'],
          description:
            'Set the telemetry target (local or gcp). Overrides settings files.',
        })
        .option('telemetry-otlp-endpoint', {
          type: 'string',
          description:
            'Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.',
        })
        .option('telemetry-otlp-protocol', {
          type: 'string',
          choices: ['grpc', 'http'],
          description:
            'Set the OTLP protocol for telemetry (grpc or http). Overrides settings files.',
        })
        .option('telemetry-log-prompts', {
          type: 'boolean',
          description:
            'Enable or disable logging of user prompts for telemetry. Overrides settings files.',
        })
        .option('telemetry-outfile', {
          type: 'string',
          description: 'Redirect all telemetry output to the specified file.',
        })
        .option('checkpointing', {
          alias: 'c',
          type: 'boolean',
          description: 'Enables checkpointing of file edits',
          default: false,
        })
        .option('experimental-acp', {
          type: 'boolean',
          description: 'Starts the agent in ACP mode',
        })
        .option('allowed-mcp-server-names', {
          type: 'array',
          string: true,
          description: 'Allowed MCP server names',
        })
        .option('allowed-tools', {
          type: 'array',
          string: true,
          description: 'Tools that are allowed to run without confirmation',
        })
        .option('extensions', {
          alias: 'e',
          type: 'array',
          string: true,
          description:
            'A list of extensions to use. If not provided, all extensions are used.',
        })
        .option('list-extensions', {
          alias: 'l',
          type: 'boolean',
          description: 'List all available extensions and exit.',
        })
        .option('proxy', {
          type: 'string',
          description:
            'Proxy for gemini client, like schema://user:password@host:port',
        })
        .option('include-directories', {
          type: 'array',
          string: true,
          description:
            'Additional directories to include in the workspace (comma-separated or multiple --include-directories)',
          coerce: (dirs: string[]) =>
            // Handle comma-separated values
            dirs.flatMap((dir) => dir.split(',').map((d) => d.trim())),
        })
        .option('screen-reader', {
          type: 'boolean',
          description: 'Enable screen reader mode for accessibility.',
          default: false,
        })
        .option('output-format', {
          type: 'string',
          choices: ['text', 'json', 'stream-json'],
          description:
            'Output format for non-interactive mode. Options: text (default), json (structured JSON), stream-json (newline-delimited JSON events)',
          default: 'text',
          // 中文说明：非交互模式下的输出格式
          // text: 普通文本格式（默认）
          // json: 结构化 JSON 格式，包含完整响应和统计信息
          // stream-json: 实时事件流 JSON 格式（换行分隔），适用于管道和监控
        })
        .option('list-sessions', {
          type: 'boolean',
          description: 'List all saved sessions and exit.',
        })
        .option('resume', {
          alias: 'r',
          type: 'string',
          description:
            'Resume a previous session. Use "latest" for the most recent session, or provide a session number/path.',
        })

        .check((argv) => {
          if (argv.prompt && argv['promptInteractive']) {
            throw new Error(
              'Cannot use both --prompt (-p) and --prompt-interactive (-i) together',
            );
          }
          if (argv.yolo && argv['approvalMode']) {
            throw new Error(
              'Cannot use both --yolo (-y) and --approval-mode together. Use --approval-mode=yolo instead.',
            );
          }
          return true;
        }),
    )
    // Register MCP subcommands
    .command(mcpCommand);

  if (settings?.experimental?.extensionManagement ?? false) {
    yargsInstance.command(extensionsCommand);
  }

  const cliVersion = await getCliVersion()
  
  /**
   * 参数解析逻辑：正确处理 --prompt/-p 和 --output-format 参数
   * 
   * 参考官方文档：https://aicode.vivo.xyz/docs/CLIAgent/%E5%91%BD%E4%BB%A4%E6%A8%A1%E5%BC%8F/
   * 
   * 处理策略：
   * 1. 无论参数顺序如何，只要看到 -p/--prompt，就提取后面的值作为 prompt
   * 2. 只要看到 --output-format，就提取后面的值作为输出格式
   * 3. 如果 npm 吞掉了这些参数（只留下位置参数），从位置参数中智能重建
   * 
   * 支持的场景：
   * - npm start -- --prompt "text" --output-format json  (推荐方式，使用 -- 分隔符)
   * - npm start --prompt "text" --output-format json      (npm 吞掉参数，需要重建)
   * - npm start --output-format json -p "text"           (参数顺序不同，也能正确提取)
   * - npm start "text" json                              (位置参数，智能识别)
   */
  const rawArgv = hideBin(process.argv);
  const processedArgv: string[] = [];
  const positionalArgs: string[] = [];
  const validOutputFormats = ['text', 'json', 'stream-json'];
  let extractedPrompt: string | undefined = undefined;
  let extractedOutputFormat: string | undefined = undefined;
  
  // 第一遍：遍历所有参数，提取 --prompt/-p 和 --output-format 的值
  // 无论参数顺序如何，都能正确提取
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    
    if (arg === '--prompt' || arg === '-p') {
      // 找到 prompt 标志，提取后面的值
      processedArgv.push(arg);
      if (i + 1 < rawArgv.length && !rawArgv[i + 1].startsWith('-')) {
        extractedPrompt = rawArgv[i + 1];
        processedArgv.push(extractedPrompt);
        i++; // 跳过值
      }
    } else if (arg === '--output-format' || arg.startsWith('--output-format=')) {
      // 找到 output-format 标志，提取后面的值
      if (arg.includes('=')) {
        // --output-format=json 格式
        extractedOutputFormat = arg.split('=')[1];
        processedArgv.push(arg);
      } else {
        // --output-format json 格式
        processedArgv.push(arg);
        if (i + 1 < rawArgv.length && !rawArgv[i + 1].startsWith('-')) {
          extractedOutputFormat = rawArgv[i + 1];
          processedArgv.push(extractedOutputFormat);
          i++; // 跳过值
        }
      }
    } else if (arg.startsWith('-')) {
      // 其他所有标志直接传递
      processedArgv.push(arg);
    } else {
      // 位置参数：可能是被 npm 吞掉的 prompt 或 output-format 值
      if (arg === 'mcp' || arg === 'extensions') {
        // 子命令，直接传递
        processedArgv.push(arg);
      } else {
        // 其他位置参数，收集起来稍后处理
        positionalArgs.push(arg);
      }
    }
  }
  
  // 第二遍：如果 npm 吞掉了参数，从位置参数中重建
  // 这种情况发生在：有位置参数，但 prompt 或 output-format 没有被正确提取
  if (positionalArgs.length > 0) {
    // 检查位置参数中是否有有效的 output-format 值
    let outputFormatIndex = -1;
    for (let i = 0; i < positionalArgs.length; i++) {
      if (validOutputFormats.includes(positionalArgs[i])) {
        outputFormatIndex = i;
        break;
      }
    }
    
    // 如果找到了 output-format 值且之前没有提取到，重建它
    if (!extractedOutputFormat && outputFormatIndex >= 0) {
      extractedOutputFormat = positionalArgs[outputFormatIndex];
      processedArgv.push('--output-format', extractedOutputFormat);
      // 从位置参数中移除
      positionalArgs.splice(outputFormatIndex, 1);
    }
    
    // 如果还有位置参数且之前没有提取到 prompt，剩余的位置参数就是 prompt
    if (!extractedPrompt && positionalArgs.length > 0) {
      extractedPrompt = positionalArgs.join(' ');
      processedArgv.push('--prompt', extractedPrompt);
    } else if (positionalArgs.length > 0) {
      // 如果已经提取了 prompt，但还有多余的位置参数，添加回去（不常见的情况）
      processedArgv.push(...positionalArgs);
    }
  }
  
  yargsInstance
    .version(cliVersion)
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .demandCommand(0, 0);

  yargsInstance.wrap(yargsInstance.terminalWidth());
  const result = await yargsInstance.parse(processedArgv);

  // Handle case where MCP subcommands are executed - they should exit the process
  // and not return to main CLI logic
  if (
    result._.length > 0 &&
    (result._[0] === 'mcp' || result._[0] === 'extensions')
  ) {
    // MCP commands handle their own execution and process exit
    process.exit(0);
  }

  // The import format is now only controlled by settings.memoryImportFormat
  // We no longer accept it as a CLI argument
  return { ...result, version: cliVersion} as unknown as CliArgs;
}

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalGeminiMemory(
  currentWorkingDirectory: string,
  includeDirectoriesToReadGemini: readonly string[] = [],
  debugMode: boolean,
  fileService: FileDiscoveryService,
  settings: Settings,
  extensionContextFilePaths: string[] = [],
  memoryImportFormat: 'flat' | 'tree' = 'tree',
  fileFilteringOptions?: FileFilteringOptions,
): Promise<{ memoryContent: string; fileCount: number }> {
  // FIX: Use real, canonical paths for a reliable comparison to handle symlinks.
  const realCwd = fs.realpathSync(path.resolve(currentWorkingDirectory));
  const realHome = fs.realpathSync(path.resolve(homedir()));
  const isHomeDirectory = realCwd === realHome;

  // If it is the home directory, pass an empty string to the core memory
  // function to signal that it should skip the workspace search.
  const effectiveCwd = isHomeDirectory ? '' : currentWorkingDirectory;

  if (debugMode) {
    logger.debug(
      `CLI: Delegating hierarchical memory load to server for CWD: ${currentWorkingDirectory} (memoryImportFormat: ${memoryImportFormat})`,
    );
  }

  // Directly call the server function with the corrected path.
  return loadServerHierarchicalMemory(
    effectiveCwd,
    includeDirectoriesToReadGemini,
    debugMode,
    fileService,
    extensionContextFilePaths,
    memoryImportFormat,
    fileFilteringOptions,
    settings.context?.discoveryMaxDirs,
  );
}

export async function loadCliConfig(
  settings: Settings,
  extensions: Extension[],
  sessionId: string,
  argv: CliArgs,
  cwd: string = process.cwd(),
): Promise<Config> {
  // Get dynamically resolved hosts (API and NPM registry)
  const hosts = await getHost();

  const debugMode =
    argv.debug ||
    [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    ) ||
    false;
  const memoryImportFormat = settings.context?.importFormat || 'tree';

  const ideMode = settings.ide?.enabled ?? false;

  const folderTrustFeature =
    settings.security?.folderTrust?.featureEnabled ?? false;
  const folderTrustSetting = settings.security?.folderTrust?.enabled ?? true;
  const folderTrust = folderTrustFeature && folderTrustSetting;
  const trustedFolder = isWorkspaceTrusted(settings);

  const allExtensions = annotateActiveExtensions(
    extensions,
    argv.extensions || [],
    cwd,
  );

  const activeExtensions = extensions.filter(
    (_, i) => allExtensions[i].isActive,
  );

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setGeminiMdFilename.
  // However, loadHierarchicalGeminiMemory is called *before* createServerConfig.
  // settings.json没有contextFileName字段时，README将作为默认读取的文件
  if (settings.context?.fileName) {
    setServerGeminiMdFilename(settings.context.fileName);
  } else {
    // Reset to default if not provided in settings.
    setServerGeminiMdFilename(getCurrentGeminiMdFilename());
  }

  const extensionContextFilePaths = activeExtensions.flatMap(
    (e) => e.contextFiles,
  );

  const fileService = new FileDiscoveryService(cwd);

  const fileFiltering = {
    ...DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
    ...settings.context?.fileFiltering,
  };

  const includeDirectories = (settings.context?.includeDirectories || [])
    .map(resolvePath)
    .concat((argv.includeDirectories || []).map(resolvePath));

  // Call the (now wrapper) loadHierarchicalGeminiMemory which calls the server's version
  // 获取上下文文件，同时还加入到提示词里面
  const { memoryContent, fileCount } = await loadHierarchicalGeminiMemory(
    cwd,
    settings.context?.loadMemoryFromIncludeDirectories
      ? includeDirectories
      : [],
    debugMode,
    fileService,
    settings,
    extensionContextFilePaths,
    memoryImportFormat,
    fileFiltering,
  );

  let mcpServers = mergeMcpServers(settings, activeExtensions);
  const question = argv.promptInteractive || argv.prompt || '';

  // Determine approval mode with backward compatibility
  let approvalMode: ApprovalMode;
  if (argv.approvalMode) {
    // New --approval-mode flag takes precedence
    switch (argv.approvalMode) {
      case 'yolo':
        approvalMode = ApprovalMode.YOLO;
        break;
      case 'auto_edit':
        approvalMode = ApprovalMode.AUTO_EDIT;
        break;
      case 'default':
        approvalMode = ApprovalMode.DEFAULT;
        break;
      default:
        throw new Error(
          `Invalid approval mode: ${argv.approvalMode}. Valid values are: yolo, auto_edit, default`,
        );
    }
  } else {
    // Fallback to legacy --yolo flag behavior
    approvalMode =
      argv.yolo || false ? ApprovalMode.YOLO : ApprovalMode.DEFAULT;
  }

  // Force approval mode to default if the folder is not trusted.
  if (!trustedFolder && approvalMode !== ApprovalMode.DEFAULT) {
    logger.warn(
      `Approval mode overridden to "default" because the current folder is not trusted.`,
    );
    approvalMode = ApprovalMode.DEFAULT;
  }

  const interactive =
    !!argv.promptInteractive || (process.stdin.isTTY && question.length === 0);
  // In non-interactive mode, exclude tools that require a prompt.
  const extraExcludes: string[] = [];
  if (!interactive && !argv.experimentalAcp) {
    switch (approvalMode) {
      case ApprovalMode.DEFAULT:
        // In default non-interactive mode, all tools that require approval are excluded.
        extraExcludes.push(ShellTool.Name, EditTool.Name, WriteFileTool.Name);
        break;
      case ApprovalMode.AUTO_EDIT:
        // In auto-edit non-interactive mode, only tools that still require a prompt are excluded.
        extraExcludes.push(ShellTool.Name);
        break;
      case ApprovalMode.YOLO:
        // No extra excludes for YOLO mode.
        break;
      default:
        // This should never happen due to validation earlier, but satisfies the linter
        break;
    }
  }

  const excludeTools = mergeExcludeTools(
    settings,
    activeExtensions,
    extraExcludes.length > 0 ? extraExcludes : undefined,
  );
  const blockedMcpServers: Array<{ name: string; extensionName: string }> = [];

  if (!argv.allowedMcpServerNames) {
    if (settings.mcp?.allowed) {
      mcpServers = allowedMcpServers(
        mcpServers,
        settings.mcp.allowed,
        blockedMcpServers,
      );
    }

    if (settings.mcp?.excluded) {
      const excludedNames = new Set(settings.mcp.excluded.filter(Boolean));
      if (excludedNames.size > 0) {
        mcpServers = Object.fromEntries(
          Object.entries(mcpServers).filter(([key]) => !excludedNames.has(key)),
        );
      }
    }
  }

  if (argv.allowedMcpServerNames) {
    mcpServers = allowedMcpServers(
      mcpServers,
      argv.allowedMcpServerNames,
      blockedMcpServers,
    );
  }

  const sandboxConfig = await loadSandboxConfig(settings, argv);

  // The screen reader argument takes precedence over the accessibility setting.
  const screenReader =
    argv.screenReader ?? settings.ui?.accessibility?.screenReader ?? false;
  // 设置自定义字段
  const customData = {
    version: argv.version
  }
  return new Config({
    sessionId,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: cwd,
    includeDirectories,
    loadMemoryFromIncludeDirectories:
      settings.context?.loadMemoryFromIncludeDirectories || false,
    debugMode,
    question,
    fullContext: argv.allFiles || false,
    coreTools: settings.tools?.core || undefined,
    allowedTools: argv.allowedTools || settings.tools?.allowed || undefined,
    excludeTools,
    toolDiscoveryCommand: settings.tools?.discoveryCommand,
    toolCallCommand: settings.tools?.callCommand,
    mcpServerCommand: settings.mcp?.serverCommand,
    mcpServers,
    userMemory: memoryContent,
    geminiMdFileCount: fileCount,
    approvalMode,
    showMemoryUsage:
      argv.showMemoryUsage || settings.ui?.showMemoryUsage || false,
    accessibility: {
      ...settings.ui?.accessibility,
      screenReader,
    },
    telemetry: {
      enabled: argv.telemetry ?? settings.telemetry?.enabled,
      target: (argv.telemetryTarget ??
        settings.telemetry?.target) as TelemetryTarget,
      otlpEndpoint:
        argv.telemetryOtlpEndpoint ??
        process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
        settings.telemetry?.otlpEndpoint,
      otlpProtocol: (['grpc', 'http'] as const).find(
        (p) =>
          p ===
          (argv.telemetryOtlpProtocol ?? settings.telemetry?.otlpProtocol),
      ),
      logPrompts: argv.telemetryLogPrompts ?? settings.telemetry?.logPrompts,
      outfile: argv.telemetryOutfile ?? settings.telemetry?.outfile,
    },
    // Git-aware file filtering settings
    fileFiltering: {
      respectGitIgnore: settings.context?.fileFiltering?.respectGitIgnore,
      respectGeminiIgnore: settings.context?.fileFiltering?.respectGeminiIgnore,
      enableRecursiveFileSearch:
        settings.context?.fileFiltering?.enableRecursiveFileSearch,
      disableFuzzySearch: settings.context?.fileFiltering?.disableFuzzySearch,
    },
    checkpointing:
      argv.checkpointing || settings.general?.checkpointing?.enabled,
    proxy:
      argv.proxy ||
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'],
    cwd,
    fileDiscoveryService: fileService,
    bugCommand: settings.advanced?.bugCommand,
    model: argv.model || settings.model?.name || DEFAULT_GEMINI_MODEL,
    extensionContextFilePaths,
    maxSessionTurns: settings.model?.maxSessionTurns ?? -1,
    experimentalZedIntegration: argv.experimentalAcp || false,
    listExtensions: argv.listExtensions || false,
    extensions: allExtensions,
    blockedMcpServers,
    noBrowser: !!process.env['NO_BROWSER'],
    summarizeToolOutput: settings.model?.summarizeToolOutput,
    ideMode,
    chatCompression: settings.model?.chatCompression,
    folderTrustFeature,
    folderTrust,
    interactive,
    trustedFolder,
    useRipgrep: settings.tools?.useRipgrep,
    shouldUseNodePtyShell: settings.tools?.usePty,
    skipNextSpeakerCheck: settings.model?.skipNextSpeakerCheck,
    enablePromptCompletion: settings.general?.enablePromptCompletion ?? false,
    apiHost: hosts.host,
    npmHost: hosts.npmHost,
    customData
  });
}

function allowedMcpServers(
  mcpServers: { [x: string]: MCPServerConfig },
  allowMCPServers: string[],
  blockedMcpServers: Array<{ name: string; extensionName: string }>,
) {
  const allowedNames = new Set(allowMCPServers.filter(Boolean));
  if (allowedNames.size > 0) {
    mcpServers = Object.fromEntries(
      Object.entries(mcpServers).filter(([key, server]) => {
        const isAllowed = allowedNames.has(key);
        if (!isAllowed) {
          blockedMcpServers.push({
            name: key,
            extensionName: server.extensionName || '',
          });
        }
        return isAllowed;
      }),
    );
  } else {
    blockedMcpServers.push(
      ...Object.entries(mcpServers).map(([key, server]) => ({
        name: key,
        extensionName: server.extensionName || '',
      })),
    );
    mcpServers = {};
  }
  return mcpServers;
}

function mergeMcpServers(settings: Settings, extensions: Extension[]) {
  const mcpServers = { ...(settings.mcpServers || {}) };
  for (const extension of extensions) {
    Object.entries(extension.config.mcpServers || {}).forEach(
      ([key, server]) => {
        if (mcpServers[key]) {
          logger.warn(
            `Skipping extension MCP config for server with key "${key}" as it already exists.`,
          );
          return;
        }
        mcpServers[key] = {
          ...server,
          extensionName: extension.config.name,
        };
      },
    );
  }
  return mcpServers;
}

function mergeExcludeTools(
  settings: Settings,
  extensions: Extension[],
  extraExcludes?: string[] | undefined,
): string[] {
  const allExcludeTools = new Set([
    ...(settings.tools?.exclude || []),
    ...(extraExcludes || []),
  ]);
  for (const extension of extensions) {
    for (const tool of extension.config.excludeTools || []) {
      allExcludeTools.add(tool);
    }
  }
  return [...allExcludeTools];
}
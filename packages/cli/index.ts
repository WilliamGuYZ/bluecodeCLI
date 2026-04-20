#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import v8 from 'node:v8';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FatalError } from '@vivo/bluecode-cli-core';

// ===== 内存自动重启机制 =====
// 目标：确保 Node.js 进程以 8GB 最大堆内存运行，支持大规模代码处理任务

// 目标内存配置：8GB
const TARGET_GB = 8;
const TARGET_MB = TARGET_GB * 1024;

// 获取当前进程的堆内存限制（从字节转换为 MB）
const currentHeapLimit = v8.getHeapStatistics().heap_size_limit / 1024 / 1024;

// 安全余量：512MB，避免因内存计算误差导致不必要的重启
const SAFETY_MARGIN_MB = 512;

/**
 * 检查是否需要重启进程以获得更大的内存限制
 *
 * 重启条件：
 * 1. 当前内存限制 < (目标内存 - 安全余量)
 * 2. 进程尚未重启过（通过环境变量 _NODE_RESTARTED 判断）
 */
const needsRestart = currentHeapLimit < (TARGET_MB - SAFETY_MARGIN_MB) && !process.env._NODE_RESTARTED;

if (needsRestart) {
  // ===== 内存不足，启动新的进程 =====

  // 构建新进程的命令行参数
  // 1. --max-old-space-size=${TARGET_MB}：设置 8GB 最大堆内存
  // 2. fileURLToPath(import.meta.url)：当前文件的路径
  // 3. ...process.argv.slice(2)：传递所有用户输入的命令行参数
  const nodeArgs = [
    `--max-old-space-size=${TARGET_MB}`,
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ];

  // 设置重启标记环境变量，防止无限重启循环
  const restartEnv = {
    ...process.env,
    _NODE_RESTARTED: 'true'  // 标记：进程已经重启过
  };

  // 创建新的子进程
  const child = spawn(
    process.execPath,  // 当前 Node.js 可执行文件路径
    nodeArgs,          // 命令行参数
    {
      stdio: 'inherit',  // 继承父进程的标准输入/输出/错误流，用户交互不受影响
      env: restartEnv,   // 传递环境变量，包括重启标记
    }
  );

  // ===== 子进程事件处理 =====

  // 子进程退出时的处理
  child.on('exit', (code) => {
    // 将子进程的退出码传递给父进程
    // code || 0 确保即使 code 为 null/undefined，也返回 0
    process.exit(code || 0);
  });

  // 子进程启动失败时的错误处理
  child.on('error', (err) => {
    console.error('[BlueCode CLI] Failed to restart with increased memory:', err.message);
    console.error('[BlueCode CLI] Please ensure Node.js is properly installed and try again.');
    process.exit(1);
  });

  // 父进程在此等待子进程完成，不会执行后续代码
} else {
  // 延迟加载策略：
  // 只在确认内存配置正确后才加载主应用模块
  // 这样可以避免在内存不足的父进程中执行昂贵的模块导入操作
  runApp();
}

async function runApp() {
  const { main } = await import('./src/gemini.js');
  
  main().catch((error) => {
    if (error instanceof FatalError) {
      let errorMessage = error.message;
      if (!process.env['NO_COLOR']) {
        errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
      }
      console.error(errorMessage);
      process.exit(error.exitCode);
    }
    console.error('An unexpected critical error occurred:');
    if (error instanceof Error) {
      console.error(error.stack);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  });
}
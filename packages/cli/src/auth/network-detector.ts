/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 网络环境检测模块
 * 用于判断当前是内网还是外网环境
 */


// 内网/外网域名配置
const INNER_BASE_URL = 'https://cobot.vmic.xyz';
const OPEN_BASE_URL = 'https://openbc.vivo.com.cn';

// UUC系统配置
const UUC_LOGIN_URL = 'https://uuc.vivo.xyz/uuc/internal/login';

interface NetworkEnvironment {
  isInternal: boolean;
  isRemote: boolean;
  availableApiBase: string;
  loginMethod: 'browser' | 'cli';
}

/**
 * 检测网络环境 - 简化逻辑，基于环境变量判断
 */
export async function detectNetworkEnvironment(): Promise<NetworkEnvironment> {
  // 1. 检查外网环境标记
  const isForeign = process.env.COM === 'foreign';
  
  // 2. 检查远程环境（包括NODE_ENV=remote）
  const isRemote = isRemoteEnvironment();
  
  // 3. 综合判断：外网或远程环境使用CLI登录
  if (isForeign || isRemote) {
    return {
      isInternal: false,
      isRemote: true,
      availableApiBase: OPEN_BASE_URL,
      loginMethod: 'cli' // 外网/远程环境使用CLI输入登录
    };
  }
  
  // 4. 否则视为内网环境，使用浏览器登录
  return {
    isInternal: true,
    isRemote: false,
    availableApiBase: INNER_BASE_URL,
    loginMethod: 'browser' // 内网环境使用浏览器登录
  };
}

/**
 * 检查远程环境（不包括外网环境标记）
 */
function isRemoteEnvironment(): boolean {
  // 1. 检查通用远程环境标记
  if (process.env.NODE_ENV === 'remote') {
    return true;
  }
  
  // 2. 检查VS Code远程环境
  if (process.env.VSCODE_REMOTE) {
    return true;
  }
  
  // 3. 检查SSH环境
  if (process.env.SSH_CLIENT || process.env.SSH_TTY) {
    return true;
  }
  
  // 4. 检查容器环境
  if (process.env.CONTAINER || process.env.KUBERNETES_SERVICE_HOST) {
    return true;
  }
  
  // 5. 检查TTY状态（只有当明确知道不是TTY时才认为是远程）
  if (process.stdin.isTTY === false) {
    return true;
  }
  
  return false;
}


/**
 * 获取当前API基础地址
 */
export async function getCurrentApiBase(): Promise<string> {
  const env = await detectNetworkEnvironment();
  return env.availableApiBase;
}

/**
 * 获取推荐的登录方式
 */
export async function getRecommendedLoginMethod(): Promise<'browser' | 'cli'> {
  const env = await detectNetworkEnvironment();
  return env.loginMethod;
}
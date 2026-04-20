/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Login authentication module for bluecode-cli
 * Based on the ai-code-vscode-plugin login system
 */

import { queryUserInfo, queryUserInfoByUuc } from './api.js';
import { getUserIdFromLocal, getParameterByName, setUserIdFromLocal } from './storage.js';
import { detectNetworkEnvironment } from './network-detector.js';
import { performCliLogin } from './cli-login.js';


/**
 * Update user information after successful authentication
 * Now only saves user ID to .aicodeUserInfo file
 */
export async function updateUserInfo(userId: string): Promise<void> {
  try {
    await setUserIdFromLocal(userId);
  } catch (error) {
    console.error('Error saving user ID:', error);
    throw error;
  }
}

/**
 * Get user info by token
 */
async function getUserInfoByToken(token: string): Promise<void> {
  try {
    const res = await queryUserInfo({ token, pluginVersion: '1.0.0' });
    
    if ((String(res.code) === '200') && res.data.userId) {
      await updateUserInfo(res.data.userId);
    } else {
      throw new Error(res.message || 'Failed to get user info');
    }
  } catch (error) {
    console.error('Error getting user info by token:', error);
    throw error;
  }
}

/**
 * Get user info by crossKey (UUC)
 */
async function getUserInfoByCrossKey(crossKey: string): Promise<void> {
  try {
    const res = await queryUserInfoByUuc({ crossKey, pluginVersion: '1.0.0' });
    
    if ((String(res.code) === '200') && res.data.userId) {
      await updateUserInfo(res.data.userId);
    } else {
      throw new Error(res.message || 'Failed to get user info by crossKey');
    }
  } catch (error) {
    console.error('Error getting user info by crossKey:', error);
    throw error;
  }
}

/**
 * Send user ID to IDE/CLI context
 */
function sendUserId(): void {
  const userId = getUserIdFromLocal();
  if (!userId) return;
  
//   console.log(`[AUTH] User ID: ${userId}`);
  // In CLI context, we can emit events or set environment variables
  process.env.BLUE_CODE_USER_ID = userId;
}

/**
 * Notify CLI that login was successful
 */
function noticePlugin(): void {
  const userId = getUserIdFromLocal();
  if (!userId) return;
  
  const token = getParameterByName('token');
  const crossKey = getParameterByName('crossKey');
  
  if (token || crossKey) {
    console.log('[AUTH] Login successful, user authenticated');
    // Set environment variable to indicate successful login
    process.env.BLUE_CODE_LOGIN_SUCCESS = userId;
  }
}

/**
 * Initialize user authentication
 * This is the main entry point for authentication flow
 * Now only uses .aicodeUserInfo file for user identification
 */
export async function initUser(): Promise<string | null> {
  // 检查.aicodeUserInfo文件
  let userId = getUserIdFromLocal();
  
  if (userId) {
    // console.log(`[AUTH] Welcome back, ${userId}`);
    sendUserId();
    noticePlugin();
    return userId;
  }
  
  // Check for token or crossKey from command line or environment
  const token = getParameterByName('token');
  const crossKey = getParameterByName('crossKey');
  const cliToken = getParameterByName('cli-token');
  
  if (token) {
    console.log('[AUTH] Found token, attempting authentication...');
    try {
      await getUserInfoByToken(token);
      userId = getUserIdFromLocal();
      if (userId) {
        sendUserId();
        noticePlugin();
        return userId;
      }
    } catch (error) {
      console.error('[AUTH] Token authentication failed:', error);
    }
  }
  
  if (crossKey) {
    console.log('[AUTH] Found crossKey, attempting UUC authentication...');
    try {
      await getUserInfoByCrossKey(crossKey);
      userId = getUserIdFromLocal();
      if (userId) {
        sendUserId();
        noticePlugin();
        return userId;
      }
    } catch (error) {
      console.error('[AUTH] CrossKey authentication failed:', error);
    }
  }
  
  // CLI快速Token登录
  if (cliToken) {
    console.log('[AUTH] Found CLI token, attempting quick authentication...');
    try {
      const { quickTokenLogin } = await import('./cli-login.js');
      const result = await quickTokenLogin(cliToken);
      if (result.success) {
        userId = getUserIdFromLocal();
        if (userId) {
          await updateUserInfo(userId);
          sendUserId();
          noticePlugin();
          return userId;
        }
      } else {
        console.error('[AUTH] CLI token authentication failed:', result.error);
      }
    } catch (error) {
      console.error('[AUTH] CLI token authentication failed:', error);
    }
  }
  
  // 根据网络环境选择合适的登录方式
  if (process.stdin.isTTY) {
    try {
      // 检测网络环境
      const networkEnv = await detectNetworkEnvironment();
      
      if (networkEnv.loginMethod === 'cli') {
        // 远程/外网环境：使用CLI终端登录
        console.log('[AUTH] 检测到远程/机房环境，使用CLI终端登录...');
        const cliResult = await performCliLogin();
        if (cliResult.success) {
          userId = getUserIdFromLocal();
          if (userId) {
            await updateUserInfo(userId);
            sendUserId();
            noticePlugin();
            return userId;
          }
        }
      } else {
        // 内网环境：使用浏览器登录
        const { openBrowserLogin } = await import('./browser-login.js');
        const loginResult = await openBrowserLogin();
        
        if (loginResult.success) {
          // 重新尝试认证
          userId = getUserIdFromLocal();
          if (userId) {
            await updateUserInfo(userId);
            sendUserId();
            noticePlugin();
            return userId;
          }
        }
      }
    } catch (error) {
      console.error('[AUTH] 登录过程中发生错误:', error);
    }
  } else {
    // 非交互式环境，尝试使用环境变量
    console.log('[AUTH] 非交互式环境，请检查环境变量...');
  }
  
  return null;
}

/**
 * Handle user login - prompt for authentication if needed
 */
export async function handleUserLogin(): Promise<string> {
  console.log(' ');
  console.log('[AUTH] Handling user login...');
  
  const userId = await initUser();
  if (userId) {
    return userId;
  }
  
  // In CLI context, we need to guide user to authenticate
  console.error('\n[AUTH] ═══════════════════════════════════════');
  console.error('[AUTH] 需要登录验证');
  console.error('[AUTH] ═══════════════════════════════════════');
  console.error('[AUTH] 请选择登录方式：');
  console.error('[AUTH] 1. CLI终端登录（工号+密码/Token）');
  console.error('[AUTH] 2. 设置环境变量：BLUE_CODE_TOKEN=YOUR_TOKEN');
  console.error('[AUTH] 3. 使用参数：bluecode --token=YOUR_TOKEN');
  console.error('[AUTH] 4. 使用参数：bluecode --crossKey=YOUR_CROSS_KEY');
  console.error('[AUTH] 5. 浏览器登录：访问 https://bpm-sso.vivo.xyz/LoginPage.aspx');
  console.error('[AUTH] 6. CLI快速Token登录：bluecode --cli-token=YOUR_TOKEN');
  
  throw new Error('Authentication required');
}


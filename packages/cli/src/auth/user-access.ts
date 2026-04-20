/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getHost } from '../config/hosts.js'

/**
 * 用户访问配置接口
 */
export interface UserAccessConfig {
  allowPublicAccess: boolean;           // 是否允许公开访问
  userList?: number[];                  // 普通用户白名单
  privateModelAccessList?: number[];    // 私有模型访问用户列表
}

/**
 * 缓存配置
 */
let cachedConfig: UserAccessConfig | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

/**
 * 获取用户访问配置（包含私有模型访问列表）
 * 这是唯一的 API 请求入口，其他函数都基于此实现
 * 
 * @param forceRefresh 是否强制刷新缓存，默认 false
 */
export async function getUserAccessConfig(forceRefresh: boolean = false): Promise<UserAccessConfig> {
  // 检查缓存是否有效
  const now = Date.now();
  if (!forceRefresh && cachedConfig && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedConfig;
  }

  try {
    const { host } = await getHost()
    const url = `${host}/api/config/query?key=bluecode-cli.user.access.list`

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.code === '200') {
      const data: UserAccessConfig = JSON.parse(result.data)
      
      // 更新缓存
      cachedConfig = data;
      cacheTimestamp = now;
      
      return data
    }
    const errMsg = await result?.text?.() || ''
    throw new Error(`Get user access config failure, code - ${result.code}, message - ${errMsg}`)
  } catch (error) {
    // @ts-expect-error error.message
    throw new Error(`Get user access config failure, message - ${error?.message ?? ''}`)
  }
}

/**
 * 清除缓存（用于强制刷新）
 */
export function clearUserAccessCache(): void {
  cachedConfig = null;
  cacheTimestamp = 0;
}

/**
 * 检查用户是否有访问权限
 * 基于 getUserAccessConfig() 实现，避免重复请求
 */
export async function isUserAccess(userId: string): Promise<boolean> {
  try {
    const config = await getUserAccessConfig();
    
    // 检查是否允许公开访问
    if (config.allowPublicAccess) {
      return true;
    }
    
    // 检查用户是否在白名单中
    if (config.userList?.includes?.(Number(userId)) ?? false) {
      return true;
    }
    
    return false;
  } catch (error) {
    // @ts-expect-error error.message
    throw new Error(`User access request failure, message - ${error?.message ?? ''}`);
  }
}
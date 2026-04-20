/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 动态域名管理模块
 * 支持环境变量配置、网络连通性检测、内外网自动切换
 */
export interface Hosts {
  host: string;
  npmHost: string;
  loginHost: string;
}

let cached: Hosts | null = null;
let isHostChecked = false;

/**
 * 获取动态域名
 * 支持环境变量配置和网络连通性自动检测
 * 
 * @returns Promise<string> 可用的API域名
 */
const getHost = async (): Promise<Hosts> => {
  let env = process.env.BLUECODE_ENV;
  env = env || 'prod'
  
  // 环境对应的域名映射
  const hostEnum: { [key: string]: string } = {
    local: 'http://aicode-api-test.vmic.xyz',
    test: 'http://aicode-api-test.vmic.xyz',
    pre: 'http://aicode-api-pre.vmic.xyz',
    prod: 'http://aicode-api.vmic.xyz'
  };
  
  const defaultHost = 'http://aicode-api-test.vmic.xyz';
  
  // 如果已经检查过且有缓存的host，直接返回
  if (isHostChecked && cached) {
    // console.log('\n[域名管理] 使用缓存域名:', cachedHost);
    return cached
  }
  
  let host = hostEnum[env] || defaultHost;
  // console.log('\n[域名管理] 检查外网域名:', host);
  
  // 首次检查外网域名连通性
  const result = await checkConnectSuccess(host);
  if (result.success) {
    cached = {
      host,
      npmHost: 'https://npm.vmic.xyz',
      loginHost: 'https://uuc.vivo.xyz'
    };
    isHostChecked = true;
    // console.log('[域名管理] 外网连接成功:', host);
    return cached
  }
  
  // 外网失败，尝试内网域名
  const lanHost = 'http://aicode-api.vivo.lan:8080';
  // console.log('[域名管理] 外网失败，尝试内网域名:', lanHost);
  
  const lanResult = await checkConnectSuccess(lanHost);
  if (lanResult.success) {
    host = lanHost;
    // console.log('[域名管理] 内网连接成功:', lanHost);
  } else {
    // 都失败了，使用默认host
    console.log('[域名管理] 内外网均失败，使用默认域名:', host);
  }

  cached = {
    host,
    npmHost: 'http://npm.vivo.lan:8080',
    loginHost: 'http://uuc.vivo.lan:8080'  // 内网登录域名
  };
  
  isHostChecked = true;
  // console.log('[域名管理] 最终选择域名:', host);
  return cached
};

/**
 * 检查域名连通性
 * 通过访问特定的ping接口来验证域名是否可用
 * 
 * @param host 要检查的域名
 * @returns Promise<{success: boolean}> 连通性检查结果
 */
async function checkConnectSuccess(host: string): Promise<{ success: boolean }> {
  // 使用模型配置查询接口作为ping接口
  const pingUrl = `${host}/api/config/query?key=bluecode-cli.model-list`;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒超时
    
    const response = await fetch(pingUrl, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    clearTimeout(timeoutId);
    
    // 检查响应状态和数据格式
    if (response.ok) {
      const data = await response.json();
      if (data?.code === '200') {
        return { success: true };
      }
    }
    
    return { success: false };
  } catch (error) {
    console.log('[域名管理] 连通性检查失败:', error instanceof Error ? error.message : error);
    return { success: false };
  }
}

/**
 * 重置域名缓存
 * 用于强制重新检查域名连通性
 */
const resetHostCache = (): void => {
  cached = null;
  isHostChecked = false;
  console.log('[域名管理] 域名缓存已重置');
};

/**
 * 获取当前缓存的域名
 * @returns string | null 当前缓存的域名
 */
const getCachedHost = (): Hosts | null => cached;

export { getHost, resetHostCache, getCachedHost };

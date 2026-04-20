/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Authentication API utilities for bluecode-cli
 */

import { getHost } from '../config/hosts.js';

interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}


interface UserInfoResponse {
  userId: string;
  userName: string;
  userAvatar: string;
}

/**
 * 获取API Host（动态）
 */
async function getApiHost(): Promise<string> {
  const hosts = await getHost();
  return hosts.host;
}

/**
 * Query user information by token
 */
export async function queryUserInfo({
  token,
  pluginVersion,
}: {
  token: string;
  pluginVersion: string;
}): Promise<ApiResponse<UserInfoResponse>> {
  const apiHost = await getApiHost();
  const url = `${apiHost}/api/user/info?token=${encodeURIComponent(token)}&pluginVersion=${encodeURIComponent(pluginVersion)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Query user information by crossKey (UUC)
 */
export async function queryUserInfoByUuc({
  crossKey,
  pluginVersion,
}: {
  crossKey: string;
  pluginVersion: string;
}): Promise<ApiResponse<UserInfoResponse>> {
  const apiHost = await getApiHost();
  const url = `${apiHost}/api/user/queryByCrossKey?crossKey=${encodeURIComponent(crossKey)}&pluginVersion=${encodeURIComponent(pluginVersion)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * Get user avatar information
 */
export async function getUserAvatarInfo(
  userId: string,
): Promise<ApiResponse<UserInfoResponse>> {
  const apiHost = await getApiHost();
  const url = `${apiHost}/api/user/getUserAvatar?userId=${encodeURIComponent(userId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json();
}
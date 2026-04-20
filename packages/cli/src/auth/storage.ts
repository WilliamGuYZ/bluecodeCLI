/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local storage utilities for authentication
 * Unified storage using .aicodeUserInfo file
 */

import * as path from 'node:path';
import {
  promises as fsp,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'os';

const AICODE_USER_INFO_PATH = path.join(os.homedir(), '.aicodeUserInfo');

/**
 * Get user ID from .aicodeUserInfo file
 */
export function getUserIdFromLocal(): string | null {
  try {
    if (existsSync(AICODE_USER_INFO_PATH)) {
      const userInfo = readFileSync(AICODE_USER_INFO_PATH, 'utf-8');
      const userId = userInfo.split('\n')[0].trim();
      if (userId && userId.length > 0) {
        return userId;
      }
    }
  } catch (error) {
    console.debug('Error reading .aicodeUserInfo:', error);
  }
  
  return null;
}

/**
 * Save user ID to .aicodeUserInfo file
 */
export async function setUserIdFromLocal(userId: string): Promise<void> {
  try {
    writeFileSync(AICODE_USER_INFO_PATH, userId.trim(), 'utf-8');
  } catch (error) {
    console.error('Error writing .aicodeUserInfo:', error);
    throw error;
  }
}

/**
 * Clear user ID from .aicodeUserInfo file
 */
export async function clearAuthData(): Promise<void> {
  try {
    if (existsSync(AICODE_USER_INFO_PATH)) {
      writeFileSync(AICODE_USER_INFO_PATH, '', 'utf-8');
    }
  } catch (error) {
    console.debug('Error clearing .aicodeUserInfo:', error);
  }
}

/**
 * Get parameter from URL or command line arguments
 */
export function getParameterByName(name: string): string | null {
  // Check command line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` || args[i] === `-${name.charAt(0)}`) {
      return args[i + 1] || null;
    }
    if (args[i].startsWith(`--${name}=`)) {
      return args[i].split('=')[1] || null;
    }
  }

  // Check environment variables
  const envName = name.toUpperCase();
  return process.env[envName] || null;
}
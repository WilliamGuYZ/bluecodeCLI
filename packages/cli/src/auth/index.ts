/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Authentication module entry point
 */

// Main authentication functions
export { initUser, handleUserLogin, updateUserInfo } from './login.js';

// API utilities
export { queryUserInfo, queryUserInfoByUuc, getUserAvatarInfo } from './api.js';

// Storage utilities
export {
  getUserIdFromLocal,
  setUserIdFromLocal,
  clearAuthData,
  getParameterByName,
} from './storage.js';

// Notification utilities
export {
  sendUserId,
  noticePlugin,
  notifyAuthFailed,
  notifyLogout,
  getAuthStatus,
  subscribeToAuthEvents,
  AuthEvents,
} from './notification.js';

// Browser login
export { promptBrowserLogin } from './browser-login.js';

// CLI login for remote/foreign environments
export { performCliLogin, quickTokenLogin } from './cli-login.js';

// Network environment detection
export { detectNetworkEnvironment, getCurrentApiBase, getRecommendedLoginMethod } from './network-detector.js';

export { isUserAccess } from './user-access.js'
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Notification utilities for CLI authentication
 * Handles communication between CLI and external systems
 */

import { getUserIdFromLocal } from './storage.js';


/**
 * Event emitter for authentication notifications
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthEventCallback = (...args: any[]) => void;

class AuthEventEmitter {
  private listeners = new Map<string, AuthEventCallback[]>();

  on(event: string, callback: AuthEventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  emit(event: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((callback) => callback(...args));
    }
  }

  removeListener(event: string, callback: AuthEventCallback): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }
}

export const authEvents = new AuthEventEmitter();

/**
 * Send user ID to CLI context and emit events
 */
export function sendUserId(): void {
  const userId = getUserIdFromLocal();
  if (!userId) {
    return;
  }

  // Set environment variable for current session
  process.env.BLUE_CODE_USER_ID = userId;

  // Emit event for CLI components
  authEvents.emit('user-id-updated', userId);

  // Log for debugging
  console.debug(`[AUTH] User ID sent: ${userId}`);
}

/**
 * Notify CLI that login was successful
 */
export function noticePlugin(): void {
  const userId = getUserIdFromLocal();
  if (!userId) {
    return;
  }

  // Emit login success event
  authEvents.emit('login-success', {
    userId,
    timestamp: new Date().toISOString(),
  });

  // Set authentication status in environment
  process.env.BLUE_CODE_AUTHENTICATED = 'true';

  // Log authentication success
  console.log(`✅ Authentication successful - User ID: ${userId}`);
}

/**
 * Notify CLI that authentication failed
 */
export function notifyAuthFailed(error: Error): void {
  authEvents.emit('login-failed', {
    error: error.message,
    timestamp: new Date().toISOString(),
  });

  console.error(`❌ Authentication failed: ${error.message}`);
}

/**
 * Notify CLI that logout occurred
 */
export function notifyLogout(): void {
  const userId = getUserIdFromLocal();

  // Clear environment variables
  delete process.env.BLUE_CODE_USER_ID;
  delete process.env.BLUE_CODE_AUTHENTICATED;

  // Emit logout event
  authEvents.emit('logout', {
    userId,
    timestamp: new Date().toISOString(),
  });

  console.log('👋 User logged out');
}

/**
 * Get authentication status
 */
export function getAuthStatus(): {
  authenticated: boolean;
  userId: string | null;
  userName: string | null;
} {
  const userId = getUserIdFromLocal();
  const userName = process.env.BLUE_CODE_USER_NAME || null;

  return {
    authenticated: !!userId,
    userId,
    userName,
  };
}

/**
 * Subscribe to authentication events
 */
export function subscribeToAuthEvents(callbacks: {
  onLoginSuccess?: (data: { userId: string; timestamp: string }) => void;
  onLoginFailed?: (data: { error: string; timestamp: string }) => void;
  onLogout?: (data: { userId: string | null; timestamp: string }) => void;
  onUserIdUpdated?: (userId: string) => void;
}): () => void {
  const unsubscribeFunctions: Array<() => void> = [];

  if (callbacks.onLoginSuccess) {
    authEvents.on('login-success', callbacks.onLoginSuccess);
    unsubscribeFunctions.push(() =>
      authEvents.removeListener('login-success', callbacks.onLoginSuccess!),
    );
  }

  if (callbacks.onLoginFailed) {
    authEvents.on('login-failed', callbacks.onLoginFailed);
    unsubscribeFunctions.push(() =>
      authEvents.removeListener('login-failed', callbacks.onLoginFailed!),
    );
  }

  if (callbacks.onLogout) {
    authEvents.on('logout', callbacks.onLogout);
    unsubscribeFunctions.push(() =>
      authEvents.removeListener('logout', callbacks.onLogout!),
    );
  }

  if (callbacks.onUserIdUpdated) {
    authEvents.on('user-id-updated', callbacks.onUserIdUpdated);
    unsubscribeFunctions.push(() =>
      authEvents.removeListener('user-id-updated', callbacks.onUserIdUpdated!),
    );
  }

  // Return unsubscribe function
  return () => {
    unsubscribeFunctions.forEach((unsub) => unsub());
  };
}

/**
 * Export event names for external use
 */
export const AuthEvents = {
  LOGIN_SUCCESS: 'login-success',
  LOGIN_FAILED: 'login-failed',
  LOGOUT: 'logout',
  USER_ID_UPDATED: 'user-id-updated',
} as const;
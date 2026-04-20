/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session cleanup utilities for managing session retention policies.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '@vivo/bluecode-cli-core';
import { getAllSessionFiles } from './sessionUtils.js';

/**
 * Configuration for session retention policy.
 */
export interface SessionRetentionConfig {
  /** Whether automatic cleanup is enabled */
  enabled: boolean;
  /** Maximum age for sessions (e.g., "30d", "7d", "24h", "1w") */
  maxAge?: string;
  /** Maximum number of sessions to keep */
  maxCount?: number;
  /** Minimum retention time before deletion (default: "1d") */
  minRetention?: string;
}

/**
 * Result of cleanup operation.
 */
export interface CleanupResult {
  /** Number of sessions deleted */
  deleted: number;
  /** Number of sessions retained */
  retained: number;
  /** Any errors encountered */
  errors: string[];
}

const DEFAULT_MIN_RETENTION = '1d';

/**
 * Parses a retention period string to milliseconds.
 * Supports formats: "30d", "7d", "24h", "1w", "2w"
 */
export function parseRetentionPeriod(period: string): number {
  const match = period.match(/^(\d+)([dhw])$/);
  if (!match) {
    throw new Error(`Invalid retention period format: ${period}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'w':
      return value * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}

/**
 * Validates a retention configuration.
 */
export function validateRetentionConfig(
  config: SessionRetentionConfig
): boolean {
  if (!config.enabled) {
    return true;
  }

  if (config.maxAge) {
    try {
      parseRetentionPeriod(config.maxAge);
    } catch {
      return false;
    }
  }

  if (config.minRetention) {
    try {
      parseRetentionPeriod(config.minRetention);
    } catch {
      return false;
    }
  }

  if (config.maxCount !== undefined && config.maxCount < 1) {
    return false;
  }

  return true;
}

/**
 * Cleans up expired sessions based on retention policy.
 */
export async function cleanupExpiredSessions(
  config: Config,
  retentionConfig: SessionRetentionConfig,
  currentSessionId?: string
): Promise<CleanupResult> {
  const result: CleanupResult = {
    deleted: 0,
    retained: 0,
    errors: [],
  };

  if (!retentionConfig.enabled) {
    return result;
  }

  const entries = await getAllSessionFiles(config);
  const now = Date.now();

  // Parse retention periods
  const maxAgeMs = retentionConfig.maxAge
    ? parseRetentionPeriod(retentionConfig.maxAge)
    : undefined;
  const minRetentionMs = parseRetentionPeriod(
    retentionConfig.minRetention ?? DEFAULT_MIN_RETENTION
  );

  // Separate valid and corrupted sessions
  const validSessions = entries
    .filter((e) => e.data !== null)
    .map((e) => ({
      filePath: e.filePath,
      id: e.data!.sessionId,
      lastUpdated: new Date(e.data!.lastUpdated).getTime(),
    }))
    .sort((a, b) => b.lastUpdated - a.lastUpdated); // Most recent first

  const corruptedFiles = entries
    .filter((e) => e.data === null)
    .map((e) => e.filePath);

  // Delete corrupted files
  for (const filePath of corruptedFiles) {
    try {
      await fs.unlink(filePath);
      result.deleted++;
    } catch (error) {
      result.errors.push(
        `Failed to delete corrupted file ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Determine which sessions to delete
  const toDelete: string[] = [];
  const toKeep: string[] = [];

  for (let i = 0; i < validSessions.length; i++) {
    const session = validSessions[i];
    const age = now - session.lastUpdated;

    // Never delete current session
    if (session.id === currentSessionId) {
      toKeep.push(session.filePath);
      continue;
    }

    // Never delete sessions younger than minRetention
    if (age < minRetentionMs) {
      toKeep.push(session.filePath);
      continue;
    }

    // Check maxAge
    if (maxAgeMs && age > maxAgeMs) {
      toDelete.push(session.filePath);
      continue;
    }

    // Check maxCount (sessions are already sorted by date)
    if (
      retentionConfig.maxCount &&
      toKeep.length >= retentionConfig.maxCount
    ) {
      toDelete.push(session.filePath);
      continue;
    }

    toKeep.push(session.filePath);
  }

  // Delete old sessions
  for (const filePath of toDelete) {
    try {
      await fs.unlink(filePath);
      result.deleted++;

      // Also try to delete associated activity log
      const activityLogPath = filePath.replace('.json', '-activity.json');
      try {
        await fs.unlink(activityLogPath);
      } catch {
        // Ignore if activity log doesn't exist
      }
    } catch (error) {
      result.errors.push(
        `Failed to delete session ${path.basename(filePath)}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  result.retained = toKeep.length;
  return result;
}

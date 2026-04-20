/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// import type { UpdateInfo } from 'update-notifier';
// import updateNotifier from 'update-notifier';
import semver from 'semver';
import { getPackageJson } from '../../utils/package.js';
import { getHost } from '../../config/hosts.js';

export const FETCH_TIMEOUT_MS = 5000;

const { npmHost } = await getHost();
export const CUSTOM_REGISTRY_URL = npmHost;

export interface UpdateInfo {
  latest: string;
  current: string;
  type: string;
  name: string;
}

export interface UpdateObject {
  message: string;
  update: UpdateInfo;
}

/**
 * From a nightly and stable update, determines which is the "best" one to offer.
 * The rule is to always prefer nightly if the base versions are the same.
 */
function getBestAvailableUpdate(
  nightly?: UpdateInfo | null,
  stable?: UpdateInfo | null,
): UpdateInfo | null {
  if (!nightly) return stable || null;
  if (!stable) return nightly || null;

  const nightlyVer = nightly.latest;
  const stableVer = stable.latest;

  if (
    semver.coerce(stableVer)?.version === semver.coerce(nightlyVer)?.version
  ) {
    return nightly;
  }

  return semver.gt(stableVer, nightlyVer) ? stable : nightly;
}

/**
 * 从自定义 registry 获取包的版本信息
 */
async function fetchPackageInfo(
  packageName: string,
  distTag: 'latest' | 'nightly' = 'latest',
): Promise<UpdateInfo | null> {
  try {
    const encodedName = encodeURIComponent(packageName);
    const registryUrl = `${CUSTOM_REGISTRY_URL}/${encodedName}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(registryUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const packageData = await response.json();
    
    // 获取指定 tag 的版本
    const latestVersion = packageData['dist-tags']?.[distTag];
    if (!latestVersion) {
      return null;
    }

    return {
      latest: latestVersion,
      current: '', // 将在调用处设置
      type: distTag,
      name: packageName,
    } as UpdateInfo;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.warn(`Timeout fetching package info for ${packageName}`);
    } else {
      console.warn(`Failed to fetch package info for ${packageName}:`, error.message);
    }
    return null;
  }
}

export async function checkForUpdates(): Promise<UpdateObject | null> {
  try {
    // Skip update check when running from source (development mode)
    if (process.env['DEV'] === 'true') {
      return null;
    }
    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }

    const { name, version: currentVersion } = packageJson;
    const isNightly = currentVersion.includes('nightly');

    if (isNightly) {
      const [nightlyUpdateInfo, latestUpdateInfo] = await Promise.all([
        fetchPackageInfo(name, 'nightly'),
        fetchPackageInfo(name, 'latest'),
      ]);

      const bestUpdate = getBestAvailableUpdate(
        nightlyUpdateInfo,
        latestUpdateInfo,
      );

      if (bestUpdate && semver.gt(bestUpdate.latest, currentVersion)) {
        const message = `A new version of BlueCode CLI is available! ${currentVersion} → ${bestUpdate.latest}`;
        return {
          message,
          update: { ...bestUpdate, current: currentVersion },
        };
      }
    } else {
      const updateInfo = await fetchPackageInfo(name, 'latest');

      if (updateInfo && semver.gt(updateInfo.latest, currentVersion)) {
        const message = `BlueCode CLI update available! ${currentVersion} → ${updateInfo.latest}`;
        return {
          message,
          update: { ...updateInfo, current: currentVersion },
        };
      }
    }

    return null;
  } catch (e) {
    console.warn('Failed to check for updates: ' + e);
    return null;
  }
}

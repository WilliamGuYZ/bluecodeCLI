/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType, Config } from '@vivo/bluecode-cli-core';
import {
  clearCachedCredentialFile,
  getErrorMessage,
} from '@vivo/bluecode-cli-core';
import { runExitCleanup } from '../../utils/cleanup.js';

export const useAuthCommand = (
  settings: LoadedSettings,
  setAuthError: (error: string | null) => void,
  config: Config,
) => {
  // 延迟初始化AuthDialog状态，给默认模型初始化一些时间
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  
  // 检查是否需要显示AuthDialog
  // useEffect(() => {
  //   const checkAuthDialog = () => {
  //     if (settings.merged?.security?.auth?.selectedType === undefined) {
  //       // 延迟一点时间，让默认模型初始化有机会执行
  //       setTimeout(() => {
  //         if (settings.merged?.security?.auth?.selectedType === undefined) {
  //           setIsAuthDialogOpen(true);
  //         }
  //       }, 200);
  //     }
  //   };
    
  //   checkAuthDialog();
  // }, [settings.merged?.security?.auth?.selectedType]);

  const openAuthDialog = useCallback(() => {
    // setIsAuthDialogOpen(true);
  }, []);

  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const authFlow = async () => {
      const authType = settings.merged.security?.auth?.selectedType;
      if (isAuthDialogOpen || !authType) {
        return;
      }

      try {
        setIsAuthenticating(true);
        await config.refreshAuth(authType); // 模型实例入口
        console.log(`Authenticated via "${authType}".`);
      } catch (e) {
        setAuthError(`Failed to login. Message: ${getErrorMessage(e)}`);
        // openAuthDialog();
      } finally {
        setIsAuthenticating(false);
      }
    };

    void authFlow();
  }, [isAuthDialogOpen, settings, config, setAuthError, openAuthDialog]);

  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, scope: SettingScope) => {
      if (authType) {
        await clearCachedCredentialFile();

        settings.setValue(scope, 'security.auth.selectedType', authType);
        if (
          authType === AuthType.LOGIN_WITH_GOOGLE &&
          config.isBrowserLaunchSuppressed()
        ) {
          runExitCleanup();
          console.log(
            `
----------------------------------------------------------------
Logging in with Google... Please restart Gemini CLI to continue.
----------------------------------------------------------------
            `,
          );
          process.exit(0);
        }
      }
      setIsAuthDialogOpen(false);
      setAuthError(null);
    },
    [settings, setAuthError, config],
  );

  const cancelAuthentication = useCallback(() => {
    setIsAuthenticating(false);
  }, []);

  return {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    isAuthenticating,
    cancelAuthentication,
  };
};

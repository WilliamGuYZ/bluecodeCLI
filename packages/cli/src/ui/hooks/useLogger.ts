/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import type { Storage } from '@vivo/bluecode-cli-core';
import { sessionId, Logger } from '@vivo/bluecode-cli-core';

/**
 * Hook to manage the logger instance.
 */
export const useLogger = (storage: Storage) => {
  const [logger, setLogger] = useState<Logger | null>(null);

  useEffect(() => {
    const newLogger = new Logger(sessionId, storage);
    /**
     * Start async initialization, no need to await. Using await slows down the
     * time from launch to see the bluecode-cli prompt and it's better to not save
     * messages than for the cli to hanging waiting for the logger to loading.
     */
    newLogger
      .initialize()
      .then(() => {
        setLogger(newLogger);
      })
      .catch(() => {});
  }, [storage]);

  return logger;
};

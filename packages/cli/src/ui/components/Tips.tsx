/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type Config } from '@vivo/bluecode-cli-core';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config }) => {
  const geminiMdFileCount = config.getGeminiMdFileCount();
  return (
    <Box flexDirection="column">
      <Text color={Colors.Foreground}>欢迎使用！👋</Text>
      <Text color={Colors.Foreground}>
        1. 你可以在这里提问、修改文件或执行命令。
      </Text>
      <Text color={Colors.Foreground}>
        2. 描述得越清楚，我就能帮得越好。
      </Text>
      {geminiMdFileCount === 0 && (
        <Text color={Colors.Foreground}>
          3. 创建{' '}
          <Text bold color={Colors.AccentPurple}>
            AGENTS.md
          </Text>{' '}
          文件，以自定义你与 BlueCode 的交互行为。
        </Text>
      )}
      <Text color={Colors.Foreground}>
        {geminiMdFileCount === 0 ? '4.' : '3.'}{' '}输入{' '}
        <Text bold color={Colors.AccentPurple}>
          /help
        </Text>{' '}
        了解更多用法。
      </Text>
    </Box>
  );
};

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';

interface AboutBoxProps {
  cliVersion: string;
  osVersion: string;
  sandboxEnv: string;
  modelVersion: string;
  selectedAuthType: string;
  gcpProject: string;
  ideClient: string;
}

export const AboutBox: React.FC<AboutBoxProps> = ({
  cliVersion,
  osVersion,
  sandboxEnv,
  modelVersion,
  selectedAuthType,
  gcpProject,
  ideClient,
}) => (
  <Box
    borderStyle="round"
    borderColor={Colors.Gray}
    flexDirection="column"
    padding={1}
    marginY={1}
    width="100%"
  >
    <Box marginBottom={1}>
      <Text bold color={Colors.AccentPurple}>
        关于 BlueCode CLI
      </Text>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          CLI 版本
        </Text>
      </Box>
      <Box>
        <Text>{cliVersion}</Text>
      </Box>
    </Box>
    {/* {GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO) && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={Colors.LightBlue}>
            Git Commit
          </Text>
        </Box>
        <Box>
          <Text>{GIT_COMMIT_INFO}</Text>
        </Box>
      </Box>
    )} */}
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          当前模型
        </Text>
      </Box>
      <Box>
        <Text>{modelVersion}</Text>
      </Box>
    </Box>
    {/* <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          Sandbox
        </Text>
      </Box>
      <Box>
        <Text>{sandboxEnv}</Text>
      </Box>
    </Box> */}
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          系统
        </Text>
      </Box>
      <Box>
        <Text>{osVersion}</Text>
      </Box>
    </Box>
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          认证类型
        </Text>
      </Box>
      <Box>
        <Text>
          {selectedAuthType.startsWith('oauth') ? 'OAuth' : selectedAuthType}
        </Text>
      </Box>
    </Box>
    {gcpProject && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={Colors.LightBlue}>
            GCP 项目
          </Text>
        </Box>
        <Box>
          <Text>{gcpProject}</Text>
        </Box>
      </Box>
    )}
    {ideClient && (
      <Box flexDirection="row">
        <Box width="35%">
          <Text bold color={Colors.LightBlue}>
            IDE 客户端
          </Text>
        </Box>
        <Box>
          <Text>{ideClient}</Text>
        </Box>
      </Box>
    )}
    <Box flexDirection="row">
      <Box width="35%">
        <Text bold color={Colors.LightBlue}>
          Change Log
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text>
          - 新增对话自动保存/召回功能
        </Text>
        <Text>
          - 修复边界场景下历史记录压缩破坏工具调用对的问题
        </Text>
      </Box>
    </Box>
  </Box>
);

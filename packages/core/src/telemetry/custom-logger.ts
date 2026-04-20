/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { TelemetryEvent } from './types.js';
import { Config } from '../config/config.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import * as os from 'os';
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

interface repoInfo {
  repoType: number;
  repoUrl: string;
}

/**
 * 自定义HTTP埋点记录器
 * 支持公共参数和业务参数分离的上报机制
 */
export class CustomHttpTelemetryLogger {
  private static instance: CustomHttpTelemetryLogger | undefined;
  private config?: Config;
  private userId: string;

  /**
   * TelemetryEvent -> custom_event_id 映射，按 event.name 进行匹配
   */
  private eventMap: Record<string, string> = {
    custorm_file_operation: '00278|295',
    tool_call: '00280|295',
    api_response: '00277|295',
    user_prompt: '00275|295',
    cli_config: 'cli_config_event_id',
    api_request: 'api_request_event_id',
    api_error: 'api_error_event_id',
    file_operation:'file_operation_event_id',
  };

  private commonParams: Record<string, unknown>;

  private constructor(config: Config) {
    this.config = config;
    this.commonParams = this.getCommonParams();
    this.userId = this.getUserId();
  }

  static getInstance(config?: Config): CustomHttpTelemetryLogger | undefined {
    if (!config?.getCustomTelemetryEnabled()) {
      return undefined;
    }
    if (!CustomHttpTelemetryLogger.instance) {
      CustomHttpTelemetryLogger.instance = new CustomHttpTelemetryLogger(
        config,
      );
    }
    return CustomHttpTelemetryLogger.instance;
  }

  /** 测试用例清理实例 */
  static clearInstance(): void {
    CustomHttpTelemetryLogger.instance = undefined;
  }

  private getUserId(): string {
    const userIdPath = path.join(os.homedir(), '.aicodeUserInfo')
    try{
      if (existsSync(userIdPath)) {
        const userInfo = readFileSync(userIdPath, 'utf-8');
        const userId = userInfo.split('\n')[0].trim();
        if (userId && userId.length > 0) {
          return userId;
        }
      }
      return ''
    }catch{
      return ''
    }
  }
  /**
   * 获取公共参数
   */
  private getCommonParams(): Record<string, unknown> {
    const version = this.config?.getCustomData<string>("version") || "unknow"
    const platform = process.platform; // 平台
    const {repoType, repoUrl} = getRepoType();
    const scene = process.env["CLI_SCENE_ENV"] ? process.env["CLI_SCENE_ENV"]: 1
    return {
      cliVersion: version,
      platform,
      repoType,
      repoUrl,
      scene,
    };
  }

  /**
   * 记录埋点事件
   */
  async logEvent(
    event: TelemetryEvent,
    businessParams: Record<string, unknown> = {},
  ): Promise<void> {
    const eventName =
      // 大多数事件是 'event.name'
      // 个别（如 ConversationFinishedEvent）是 'event_name'
      (event as unknown as Record<string, unknown>)['event.name'] ||
      (event as unknown as Record<string, unknown>)['event_name'];

    const eventId =
      (typeof eventName === 'string' && this.eventMap[eventName]) || undefined;
    if (!eventId) {
      console.error('CustomHttpTelemetryLogger: Unknown event type', eventName);
      return;
    }

    const endpoint = this.config?.getCustomTelemetryEndpoint();
    // const endpoint = "http://127.0.0.1:3000"
    if (!endpoint) {
      console.error('CustomHttpTelemetryLogger: No endpoint configured');
      return;
    }

    try {
      // 获取当前版本号
      const pluginVersion = this.config?.getCustomData<string>("version") || "1.0.0";
      
      const data ={
        eventId,
        machineId: '',
        pluginVersion,
        ideVersion: '',
        source: 'cli',
        userId: this.userId,
        params:{
          ...this.commonParams,
          ...businessParams,
        }
      };
      const fetchOptions: RequestInit ={
        method: 'POST',
        headers: this.config?.getCustomTelemetryHeaders() || {
          'Content-Type': 'application/json',
        },
        body: safeJsonStringify(data),
      };
      const res = await fetch(endpoint, fetchOptions);
      if(!res.ok) {
        console.error(`CustomHttpTelemetryLogger: Failed to report telemetry event \n status: ${res.status}\n statusText: ${res.statusText}\n`);
      }
    } catch (error) {
      console.log('reportStat--error', error);
    }
  }
}

function getGlobalStrategyConfig(): {
  repoGitlabKeys?: string[];
  repoGerritKeys?: string[];
} {
  // 默认配置，可以根据需要从配置文件或环境变量中读取
  return {
    repoGitlabKeys: ['gitlab'],
    repoGerritKeys: ['smartgit', 'swegit']
  };
}

function execGitCommand(command: string, directory: string): string {
  try {
    return execSync(command, { 
      cwd: directory, 
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();
  } catch (error) {
    // 存在git仓库，但没有和远程仓库关联返回空
    return '';
  }
}

export function getRepoType(): repoInfo {
  // 0:other、1:gerrit、2:gitlab
  const globalStrategyConfig = getGlobalStrategyConfig();
  
  // 使用传入的工作目录，或当前工作目录
  const directory = process.cwd();
  
  if (!directory) return { repoType: 0, repoUrl: '' };
  
  // 检查是否是 git 仓库
  if (!existsSync(path.join(directory, '.git'))) {
    return { repoType: 0, repoUrl: '' };
  }
  
  const remoteUrl = execGitCommand('git config --get remote.origin.url', directory);
  if (!remoteUrl) return { repoType: 0, repoUrl: '' };
  
  // 标准化URL，移除认证信息
  const normalizedUrl = remoteUrl.toLowerCase()
    .replace(/^.*@/, '')  // 移除用户名@
    .replace(/^https?:\/\/[^@]*@/, 'https://') // 移除HTTP认证

  const repoGitlabKeys = globalStrategyConfig.repoGitlabKeys || ['gitlab'];
  
  // gitLab检测
  if (repoGitlabKeys.some((key: string) => normalizedUrl.includes(key))) {
    return { repoType: 2, repoUrl: remoteUrl };
  }
  
  // gerrit 检测
  const repoGerritKeys = globalStrategyConfig.repoGerritKeys || ['smartgit', 'swegit'];
  if (repoGerritKeys.some((key: string) => normalizedUrl.includes(key))) {
    return { repoType: 1, repoUrl: remoteUrl };
  }
  
  return { repoType: 1, repoUrl: remoteUrl };
}
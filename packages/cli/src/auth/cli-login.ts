/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI终端输入登录模块
 * 用于远程环境或外网环境下的用户认证
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as crypto from 'node:crypto';
import { setUserIdFromLocal } from './storage.js';
import { getHost } from '../config/hosts.js';

// 声明readline-sync模块类型
declare global {
  var readlineSync: any;
}

// 动态导入readline-sync
let readlineSync: any;
let readlineSyncLoaded = false;

async function loadReadlineSync(): Promise<void> {
  if (readlineSyncLoaded) return;
  
  try {
    // 使用动态导入并忽略类型检查
    // @ts-expect-error: 忽略readline-sync的类型
    const module = await import('readline-sync') as any;
    readlineSync = module.default || module;
    readlineSyncLoaded = true;
    // console.log('[AUTH] readline-sync模块已加载，支持安全密码输入');
  } catch (error: any) {
    console.log(error && (error.msg || error.message))
    // 如果readline-sync不可用，使用标准输入
    readlineSync = null;
  }
}

// UUC系统配置 - 使用VS Code插件配置
const APP_CODE = 'gpt-indexCN';
const APP_NAME = 'VBlueCode';
const APP_KEY = 'VM5o123DSiKMCqDk';    // 16字节密钥
const APP_IV = '1393029101920123';     // 16字节初始化向量
const APP_SIGNATURE = '4h4KtdApV5Qv86XwD2DKgg2CVquxOgH%2F';  // 应用签名
const AUTH_CODE = 'e08ee54b541cb2619fedec69a05790bb';  // 认证码

interface CliLoginResult {
  success: boolean;
  userId?: string;
  userName?: string;
  token?: string;
  error?: string;
}

/**
 * AES加密工具类 - 基于VS Code插件加密逻辑实现
 */
class AESUtils {
  /**
   * AES-CBC模式密码加密
   * 用于登录密码加密传输
   * 
   * @param password 明文密码
   * @param key 16字节密钥
   * @param iv 16字节初始化向量
   * @returns base64编码的密文
   */
  static encryptPwd(password: string, key: string, iv: string): string {
    try {
      // 确保密钥和IV为16字节
      const keyBuffer = Buffer.from(key, 'utf8').slice(0, 16);
      const ivBuffer = Buffer.from(iv, 'utf8').slice(0, 16);
      
      const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, ivBuffer);
      let encrypted = cipher.update(password, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      return encrypted;
    } catch (error) {
      throw new Error('密码加密失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  }

  /**
   * AES-ECB模式Token加密
   * 用于生成UUC系统认证token
   * 
   * @param authCode 认证码
   * @param appCode 应用标识
   * @returns 96位十六进制字符串
   */
  static encrypt(authCode: string, appCode: string): string {
    try {
      // 生成16字节密钥：MD5(appCode) -> 取前16字节
      const md5Key = crypto.createHash('md5').update(appCode).digest('hex');
      const key = this.getKey(md5Key);
      
      // 构建认证数据：认证码_时间戳
      const timestamp = String(Date.now());
      const text = authCode + '_' + timestamp;
      
      // ECB模式加密
      const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
      const ecbText = Buffer.concat([
        cipher.update(this.pading(key, text), 'utf8'),
        cipher.final()
      ]);
      const encryptString = ecbText.toString('hex').toUpperCase();
      
      // 与Java/Python版本保持一致，截取前96位
      return encryptString.substring(0, 96);
    } catch (error) {
      throw new Error('Token加密失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  }

  /**
   * 密钥处理 - 生成16字节密钥
   * @param key 原始密钥字符串
   * @returns 16字节处理后的密钥
   */
  private static getKey(key: string): Buffer {
    let sign = crypto.createHash('sha1').update(key).digest();
    sign = crypto.createHash('sha1').update(sign).digest();
    return sign.slice(0, 16);
  }

  /**
   * PKCS7填充处理
   * @param key 密钥
   * @param text 待加密文本
   * @returns 填充后的文本
   */
  private static pading(key: Buffer, text: string): string {
    const lenDif = key.length - (text.length % key.length);
    return text + String.fromCharCode(lenDif).repeat(lenDif);
  }
}

/**
 * 通过CLI终端进行用户登录
 */
export async function performCliLogin(): Promise<CliLoginResult> {
  // console.log('\n[AUTH] ═══════════════════════════════════════');
  // console.log('[AUTH] CLI终端登录');
  // console.log('[AUTH] ═══════════════════════════════════════');

  const rl = createInterface({ input, output });

  try {
    // 直接进行工号+密码登录，跳过登录方式选择
    const username = await rl.question('[AUTH] 请输入工号: ');
    let password: string = '';
    
    // 加载readline-sync模块
    await loadReadlineSync();
    
    // 使用readline-sync进行安全密码输入
    process.stdout.write('[AUTH] 请输入密码: '); // 避免 readlineSync.question 中文乱码问题
    if (readlineSync) {
      password = readlineSync.question('', {
        hideEchoBack: true, // 不回显真实字符
        mask: ''            // 不显示*，完全不显示
      });
    } else {
      // 回退方案：使用标准输入（不安全但可用）
      console.log('[AUTH] 注意：当前环境不支持安全密码输入，请谨慎输入密码');
      password = await rl.question('[AUTH] 请输入密码: ');
    }
    
    if (!username.trim() || !password.trim()) {
      return { success: false, error: '工号和密码不能为空' };
    }

    console.log('[AUTH] 正在验证登录信息...');

    // 执行工号+密码登录验证
    let result = await login(username.trim(), password.trim(), undefined);
    
    if (result.success) {
      // 保存认证信息到 .aicodeUserInfo
      await setUserIdFromLocal(result.userId!);
      
      console.log(`[AUTH] 登录成功！欢迎 ${result.userName || result.userId}`);
      return result;
    } else {
      const errorMessage = result.error || '未知错误';
      console.error(`[AUTH] 登录失败: ${errorMessage}`);
      
      // 根据错误类型进行处理
      if (errorMessage === 'No user info') {
        // 工号错误，直接退出
        console.error('[AUTH] 工号不存在，程序即将退出...');
        process.exit(1);
      } else if (errorMessage === 'password error') {
        // 密码错误，给3次重试机会
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          retryCount++;
          console.log(`[AUTH] 密码错误，还有 ${maxRetries - retryCount + 1} 次尝试机会`);
          
          // 重新输入密码
          process.stdout.write('[AUTH] 请重新输入密码: ');
          let newPassword = '';
          if (readlineSync) {
            newPassword = readlineSync.question('', {
              hideEchoBack: true,
              mask: ''
            });
          } else {
            console.log('[AUTH] 注意：当前环境不支持安全密码输入');
            newPassword = await rl.question('[AUTH] 请重新输入密码: ');
          }
          
          if (!newPassword.trim()) {
            console.error('[AUTH] 密码不能为空');
            continue;
          }
          
          // 重新验证
          result = await login(username.trim(), newPassword.trim(), undefined);
          
          if (result.success) {
            // 登录成功，保存认证信息到 .aicodeUserInfo
            await setUserIdFromLocal(result.userId!);
            
            console.log(`[AUTH] 登录成功！欢迎 ${result.userName || result.userId}`);
            return result;
          } else {
            const retryError = result.error || '未知错误';
            console.error(`[AUTH] 登录失败: ${retryError}`);
            
            // 如果是工号错误（理论上不会发生，因为工号已验证过）
            if (retryError === 'No user info') {
              console.error('[AUTH] 工号不存在，程序即将退出...');
              process.exit(1);
            }
          }
        }
        
        // 3次密码尝试均失败，退出程序
        console.error('[AUTH] 密码连续输入错误，程序即将退出...');
        process.exit(1);
      } else {
        // 其他未知错误，退出程序
        console.error('[AUTH] 登录异常，程序即将退出...');
        process.exit(1);
      }
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    console.error(`[AUTH] 登录过程中发生错误: ${errorMessage}`);
    return { success: false, error: errorMessage };
  } finally {
    rl.close();
  }
}

/**
 * 执行用户登录验证
 */
async function login(username: string, password?: string, token?: string): Promise<CliLoginResult> {
  let response;

  try {
    // 获取动态登录域名
    const hosts = await getHost();
    const loginHost = hosts.loginHost;

    if (!token) {
      // 用户名密码登录
      const uucToken = AESUtils.encrypt(AUTH_CODE, APP_CODE);
      if (!password) {
        throw new Error('密码不能为空');
      }
      const encPwd = AESUtils.encryptPwd(password, APP_KEY, APP_IV);

      // 使用动态登录域名
      const loginUrl = `${loginHost}/uuc/internal/login`;
      response = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'uuid': APP_SIGNATURE,
          'uucToken': uucToken
        },
        body: JSON.stringify({
          uuid: username,
          password: encPwd
        })
      });
    } else {
      // Token验证登录 - 使用动态登录域名
      const tokenUrl = `${loginHost}/api/userInfo/getUserInfo`;
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          configName: 'token.auth.config',
          token
        })
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status}`);
    }

    const result = await response.json() as { code: number; message: string; data?: any };

    if (result.code !== 0 && result.code !== 200) {
      throw new Error(result.message || '登录失败');
    }

    // 外网环境下CLI终端登录，data无实际含义，直接使用输入的工号作为userId
    // 这是UUC系统的特殊响应格式，data=1仅表示成功状态
    const userId = username;
    const userName = username;

    return {
      success: true,
      userId,
      userName,
      token
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '网络请求失败';
    return { success: false, error: errorMessage };
  }
}

/**
 * 快速Token登录（非交互式）
 */
export async function quickTokenLogin(token: string): Promise<CliLoginResult> {
  if (!token.trim()) {
    return { success: false, error: 'Token不能为空' };
  }

  console.log('[AUTH] 正在验证Token...');
  return await login(token, undefined, token);
}
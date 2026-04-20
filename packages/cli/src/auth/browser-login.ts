/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-based login functionality for CLI
 */

import open from 'open';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { setUserIdFromLocal } from './storage.js';
import { queryUserInfo, queryUserInfoByUuc } from './api.js';

const LOGIN_URLS = {
  bpm: 'https://bpm-sso.vivo.xyz/LoginPage.aspx',
  uuc: 'https://uuc.vivo.xyz/#/login'
};

interface LoginResult {
  success: boolean;
  token?: string;
  crossKey?: string;
  error?: string;
}

/**
 * Get local IP address (prefer IPv4)
 */
function getLocalIPAddress(): string {
  const nets = networkInterfaces();
  
  // 优先级规则（从高到低）
  const priorityPatterns = [
    // Linux以太网
    { pattern: /^eth\d+$/, priority: 1 },
    // macOS主网络接口
    { pattern: /^en\d+$/, priority: 1 },
    // Windows以太网（中文）
    { pattern: /^以太网/, priority: 1 },
    // Windows以太网（英文）
    { pattern: /^Ethernet/, priority: 1 },
    // Windows本地连接
    { pattern: /^本地连接/, priority: 1 },
    { pattern: /^Local Area Connection/, priority: 1 },
    // Linux/Windows Wi-Fi
    { pattern: /^wlan\d+$/, priority: 2 },
    { pattern: /^WLAN/, priority: 2 },
    { pattern: /^Wi-Fi/, priority: 2 },
    // 虚拟网络接口（优先级最低）
    { pattern: /^vEthernet/, priority: 3 },
  ];
  
  // 收集所有符合条件的接口及其优先级
  const candidates: Array<{ name: string; address: string; priority: number }> = [];
  
  for (const name of Object.keys(nets)) {
    const iface = nets[name];
    if (!iface) continue;
    
    for (const net of iface) {
      // 跳过内部地址和IPv6地址
      if (net.internal || net.family !== 'IPv4') continue;
      
      // 匹配优先级规则
      let priority = 999; // 默认最低优先级
      for (const rule of priorityPatterns) {
        if (rule.pattern.test(name)) {
          priority = rule.priority;
          break;
        }
      }
      
      candidates.push({ name, address: net.address, priority });
    }
  }
  
  // 按优先级排序（优先级数字越小越优先）
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // 同优先级时，按接口名排序（确保结果稳定）
    return a.name.localeCompare(b.name);
  });
  
  // 返回优先级最高的地址
  if (candidates.length > 0) {
    return candidates[0].address;
  }
  
  // 如果都没找到，回退到localhost
  return 'localhost';
}

/**
 * Start a local server to receive login callback
 */
function startCallbackServer(port: number, host: string): Promise<LoginResult> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${host}:${port}`);
      
      // 从URL中提取token - 处理实际格式：/callback?token=xxx
      const token = url.searchParams.get('token');
      const crossKey = url.searchParams.get('crossKey') || url.searchParams.get('crosskey');
      
      res.writeHead(200, { 
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>登录成功</title>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
              text-align: center; 
              padding: 50px; 
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              margin: 0;
            }
            .container {
              max-width: 400px;
              margin: 0 auto;
              background: white;
              color: #333;
              padding: 40px;
              border-radius: 10px;
              box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            }
            h1 { color: #667eea; margin-bottom: 20px; }
            p { font-size: 16px; line-height: 1.6; }
            .checkmark { font-size: 48px; color: #4CAF50; margin-bottom: 20px; }
            .countdown { font-size: 24px; color: #667eea; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="checkmark">✓</div>
            <h1>登录成功！</h1>
            <p>您已成功登录，可以关闭此页面并返回CLI工具。</p>
            <p>CLI工具将在 <span id="countdown" class="countdown">3</span> 秒后自动继续...</p>
          </div>
          <script>
            let countdown = 3;
            const countdownEl = document.getElementById('countdown');
            
            const timer = setInterval(() => {
              countdown--;
              countdownEl.textContent = countdown;
              
              if (countdown <= 0) {
                clearInterval(timer);
                if (window.opener) {
                  window.close();
                } else {
                  // 对于无法关闭的窗口，显示完成消息
                  document.querySelector('.container').innerHTML = 
                    '<div class="checkmark">✓</div><h1>登录完成</h1><p>您现在可以安全地关闭此页面。</p>';
                }
              }
            }, 1000);
          </script>
        </body>
        </html>
      `);
      
      server.close();
      
      if (token) {
        resolve({ success: true, token });
      } else if (crossKey) {
        resolve({ success: true, crossKey });
      } else {
        resolve({ success: false, error: '未获取到认证信息' });
      }
    });
    
    server.listen(port, () => {
      // Server started, waiting for callback
    });
    
    // 设置超时
    setTimeout(() => {
      server.close();
      console.error('[AUTH] 登录超时，程序即将退出...');
      process.exit(1); // 直接退出CLI终端
    }, 300000); // 5分钟超时
  });
}

/**
 * Open browser for login
 */
export async function openBrowserLogin(): Promise<LoginResult> {
  return new Promise((resolve) => {
    // 获取本地IP地址
    const localIP = getLocalIPAddress();
    
    // 找一个可用的端口
    const server = createServer();
    server.listen(0, async () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(); // 关闭临时服务器
        
        try {
          // 启动真正的回调服务器
          const callbackPromise = startCallbackServer(port, localIP);
          
          // 使用实际IP地址构建登录URL
          const callbackUrl = `http://${localIP}:${port}/callback`;
          const loginUrl = `${LOGIN_URLS.bpm}?RequestUrl=${encodeURIComponent(callbackUrl)}`;
          
          try {
            await open(loginUrl);
            console.log('[AUTH] 已打开浏览器，请完成登录...');
            console.log('[AUTH] 回调地址：', callbackUrl);
            console.log('[AUTH] 如果浏览器未自动打开，请访问：', loginUrl);
          } catch (_error) {
            console.log('[AUTH] 回调地址：', callbackUrl);
            console.log('[AUTH] 如果浏览器未自动打开，请访问：', loginUrl);
          }
          
          // 等待登录完成
          const result = await callbackPromise;
          
          if (result.success) {
            // 登录成功后等待3秒，让用户看到成功页面
            // console.log('[AUTH] 登录成功，等待3秒...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            if (result.token) {
              try {
                const userInfo = await queryUserInfo({ token: result.token, pluginVersion: '1.0.0' });
                if ((String(userInfo.code) === '200') && userInfo.data.userId) {
                  await setUserIdFromLocal(userInfo.data.userId);
                  resolve({ success: true, token: result.token });
                  return;
                }
              } catch (_error) {
                // 验证失败，继续处理
              }
            } else if (result.crossKey) {
              try {
                const userInfo = await queryUserInfoByUuc({ crossKey: result.crossKey, pluginVersion: '1.0.0' });
                if ((String(userInfo.code) === '200') && userInfo.data.userId) {
                  await setUserIdFromLocal(userInfo.data.userId);
                  resolve({ success: true, crossKey: result.crossKey });
                  return;
                }
              } catch (_error) {
                // 验证失败，继续处理
              }
            }
          }
          
          resolve(result);
        } catch (error) {
          resolve({ success: false, error: error instanceof Error ? error.message : '未知错误' });
        }
      } else {
        resolve({ success: false, error: '无法启动回调服务器' });
      }
    });
    
    server.on('error', () => {
      resolve({ success: false, error: '端口占用，请重试' });
    });
  });
}

/**
 * Prompt user to login via browser - simplified version
 */
export async function promptBrowserLogin(): Promise<string | null> {
  console.log('\n[AUTH] ═══════════════════════════════════════');
  console.log('[AUTH] 需要登录验证');
  console.log('[AUTH] ═══════════════════════════════════════');
  
  const result = await openBrowserLogin();
  return result.success ? 'success' : null;
}
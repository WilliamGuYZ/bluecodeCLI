# 动态域名功能使用指南

## 功能概述

动态域名功能支持根据网络环境自动选择最佳的API域名，包括：
- 环境变量配置支持
- 外网/内网自动切换
- 连通性检测和缓存
- 失败重试机制

## 环境变量配置

通过设置 `BLUECODE_ENV` 环境变量来指定运行环境：

```bash
# 开发环境
export BLUECODE_ENV=local

# 测试环境
export BLUECODE_ENV=test

# 预发布环境
export BLUECODE_ENV=pre

# 生产环境
export BLUECODE_ENV=prod
```

## 域名映射规则

|  环境 |            外网域名              |             内网域名             |
|-------|---------------------------------|---------------------------------|
| local | http://aicode-api-test.vmic.xyz | http://aicode-api.vivo.lan:8080 |
| test  | http://aicode-api-test.vmic.xyz | http://aicode-api.vivo.lan:8080 |
| pre   | http://aicode-api-pre.vmic.xyz  | http://aicode-api.vivo.lan:8080 |
| prod  | http://aicode-api.vmic.xyz      | http://aicode-api.vivo.lan:8080 |

## 自动切换逻辑

1. **首次检查**：尝试连接对应环境的外网域名
2. **外网失败**：自动切换到内网域名
3. **全部失败**：使用默认生产域名
4. **结果缓存**：成功的域名会被缓存，避免重复检查

## 代码使用示例

### 基本使用

```typescript
import { getHost } from './src/config/hosts.js';

// 获取当前可用的API域名
const apiHost = await getHost();
console.log('当前API域名:', apiHost);

// 构建完整的API URL
const apiUrl = `${apiHost}/api/config/query?key=bluecode-cli.model-list`;
```

### 在ModelConfig中的集成

```typescript
// modelConfig.ts 中的使用
private async loadFromApi(): Promise<void> {
  // 动态获取可用的API域名
  const host = await getHost();
  this.apiUrl = `${host}/api/config/query?key=bluecode-cli.model-list`;
  
  console.log('[模型配置] 使用API地址:', this.apiUrl);
  
  // 继续API调用...
}
```

### 缓存管理

```typescript
import { resetHostCache, getCachedHost } from './src/config/hosts.js';

// 获取当前缓存的域名
const cached = getCachedHost();
console.log('缓存的域名:', cached);

// 重置缓存（强制重新检查）
resetHostCache();

// 重新获取域名
const newHost = await getHost();
```

### 强制重新加载配置

```typescript
import { forceReloadModelConfig } from './src/ui/utils/modelUtils.js';

// 网络环境变化后，强制重新加载模型配置
const success = await forceReloadModelConfig();
if (success) {
  console.log('模型配置重新加载成功');
} else {
  console.log('模型配置重新加载失败');
}
```

## 连通性检查机制

系统通过访问模型配置查询接口来检查域名连通性：

```
GET {host}/api/config/query?key=bluecode-cli.model-list
```

检查条件：
- HTTP状态码为200
- 响应JSON中 `code` 字段为 `"200"`
- 请求超时时间为2秒

## 日志输出示例

```
[域名管理] 检查外网域名: http://aicode-api-test.vmic.xyz
[域名管理] 外网连接成功: http://aicode-api-test.vmic.xyz
[域名管理] 最终选择域名: http://aicode-api-test.vmic.xyz
[模型配置] 使用API地址: http://aicode-api-test.vmic.xyz/api/config/query?key=bluecode-cli.model-list
```

或者在外网失败的情况下：

```
[域名管理] 检查外网域名: http://aicode-api-test.vmic.xyz
[域名管理] 连通性检查失败: fetch failed
[域名管理] 外网失败，尝试内网域名: http://aicode-api.vivo.lan:8080
[域名管理] 内网连接成功: http://aicode-api.vivo.lan:8080
[域名管理] 最终选择域名: http://aicode-api.vivo.lan:8080
```
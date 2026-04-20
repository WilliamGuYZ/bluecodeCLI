/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { glob } from 'glob';

if (!process.cwd().includes('packages')) {
  console.error('must be invoked from a package directory');
  process.exit(1);
}

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const BLUECODE_ENV = process.env.BLUECODE_ENV || 'prod';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

console.log(`Building package: ${packageJson.name}`);
console.log(`Environment: ${BLUECODE_ENV}, Production: ${IS_PRODUCTION}`);

// 1. 使用 TypeScript 编译
console.log('Compiling TypeScript...');
execSync('tsc --build', { stdio: 'inherit' });

// 2. 注入环境变量到编译后的 JS 文件
console.log('Injecting environment variables...');
function injectEnvVariables(dir) {
  const items = readdirSync(dir);
  
  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      injectEnvVariables(fullPath);
    } else if (extname(item) === '.js') {
      let content = readFileSync(fullPath, 'utf-8');
      
      // 替换环境变量引用
      const originalContent = content;
      content = content.replace(
        /process\.env\.BLUECODE_ENV\s*\|\|\s*['`"]prod['`"]/g,
        `"${BLUECODE_ENV}"`
      );
      content = content.replace(
        /process\.env\.CLI_VERSION/g,
        `"${packageJson.version}"`
      );
      
      if (IS_PRODUCTION) {
        // TODO: 实现更安全的 console.log 移除
        // 暂时禁用以避免破坏代码结构
        
        // 移除多余的空行
        content = content.replace(/\n\s*\n\s*\n/g, '\n\n');
      }
      
      if (content !== originalContent) {
        writeFileSync(fullPath, content);
        console.log(`✓ Processed ${fullPath}`);
      }
    }
  }
}

const distDir = join(packageDir, 'dist');
injectEnvVariables(distDir);

// 3. 清理不需要的文件
console.log('Cleaning up unnecessary files...');
function cleanupFiles() {
  const distDir = join(packageDir, 'dist');
  
  // 删除测试文件
  const testPatterns = [
    '**/*.test.js',
    '**/*.test.js.map', 
    '**/*.test.d.ts',
    '**/*.spec.js',
    '**/*.spec.js.map',
    '**/*.spec.d.ts',
    '**/test-utils/**',
    '**/__tests__/**'
  ];
  
  let deletedCount = 0;
  testPatterns.forEach(pattern => {
    const files = glob.sync(pattern, { cwd: distDir });
    files.forEach(file => {
      const fullPath = join(distDir, file);
      if (existsSync(fullPath)) {
        rmSync(fullPath, { recursive: true, force: true });
        deletedCount++;
      }
    });
  });
  
  // 生产环境删除 source map
  if (IS_PRODUCTION) {
    const sourceMaps = glob.sync('**/*.js.map', { cwd: distDir });
    sourceMaps.forEach(file => {
      const fullPath = join(distDir, file);
      rmSync(fullPath, { force: true });
      deletedCount++;
    });
  }
  
  console.log(`✓ Cleaned up ${deletedCount} unnecessary files`);
}

cleanupFiles();

// 4. 复制必要的资源文件（但排除测试相关）
console.log('Copying resource files...');
function copyResourceFiles() {
  try {
    // 使用修改过的复制脚本，排除测试文件
    const originalCwd = process.cwd();
    
    // 创建临时的复制脚本，排除测试文件
    const tempCopyScript = `
import fs from 'node:fs';
import path from 'node:path';

const sourceDir = path.join('src');
const targetDir = path.join('dist', 'src');

const extensionsToCopy = ['.md', '.json', '.sb'];

function copyFilesRecursive(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const items = fs.readdirSync(source, { withFileTypes: true });

  for (const item of items) {
    // 跳过测试相关文件和目录
    if (item.name.includes('.test.') || item.name.includes('.spec.') || 
        item.name === 'test-utils' || item.name === '__tests__') {
      continue;
    }
    
    const sourcePath = path.join(source, item.name);
    const targetPath = path.join(target, item.name);

    if (item.isDirectory()) {
      copyFilesRecursive(sourcePath, targetPath);
    } else if (extensionsToCopy.includes(path.extname(item.name))) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

if (!fs.existsSync(sourceDir)) {
  console.log('No source directory found, skipping file copy.');
  process.exit(0);
}

copyFilesRecursive(sourceDir, targetDir);
console.log('Successfully copied resource files (excluding tests).');
`;

    writeFileSync(join(packageDir, 'temp_copy.mjs'), tempCopyScript);
    execSync('node temp_copy.mjs', { stdio: 'inherit' });
    rmSync(join(packageDir, 'temp_copy.mjs'), { force: true });
    
  } catch (error) {
    console.warn('Resource file copy failed, continuing...', error.message);
  }
}

copyResourceFiles();

// 5. 处理 CLI 入口文件
function postProcessCLI() {
  if (packageJson.name === '@vivo/bluecode-cli') {
    const mainEntry = join(packageDir, 'dist', 'index.js');
    if (existsSync(mainEntry)) {
      let content = readFileSync(mainEntry, 'utf-8');
      
      // 确保有 shebang
      if (!content.startsWith('#!/usr/bin/env node')) {
        content = '#!/usr/bin/env node\n' + content;
        writeFileSync(mainEntry, content);
        console.log('✓ Added shebang to CLI entry point');
      }
    }
  }
}

postProcessCLI();

// 6. 创建构建标记文件和统计信息
function createBuildInfo() {
  const buildInfo = {
    timestamp: new Date().toISOString(),
    environment: BLUECODE_ENV,
    production: IS_PRODUCTION,
    version: packageJson.version,
    nodeVersion: process.version
  };
  
  writeFileSync(
    join(packageDir, 'dist', '.last_build'), 
    JSON.stringify(buildInfo, null, 2)
  );
  
  // 统计最终体积
  try {
    const result = execSync(`du -sh "${join(packageDir, 'dist')}"`, { encoding: 'utf8' });
    const size = result.split('\t')[0];
    
    const fileCount = execSync(`find "${join(packageDir, 'dist')}" -type f | wc -l`, { encoding: 'utf8' }).trim();
    
    console.log(`✓ Build completed successfully!`);
    console.log(`  Final size: ${size}`);
    console.log(`  File count: ${fileCount}`);
    console.log(`  Environment: ${BLUECODE_ENV}`);
    console.log(`  Production optimizations: ${IS_PRODUCTION ? 'enabled' : 'disabled'}`);
    
  } catch (error) {
    console.log(`✓ Build completed successfully!`);
  }
}

createBuildInfo();
import axios from 'axios';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import * as child_process from 'node:child_process';

export interface IResponse {
  version: string;
  vsix: string;
}

const http = axios.create({
  baseURL: "http://127.0.0.1:3000",
  timeout: 10000
})

export class CliPluginUpdater {
  private remote: IResponse = {
    version: '',
    vsix: ''
  };

  constructor() {}

  private getPluginVersion(): string {
    try {
      const home = os.homedir();

      // VS Code 家族可能的插件目录
      const vscodeDirs = [
        path.join(home, ".vscode", "extensions"),          // 正式版
        path.join(home, ".vscode-insiders", "extensions"), // Insiders
        path.join(home, ".vscode-oss", "extensions"),      // OSS / VSCodium
        path.join(home, ".cursor", "extensions")           // Cursor
      ];

      for (const dir of vscodeDirs) {
        const extensionsJsonPath = path.join(dir, "extensions.json");
        if (!fs.existsSync(extensionsJsonPath)) {
          continue; // 该目录不存在，跳过
        }

        const content = fs.readFileSync(extensionsJsonPath, "utf8");
        const extensions = JSON.parse(content) as any[];

        const target = extensions.find(
          ext =>
            ext.identifier?.id?.toLowerCase() === "vivo.vscode-bluecode-cli" ||
            ext.identifier?.id?.toLowerCase().includes("bluecode-cli")
        );

        if (target) {
          return target.version || "0.0.0";
        }
      }

      return "0.0.1"; // 所有 VS Code 变体都没找到 → 未安装
    } catch (err) {
      console.error("获取插件版本失败:", err);
      return "0.0.0"; // 出错
    }
  }

  private compareVersions(localVersion: string, remoteVersion: string): number {
    const localParts = localVersion.split('.').map(Number);
    const remoteParts = remoteVersion.split('.').map(Number);

    const maxLength = Math.max(localParts.length, remoteParts.length);

    for (let i = 0; i < maxLength; i++) {
      const localPart = localParts[i] || 0;
      const remotePart = remoteParts[i] || 0;

      if (localPart < remotePart) return -1;
      if (localPart > remotePart) return 1;
    }

    return 0;
  }

  public async haveNewUpdate(): Promise<boolean> {
    try {
      // 获取本地插件版本
      const localPluginVersion = this.getPluginVersion();
      console.log('本地插件版本:', localPluginVersion);

      if (localPluginVersion === "0.0.0") {
        return false // 未正常获取到版本号
      }
      // 获取远程版本信息
      const remoteInfo = await this.fetchRemoteMeta();
      // console.log('远程版本信息:', remoteInfo);

      this.remote = remoteInfo;

      // 比较版本
      const needUpdate = this.compareVersions(localPluginVersion, remoteInfo.version) === -1;
      console.log(`远程版本 ${remoteInfo.version} vs 本地版本 ${localPluginVersion}，需要更新:`, needUpdate);

      return needUpdate;
    } catch (error) {
      console.error('检查更新失败:', error);
      return false;
    }
  }

  // 获取版本号
  private async fetchRemoteMeta(): Promise<IResponse> {
    try {
      const res = await http({
        method: 'GET',
        url: '/meta'
      })
      // const res = await http.get('/meta');
      const { data } = res;

      return {
        version: data.version || '0.0.0',
        vsix: data.vsix || `vscode-bluecode-cli-${data.version || 'latest'}.vsix`
      };
    } catch (error) {
      console.error('获取远程元数据失败:', error);
      // 返回默认值，避免程序崩溃
      return {
        version: '0.0.0',
        vsix: 'vscode-bluecode-cli-latest.vsix'
      };
    }
  }

  public async update(): Promise<{ status: boolean; code: string }> {
    try {
      // 下载插件
      const pluginPath = await this.downloadExt(this.remote.vsix);
      // console.log('插件下载路径:', pluginPath);

      // 验证文件完整性
      if (!fs.existsSync(pluginPath)) {
        throw new Error('插件文件下载失败');
      }

      // 计算文件哈希
      const pluginHash = await this.calculateFileHash(pluginPath);
      // console.log('插件文件哈希:', pluginHash);

      const commandPath = this.findVsCodeCommand()
      if (!commandPath) {
        return {
          status: false,
          code: "Please ensure 'code' is in your system's PATH. For help, see https://code.visualstudio.com/docs/configure/command-line#_code-is-not-recognized-as-an-internal-or-external-command."
        };
      }

      try {
        const command = `"${await commandPath}" --install-extension "${pluginPath}" --force`;
        // await this.installVsix(pluginPath);
        child_process.execSync(command, { stdio: 'inherit' });
        // 实际环境中可能需要调用系统命令来安装插件
        // console.log('✅ 插件更新完成');
      } catch (_error) {
        // console.log("~~~", _error)
        // 清理下载文件
        setTimeout(() => {
          if (fs.existsSync(pluginPath)) {
            fs.unlinkSync(pluginPath);
            // console.log('清理临时文件完成');
          }
        }, 1000);
        return {
          status: false,
          code: "安装失败"
        }
      }

      // 清理下载文件
      setTimeout(() => {
        if (fs.existsSync(pluginPath)) {
          fs.unlinkSync(pluginPath);
          console.log('清理临时文件完成');
        }
      }, 1000);

      return { status: true, code: 'success' };
    } catch (error) {
      console.error('插件更新失败:', error);
      return { status: false, code: 'updateError' };
    }
  }

  private async downloadExt(name: string): Promise<string> {
    try {
      console.log('开始下载插件:', name);

      const file = path.join(os.tmpdir(), name);
      console.log('下载目标路径:', file);

      // const res = await http.get('/meta');
      const res = await http({
        method: 'GET',
        url: name,
        responseType: 'stream'
      })
      console.log('下载响应状态码:', res.status);

      return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(file);
        res.data.pipe(writer);

        writer.on('finish', () => {
          console.log('插件下载完成');
          resolve(file);
        });

        writer.on('error', (error) => {
          console.error('插件下载失败:', error);
          reject(error);
        });
      });
    } catch (error) {
      console.error('下载插件失败:', error);
      throw error;
    }
  }

  private async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(filePath)) {
        reject(new Error(`文件不存在: ${filePath}`));
        return;
      }

      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => {
        hash.update(data);
      });

      stream.on('end', () => {
        const fileHash = hash.digest('hex');
        resolve(fileHash);
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  private getVsCodeCommand(platform: NodeJS.Platform = process.platform) {
    return platform === 'win32' ? 'code.cmd' : 'code';
  }
  private async findVsCodeCommand(): Promise<string | null> {
    // 检查cmd
    const platform: NodeJS.Platform = process.platform
    const vscodeCommand = this.getVsCodeCommand(platform);
    try {
      if (platform === 'win32') {
        const result = child_process
          .execSync(`where.exe ${vscodeCommand}`)
          .toString()
          .trim();
        // `where.exe` can return multiple paths. Return the first one.
        const firstPath = result.split(/\r?\n/)[0];
        if (firstPath) {
          return firstPath;
        }
      } else {
        child_process.execSync(`command -v ${vscodeCommand}`, {
          stdio: 'ignore',
        });
        return vscodeCommand;
      }
    } catch {
      // Not in PATH, continue to check common locations.
    }

    const locations: string[] = [];
    const homeDir = os.homedir();

    if (platform === 'darwin') {
      // macOS
      locations.push(
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        path.join(homeDir, 'Library/Application Support/Code/bin/code'),
      );
    } else if (platform === 'linux') {
      // Linux
      locations.push(
        '/usr/share/code/bin/code',
        '/snap/bin/code',
        path.join(homeDir, '.local/share/code/bin/code'),
      );
    } else if (platform === 'win32') {
      // Windows
      locations.push(
        path.join(
          process.env['ProgramFiles'] || 'C:\\Program Files',
          'Microsoft VS Code',
          'bin',
          'code.cmd',
        ),
        path.join(
          homeDir,
          'AppData',
          'Local',
          'Programs',
          'Microsoft VS Code',
          'bin',
          'code.cmd',
        ),
      );
    }

    for (const location of locations) {
      if (fs.existsSync(location)) {
        return location;
      }
    }

    return null;
  }
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execAsync = promisify(exec);

const MAX_TRAVERSAL_DEPTH = 32;

/**
 * Fetches process information using PowerShell and Get-CimInstance.
 * This is the modern replacement for wmic on Windows.
 *
 * @param pid The process ID to inspect.
 * @returns A promise that resolves to the parent's PID, name, and command.
 */
async function getProcessInfoViaPowerShell(pid: number): Promise<{
  parentPid: number;
  name: string;
  command: string;
}> {
  // Use PowerShell to query process information
  // -NoProfile: Skip loading user profile for faster startup
  // -Command: Execute the script block
  // ConvertTo-Json -Compress: Output as single-line JSON for easier parsing
  const psCommand = `powershell -NoProfile -Command "& { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"; if ($p) { @{ Name = $p.Name; ParentProcessId = $p.ParentProcessId; CommandLine = $p.CommandLine } | ConvertTo-Json -Compress } }"`;

  const { stdout } = await execAsync(psCommand, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024, // 1MB buffer for long command lines
  });

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`No process found with PID ${pid}`);
  }

  // Parse the JSON output
  const processData = JSON.parse(trimmed) as {
    Name: string;
    ParentProcessId: number;
    CommandLine: string | null;
  };

  return {
    parentPid: processData.ParentProcessId || 0,
    name: processData.Name || '',
    command: processData.CommandLine || '',
  };
}

/**
 * Fetches process information using wmic (legacy method).
 * This is kept as a fallback for older Windows systems.
 *
 * @param pid The process ID to inspect.
 * @returns A promise that resolves to the parent's PID, name, and command.
 */
async function getProcessInfoViaWmic(pid: number): Promise<{
  parentPid: number;
  name: string;
  command: string;
}> {
  const command = `wmic process where "ProcessId=${pid}" get Name,ParentProcessId,CommandLine /value`;
  const { stdout } = await execAsync(command);
  const nameMatch = stdout.match(/Name=([^\n]*)/);
  const processName = nameMatch ? nameMatch[1].trim() : '';
  const ppidMatch = stdout.match(/ParentProcessId=(\d+)/);
  const parentPid = ppidMatch ? parseInt(ppidMatch[1], 10) : 0;
  const commandLineMatch = stdout.match(/CommandLine=([^\n]*)/);
  const commandLine = commandLineMatch ? commandLineMatch[1].trim() : '';
  return { parentPid, name: processName, command: commandLine };
}

/**
 * Fetches the parent process ID, name, and command for a given process ID.
 * On Windows, it tries PowerShell first, then falls back to wmic if needed.
 *
 * @param pid The process ID to inspect.
 * @returns A promise that resolves to the parent's PID, name, and command.
 */
async function getProcessInfo(pid: number): Promise<{
  parentPid: number;
  name: string;
  command: string;
}> {
  const platform = os.platform();
  if (platform === 'win32') {
    // Try PowerShell first (modern method)
    try {
      return await getProcessInfoViaPowerShell(pid);
    } catch (psError) {
      // Fall back to wmic (legacy method) for older Windows systems
      try {
        return await getProcessInfoViaWmic(pid);
      } catch (wmicError) {
        // If both methods fail, throw the PowerShell error as it's more informative
        throw psError;
      }
    }
  } else {
    const command = `ps -o ppid=,command= -p ${pid}`;
    const { stdout } = await execAsync(command);
    const trimmedStdout = stdout.trim();
    const ppidString = trimmedStdout.split(/\s+/)[0];
    const parentPid = parseInt(ppidString, 10);
    const fullCommand = trimmedStdout.substring(ppidString.length).trim();
    const processName = path.basename(fullCommand.split(' ')[0]);
    return {
      parentPid: isNaN(parentPid) ? 1 : parentPid,
      name: processName,
      command: fullCommand,
    };
  }
}

/**
 * Finds the IDE process info on Unix-like systems.
 *
 * The strategy is to find the shell process that spawned the CLI, and then
 * find that shell's parent process (the IDE). To get the true IDE process,
 * we traverse one level higher to get the grandparent.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 */
async function getIdeProcessInfoForUnix(): Promise<{
  pid: number;
  command: string;
}> {
  const shells = ['zsh', 'bash', 'sh', 'tcsh', 'csh', 'ksh', 'fish', 'dash'];
  let currentPid = process.pid;

  for (let i = 0; i < MAX_TRAVERSAL_DEPTH; i++) {
    try {
      const { parentPid, name } = await getProcessInfo(currentPid);

      const isShell = shells.some((shell) => name === shell);
      if (isShell) {
        // The direct parent of the shell is often a utility process (e.g. VS
        // Code's `ptyhost` process). To get the true IDE process, we need to
        // traverse one level higher to get the grandparent.
        let idePid = parentPid;
        try {
          const { parentPid: grandParentPid } = await getProcessInfo(parentPid);
          if (grandParentPid > 1) {
            idePid = grandParentPid;
          }
        } catch {
          // Ignore if getting grandparent fails, we'll just use the parent pid.
        }
        const { command } = await getProcessInfo(idePid);
        return { pid: idePid, command };
      }

      if (parentPid <= 1) {
        break; // Reached the root
      }
      currentPid = parentPid;
    } catch {
      // Process in chain died
      break;
    }
  }

  const { command } = await getProcessInfo(currentPid);
  return { pid: currentPid, command };
}

/**
 * Finds the IDE process info on Windows.
 *
 * The strategy is to find the great-grandchild of the root process.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 */
async function getIdeProcessInfoForWindows(): Promise<{
  pid: number;
  command: string;
}> {
  let currentPid = process.pid;
  let previousPid = process.pid;
  let lastValidPid = process.pid;
  let lastValidCommand = '';

  for (let i = 0; i < MAX_TRAVERSAL_DEPTH; i++) {
    try {
      const { parentPid, command } = await getProcessInfo(currentPid);
      
      // Store the last valid process info we successfully retrieved
      lastValidPid = currentPid;
      lastValidCommand = command;

      if (parentPid > 0) {
        try {
          const { parentPid: grandParentPid } = await getProcessInfo(parentPid);
          if (grandParentPid === 0) {
            // We've found the grandchild of the root (`currentPid`). The IDE
            // process is its child, which we've stored in `previousPid`.
            try {
              const { command: prevCommand } = await getProcessInfo(previousPid);
              return { pid: previousPid, command: prevCommand };
            } catch {
              // If getting previousPid fails, fall back to current process info
              return { pid: lastValidPid, command: lastValidCommand };
            }
          }
        } catch {
          // getting grandparent failed, proceed
        }
      }

      if (parentPid <= 0) {
        break; // Reached the root
      }
      previousPid = currentPid;
      currentPid = parentPid;
    } catch {
      // Process in chain died or doesn't exist anymore
      // Return the last valid process info we found
      break;
    }
  }
  
  // Fallback: try to get info for the last known valid PID
  try {
    const { command } = await getProcessInfo(lastValidPid);
    return { pid: lastValidPid, command };
  } catch {
    // If even that fails, return the original process info
    return { pid: process.pid, command: process.argv.join(' ') };
  }
}

/**
 * Traverses up the process tree to find the process ID and command of the IDE.
 *
 * This function uses different strategies depending on the operating system
 * to identify the main application process (e.g., the main VS Code window
 * process).
 *
 * If the IDE process cannot be reliably identified, it will return the
 * top-level ancestor process ID and command as a fallback.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 * @throws Will throw an error if the underlying shell commands fail.
 */
export async function getIdeProcessInfo(): Promise<{
  pid: number;
  command: string;
}> {
  const platform = os.platform();

  if (platform === 'win32') {
    return getIdeProcessInfoForWindows();
  }

  return getIdeProcessInfoForUnix();
}

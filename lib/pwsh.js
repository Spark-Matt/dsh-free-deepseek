/**
 * pwsh（PowerShell 7）发现与注入。
 *
 * DeepSeek Harness 的 shell 工具直接调 `pwsh`，而 Windows 只自带
 * Windows PowerShell 5.1（powershell.exe）。缺 pwsh 时工具一律起不来
 * （典型报错 0xC0000142），agent 就等于「只能聊天不能干活」。
 *
 * 注意：通过 winget/Store 装的 pwsh 是 **AppX 执行别名**（0 字节重解析点），
 * fs.existsSync 看不到它，但 CreateProcess 能正常拉起。所以判定必须「试跑一次」，
 * 不能只看文件是否存在。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';

/** 插件自带的副本目录（可选，dsh install 时可放一份） */
export const PWSh_HOME = path.join(os.homedir(), '.dsh-free-deepseek', 'pwsh');

/** 真实文件形式的常见安装位置 */
function fileCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(PWSh_HOME, EXE),
    path.join(PWSh_HOME, 'PowerShell-7', EXE),
    path.join(pf, 'PowerShell', '7', EXE),
    path.join(pf, 'PowerShell', '7-preview', EXE),
    path.join(local, 'Microsoft', 'PowerShell', '7', EXE),
  ];
}

/** 试跑一次，能跑通才算有 */
function canRun(bin) {
  try {
    const r = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      timeout: 15000,
      stdio: 'ignore',
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 返回可用的 pwsh 路径（找不到返回 null） */
export function findPwsh() {
  for (const file of fileCandidates()) {
    try {
      if (fs.existsSync(file) && canRun(file)) return file;
    } catch {
      /* 权限问题跳过 */
    }
  }
  // PATH 里的（含 AppX 执行别名）
  if (canRun('pwsh')) return 'pwsh';
  return null;
}

/**
 * 确保 pwsh 可被 Harness 的子进程找到：
 * 找到真实文件就把其目录前置进 PATH，找不到就给出可执行的修复提示。
 * @returns {{ ok: boolean, path?: string }}
 */
export function ensurePwsh({ logger } = {}) {
  const found = findPwsh();
  if (!found) {
    logger?.warn?.(
      'dsh-free-deepseek: 没找到 pwsh（PowerShell 7），Harness 的 shell 工具会失败（0xC0000142）。' +
        '执行 `npx -y dsh-free-deepseek pwsh` 安装。',
    );
    return { ok: false };
  }
  if (found !== 'pwsh') {
    const dir = path.dirname(found);
    const parts = (process.env.PATH || '').split(path.delimiter);
    if (!parts.some((p) => p && path.resolve(p) === path.resolve(dir))) {
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
      logger?.info?.(`dsh-free-deepseek: 已把 pwsh 目录注入 PATH（${dir}）`);
    }
  }
  return { ok: true, path: found };
}

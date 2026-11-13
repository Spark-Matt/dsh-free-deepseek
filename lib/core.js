/**
 * 内核（fuckds 代理）托管：确保 127.0.0.1:<port> 上有服务在跑。
 *
 * 内核目录来自 ~/.dsh-free-deepseek/config.json（由 dsh install 写入），
 * 也支持 DSH_FREE_DEEPSEEK_CORE / DSH_FREE_DEEPSEEK_PORT 环境变量覆盖。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = path.join(os.homedir(), '.dsh-free-deepseek');
const CONFIG_FILE = path.join(HOME, 'config.json');

export function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* 没装过就用默认值 */
  }
  return {
    coreDir: process.env.DSH_FREE_DEEPSEEK_CORE || file.coreDir || path.join(HOME, 'fuckds'),
    port: Number(process.env.DSH_FREE_DEEPSEEK_PORT || file.port || 8787),
  };
}

export async function health(port, timeout = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeout) });
    return await res.json();
  } catch {
    return null;
  }
}

let pending = null;

/**
 * 确保代理在跑；返回 { port, token } 健康信息。
 * 未安装内核时抛出可读错误，由调用方转成「请先执行 dsh install」的提示。
 */
export async function ensureCore({ logger, port, coreDir } = {}) {
  const cfg = readConfig();
  const usePort = port || cfg.port;
  const dir = coreDir || cfg.coreDir;

  const alive = await health(usePort);
  if (alive?.ok) return alive;

  if (!fs.existsSync(path.join(dir, 'src', 'index.mjs'))) {
    throw new Error(`找不到内核 ${dir}，先执行：npx -y dsh-free-deepseek install`);
  }

  if (!pending) {
    pending = (async () => {
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      const logPath = path.join(dir, 'data', 'server.log');
      const out = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [path.join(dir, 'src', 'index.mjs')], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env },
      });
      child.unref();
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const h = await health(usePort);
        if (h?.ok) {
          logger?.info?.(`dsh-free-deepseek: 内核已启动（pid ${h.pid}，engine=${h.engine}）`);
          return h;
        }
      }
      throw new Error(`内核启动超时，查看日志 ${logPath}`);
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

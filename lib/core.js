/**
 * 内核（fuckds 代理）托管：确保 127.0.0.1:<port> 上有服务在跑。
 *
 * 内核有两种来源：
 *   1. 本插件自带（`<包目录>/core`）—— 装上插件就有，不需要另外克隆仓库
 *   2. 用户自己指定的目录（config.json 的 coreDir / DSH_FREE_DEEPSEEK_CORE）
 *
 * 自带内核的意义：换一台电脑只要「装插件 + 填一次 token」两步，
 * 不用再装 git、不用 clone、不用编 Go（PoW 求解器的五个平台二进制已经预编译好）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件自带的完整内核（src + 各平台 ds-pow） */
const BUNDLED_CORE = path.join(HERE, '..', 'core');

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

export function writeConfig(next) {
  const current = readConfig();
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(
    CONFIG_FILE,
    `${JSON.stringify({ ...current, ...next }, null, 2)}\n`,
    'utf8',
  );
}

export async function health(port, timeout = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeout) });
    return await res.json();
  } catch {
    return null;
  }
}

/** 当前平台对应的 PoW 求解器文件名（与 core/bin 里的预编译产物一一对应） */
export function powBinaryName(platform = process.platform, arch = process.arch) {
  const ext = platform === 'win32' ? '.exe' : '';
  return `ds-pow-${platform}-${arch}${ext}`;
}

/** 内核是否已经就位（有入口文件即可） */
function coreReady(dir) {
  return fs.existsSync(path.join(dir, 'src', 'index.mjs'));
}

/**
 * 把插件自带的内核铺到 dir。
 *
 * 只覆盖 src 与 package.json，不动 data/（登录态）和 .env（用户配置）——
 * 升级插件时重新铺一遍源码，用户的 token 和端口设置不会丢。
 */
export function materializeCore(dir, { port = 8787, logger } = {}) {
  if (!fs.existsSync(BUNDLED_CORE)) {
    throw new Error(
      `插件里没有自带内核（缺 ${BUNDLED_CORE}）。请用官方 npm 包安装，或手动指定 DSH_FREE_DEEPSEEK_CORE 指向已有的内核目录。`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });

  // 1. 源码
  const srcFrom = path.join(BUNDLED_CORE, 'src');
  const srcTo = path.join(dir, 'src');
  fs.rmSync(srcTo, { recursive: true, force: true });
  fs.cpSync(srcFrom, srcTo, { recursive: true });

  // 2. 内核自己的 package.json（type: module 等运行时必需）
  const pkgFrom = path.join(BUNDLED_CORE, 'package.json');
  if (fs.existsSync(pkgFrom)) fs.cpSync(pkgFrom, path.join(dir, 'package.json'));

  // 3. 当前平台的 PoW 求解器
  const binName = powBinaryName();
  const binFrom = path.join(BUNDLED_CORE, 'bin', binName);
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (fs.existsSync(binFrom)) {
    fs.cpSync(binFrom, path.join(binDir, binName));
    try {
      fs.chmodSync(path.join(binDir, binName), 0o755);
    } catch {
      /* Windows 上不需要，失败也无所谓 */
    }
  } else {
    logger?.warn?.(
      `dsh-free-deepseek: 没有 ${binName} 的预编译 PoW 求解器（平台 ${process.platform}/${process.arch}），直连引擎会不可用`,
    );
  }

  // 4. .env：只在不存在时生成，避免覆盖用户改过的配置
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(
      envFile,
      [
        '# 由 dsh-free-deepseek 自动生成；改完重启内核生效',
        'ENGINE=direct',
        `POW_BIN=bin/${binName}`,
        `HOST=127.0.0.1`,
        `PORT=${port}`,
        'DEEPSEEK_THINKING=auto',
        'DEEPSEEK_DEVICE_PROFILE=chrome-win',
        'DEEPSEEK_COLD_START=true',
        'DEEPSEEK_HUMAN_TIMING=true',
        'CONCURRENCY=1',
        'MAX_PROMPT_CHARS=400000',
        'SAVE_ARTIFACTS=true',
        'LOG_LEVEL=info',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  logger?.info?.(`dsh-free-deepseek: 内核已铺到 ${dir}（PoW 求解器 ${binName}）`);
  return dir;
}

/** 内核需要一份网页登录态才能干活；没有就提前给出可执行的提示，而不是让每个请求 502 */
function assertToken(dir) {
  if (process.env.DEEPSEEK_USER_TOKEN || process.env.DEEPSEEK_USER_TOKENS) return;
  const authFile = path.join(dir, 'data', 'auth.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const list = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    if (parsed?.token) list.push(parsed.token);
    if (list.some((t) => typeof t === 'string' && t.trim())) return;
  } catch {
    /* 文件不存在或损坏都算没有 */
  }
  throw new Error(
    [
      '还没有 DeepSeek 网页登录态，内核启动了也用不了。',
      '在浏览器登录 chat.deepseek.com，然后任选一种方式写入 token：',
      '  1) npx dsh-free-deepseek token <userToken>',
      '  2) 手动写 ' + authFile,
      'userToken 取法：F12 → Application → Local Storage → chat.deepseek.com → userToken',
    ].join('\n'),
  );
}

let pending = null;

/**
 * 确保代理在跑；返回健康信息。
 *
 * 顺序：已经在跑 → 直接返回；没内核 → 用自带的铺一份；没登录态 → 报可读错误；最后拉起进程。
 */
export async function ensureCore({ logger, port, coreDir } = {}) {
  const cfg = readConfig();
  const usePort = port || cfg.port;
  const dir = coreDir || cfg.coreDir;

  const alive = await health(usePort);
  if (alive?.ok) return alive;

  if (!coreReady(dir)) {
    materializeCore(dir, { port: usePort, logger });
    writeConfig({ coreDir: dir, port: usePort });
  }

  assertToken(dir);

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
      for (let i = 0; i < 120; i += 1) {
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

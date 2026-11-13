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
  const binTo = path.join(binDir, binName);
  fs.mkdirSync(binDir, { recursive: true });
  if (!fs.existsSync(binFrom)) {
    logger?.warn?.(
      `dsh-free-deepseek: 没有 ${binName} 的预编译 PoW 求解器（平台 ${process.platform}/${process.arch}），直连引擎会不可用`,
    );
  } else if (sameFile(binFrom, binTo)) {
    // 内容一致就不用动。Windows 上内核正在跑时 exe 是锁着的，覆盖会 EIO。
  } else {
    try {
      fs.cpSync(binFrom, binTo);
      fs.chmodSync(binTo, 0o755);
    } catch (err) {
      // 内核正在运行时二进制被占用：保留旧的继续用，不要因此让整个流程失败
      logger?.warn?.(
        `dsh-free-deepseek: 更新 ${binName} 失败（${err?.code || err?.message}），继续使用现有文件；` +
          '如果之后出现 spawn UNKNOWN，先停掉内核再重试。',
      );
    }
  }

  // 4. .env：只在不存在时生成，避免覆盖用户改过的配置
  const envFile = path.join(dir, '.env');  if (!fs.existsSync(envFile)) {
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

  // 5. 设备标识体检
  assertDeviceIdentity(dir, logger);

  logger?.info?.(`dsh-free-deepseek: 内核已铺到 ${dir}（PoW 求解器 ${binName}）`);
  return dir;
}

/** 两个文件内容是否一致（大小相同再比字节，避免每次铺内核都重写二进制） */
function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * 检查登录态与设备标识是否配套。
 *
 * 内核把设备标识存在 `data/device-<token 哈希>.json` 里，平台据此认定「同一台设备」。
 * 如果 auth.json 还在、device 文件却没了（典型场景：换内核目录只搬了 auth.json），
 * 内核会生成一个新的 deviceId —— 同一个 token 突然从「新设备」发请求，
 * 会被平台判定为凭据泄漏，直接吊销整个会话（浏览器那边的登录态也会一起被清空）。
 *
 * 这里只警告不改行为：device 文件一旦丢了就无法还原，需要用户重新登录。
 */
function assertDeviceIdentity(dir, logger) {
  const dataDir = path.join(dir, 'data');
  const authFile = path.join(dataDir, 'auth.json');
  if (!fs.existsSync(authFile)) return;

  let hasDevice = false;
  try {
    hasDevice = fs.readdirSync(dataDir).some((f) => f.startsWith('device-') && f.endsWith('.json'));
  } catch {
    return;
  }
  if (hasDevice) return;

  logger?.warn?.(
    [
      'dsh-free-deepseek: 有登录态但缺少设备标识（data/device-*.json）。',
      '继续运行会让内核以「新设备」身份发请求，平台很可能判定异常并吊销整个会话。',
      '如果这是从别的目录搬过来的，把原来的 device-*.json 一起复制回来；',
      '否则请重新登录后执行 dsh token <userToken> 重新建立配套关系。',
    ].join('\n'),
  );
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

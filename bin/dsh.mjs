#!/usr/bin/env node
/**
 * dsh — DeepSeek 网页版「token 自由」工具箱
 *
 * 把上游 fuckds（chat.deepseek.com → OpenAI/Anthropic 兼容 API）封装成
 * 一键安装、可被 Codex / WorkBuddy 插件直接调用的形态。
 *
 * 用法：
 *   dsh install              安装/更新内核（克隆、装依赖、下 Chromium、写 .env）
 *   dsh token <userToken>    写入 DeepSeek 网页登录态（支持多个，空格分隔）
 *   dsh up | down | status   后台启停 / 查看状态
 *   dsh chat "问题"          直接问一句，验证链路
 *   dsh model flash|reasoner 切换默认档位（是否开深度思考）
 *   dsh mcp                  stdio MCP server（供 Codex 等 harness 调用）
 *   dsh codex                把插件注册进本机 Codex 的本地 marketplace
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-free-deepseek');
const CORE = process.env.DSH_CORE || path.join(DSH_HOME, 'fuckds');
const PORT = Number(process.env.DSH_PORT || process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const UPSTREAM = 'https://github.com/xingling66666/fuckds.git';
const MIRROR = 'https://registry.npmmirror.com';
const PW_CDN = 'https://cdn.npmmirror.com/binaries/playwright';

const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';

function log(...a) {
  console.log(...a);
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: CORE, shell: false, ...opts });
  return r.status ?? 1;
}

function runQuiet(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'ignore', cwd: CORE, shell: false, ...opts }).status === 0;
}

/* ------------------------------- 内核安装 ------------------------------- */

function cloneCore() {
  if (fs.existsSync(path.join(CORE, 'src', 'index.mjs'))) {
    log('· 内核已存在，尝试更新…');
    if (fs.existsSync(path.join(CORE, '.git'))) {
      runQuiet('git', ['-C', CORE, 'pull', '--ff-only']);
    }
    return;
  }
  fs.mkdirSync(path.dirname(CORE), { recursive: true });
  log(`· 克隆内核到 ${CORE}`);
  const r = spawnSync('git', ['clone', '--depth', '1', UPSTREAM, CORE], { stdio: 'inherit' });
  if (r.status !== 0) die('克隆失败，请检查 git 与网络');
}

function installDeps() {
  log('· 安装 Node 依赖');
  if (run(NPM, ['install', '--no-audit', '--no-fund']) !== 0) {
    log('· 官方源失败，改用国内镜像重试');
    if (run(NPM, ['install', '--no-audit', '--no-fund', '--registry', MIRROR]) !== 0) {
      die('依赖安装失败');
    }
  }
}

function installChromium() {
  log('· 检查 Playwright Chromium');
  const ok = runQuiet('npx', ['playwright', 'install', 'chromium', '--dry-run']);
  if (!ok) {
    log('· 下载 Chromium（约 130MB）');
    if (run('npx', ['playwright', 'install', 'chromium']) !== 0) {
      log('· 官方 CDN 失败，改用镜像重试');
      run('npx', ['playwright', 'install', 'chromium'], { env: { ...process.env, PLAYWRIGHT_DOWNLOAD_HOST: PW_CDN } });
    }
  }
}

function powBinary() {
  const win = path.join(CORE, 'bin', 'ds-pow.exe');
  const nix = path.join(CORE, 'bin', 'ds-pow');
  if (fs.existsSync(win)) return 'bin/ds-pow.exe';
  if (fs.existsSync(nix)) return 'bin/ds-pow';
  return null;
}

function buildPow() {
  const go = [process.env.GO_BIN, 'go', path.join(os.homedir(), '.local', 'go', 'bin', 'go')]
    .filter(Boolean)
    .find((b) => runQuiet(b, ['version']));
  if (!go) {
    log('· 未检测到 Go，跳过 PoW 求解器（将使用 browser 引擎：能用，但超长上下文无法转附件）');
    return;
  }
  log('· 编译 Go PoW 求解器（direct 引擎需要）');
  const out = path.join(CORE, 'bin', WIN ? 'ds-pow.exe' : 'ds-pow');
  fs.mkdirSync(path.join(CORE, 'bin'), { recursive: true });
  const r = spawnSync(go, ['build', '-o', out, './cmd/powd'], {
    stdio: 'inherit',
    cwd: CORE,
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  if (r.status !== 0) log('· PoW 编译失败，继续用 browser 引擎');
}

function writeEnv() {
  const envPath = path.join(CORE, '.env');
  const pow = powBinary();
  const engine = pow ? 'direct' : 'browser';

  if (fs.existsSync(envPath)) {
    log('· .env 已存在，只补齐引擎与 PoW 路径');
    setEnvKV({ ENGINE: engine, ...(pow ? { POW_BIN: pow } : {}) });
    return;
  }
  const example = path.join(CORE, '.env.example');
  let text = fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '';
  text = text.replace(/^ENGINE=.*$/m, `ENGINE=${engine}`).replace(/^PORT=.*$/m, `PORT=${PORT}`);
  // 默认让「模型别名」真正生效：flash 不思考、reasoner 思考
  text = text.replace(/^#?\s*DEEPSEEK_THINKING=.*$/m, 'DEEPSEEK_THINKING=auto');
  if (pow) text = text.replace(/^POW_BIN=.*$/m, `POW_BIN=${pow}`);
  if (!/^ENGINE=/m.test(text)) text += `\nENGINE=${engine}\n`;
  if (!/^PORT=/m.test(text)) text += `\nPORT=${PORT}\n`;
  fs.writeFileSync(envPath, text);
  log(`· 已生成 .env（ENGINE=${engine}）`);
}

function coreReady() {
  return fs.existsSync(path.join(CORE, 'src', 'index.mjs'));
}

/* --------------------------------- token -------------------------------- */

async function cmdToken(args) {
  if (!coreReady()) die('内核还没装，先执行 dsh install');
  let tokens = args.filter((a) => a && !a.startsWith('-'));
  if (!tokens.length) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log('');
    log('请粘贴 DeepSeek 网页版 userToken（浏览器 F12 → Application → Local Storage');
    log('→ https://chat.deepseek.com → userToken → 复制 value；多个用空格分隔）：');
    const answer = (await rl.question('> ')).trim();
    rl.close();
    tokens = answer.split(/[\s,;]+/).filter(Boolean);
  }
  if (!tokens.length) die('没有拿到 token');
  const code = run(process.execPath, [path.join(CORE, 'scripts', 'auth.mjs'), ...tokens]);
  if (code !== 0) die('写入登录态失败');
  log('✓ 登录态已写入。执行 dsh up 启动服务');
}

/* ------------------------------- 服务启停 ------------------------------- */

async function health(timeout = 2000) {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(timeout) });
    return await res.json();
  } catch {
    return null;
  }
}

async function cmdUp() {
  if (!coreReady()) die('内核还没装，先执行 dsh install');
  const h = await health();
  if (h?.ok) {
    log(`· 服务已在运行（pid ${h.pid}，engine=${h.engine}）`);
    return;
  }
  log('· 后台启动服务');
  run(process.execPath, [path.join(CORE, 'scripts', 'server-ctl.mjs'), 'up']);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await health();
    if (s?.ok) {
      log(`✓ 已启动 ${BASE}（engine=${s.engine}，token=${s.token ? '已就绪' : '缺失'}）`);
      if (!s.token) log('  还没有登录态：执行 dsh token <userToken>');
      return;
    }
  }
  die(`启动超时，查看日志：${path.join(CORE, 'data', 'server.log')}`);
}

function cmdDown() {
  if (!coreReady()) die('内核还没装');
  run(process.execPath, [path.join(CORE, 'scripts', 'server-ctl.mjs'), 'down']);
}

async function cmdStatus() {
  if (!coreReady()) die('内核还没装，先执行 dsh install');
  const h = await health();
  if (!h?.ok) {
    log('状态：未运行（dsh up 启动）');
    return;
  }
  log(`状态：运行中  pid=${h.pid}  运行 ${h.uptime_s}s`);
  log(`地址：${BASE}   engine=${h.engine}   token=${h.token ? '已就绪' : '缺失'}`);
  log(`并发：busy=${h.busy} queued=${h.queued} pages=${h.pages}`);
}

/* --------------------------------- chat --------------------------------- */

async function cmdChat(args) {
  const prompt = args.filter((a) => !a.startsWith('-')).join(' ') || (await readStdin());
  if (!prompt.trim()) die('用法：dsh chat "你的问题"');
  const thinking = !args.includes('--no-thinking');
  const model = args.includes('--no-thinking') ? 'deepseek-flash' : 'deepseek-reasoner';
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, thinking, stream: false, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) die(`请求失败 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  if (msg.reasoning_content) log(`[思考]\n${msg.reasoning_content}\n`);
  log(msg.content ?? '(空响应)');
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
}

/* --------------------------------- model -------------------------------- */

function setEnvKV(pairs) {
  const envPath = path.join(CORE, '.env');
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text += `\n${k}=${v}`;
  }
  fs.writeFileSync(envPath, text);
}

function cmdModel(args) {
  const which = (args[0] || 'status').toLowerCase();
  if (which === 'status') {
    const envPath = path.join(CORE, '.env');
    const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const model = /^DEFAULT_MODEL=(.*)$/m.exec(text)?.[1] || 'deepseek-flash';
    const thinking = /^DEEPSEEK_THINKING=(.*)$/m.exec(text)?.[1] || 'always';
    log(`默认模型：${model}   深度思考：${thinking}`);
    log('可选：dsh model flash（快）| dsh model reasoner（深度思考）| dsh model auto（按模型名）');
    return;
  }
  if (which === 'flash' || which === 'fast') {
    setEnvKV({ DEFAULT_MODEL: 'deepseek-flash', DEEPSEEK_THINKING: 'never' });
    log('✓ 已切到 flash 档（关闭深度思考）');
  } else if (which === 'reasoner' || which === 'think' || which === 'r1') {
    setEnvKV({ DEFAULT_MODEL: 'deepseek-reasoner', DEEPSEEK_THINKING: 'always' });
    log('✓ 已切到 reasoner 档（开启深度思考）');
  } else if (which === 'auto') {
    setEnvKV({ DEEPSEEK_THINKING: 'auto' });
    log('✓ 已切到 auto 档（按请求里的模型名决定是否深度思考）');
  } else {
    die(`未知档位：${which}`);
  }
  log('  重启生效：dsh restart');
}

/* -------------------------------- harness ------------------------------- */

/**
 * 装进 DeepSeek Harness 的 desktop profile：
 *   1. 把本包拷进 profiles/desktop/node_modules/dsh-free-deepseek
 *   2. profile 的 package.json 里登记依赖 + bundles（bundle 的 cordis.patch.yml 才会生效）
 *   3. 写内核路径到 ~/.dsh-free-deepseek/config.json，供插件托管代理进程
 * 改完需要重启 Harness。
 */
function cmdHarness() {
  const dshRoot = process.env.DSH_ROOT || path.join(os.homedir(), '.dsh');
  const profileDir = path.join(dshRoot, 'profiles', 'desktop');
  const pkgFile = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    throw new Error(`没找到 DSH profile：${pkgFile}（先打开一次 DeepSeek Harness 让它生成 profile）`);
  }

  // 先在 Harness 家目录留一份稳定的包副本：插件面板里删掉后还能从这里装回来
  const pkgHome = path.join(DSH_HOME, 'pkg');
  fs.rmSync(pkgHome, { recursive: true, force: true });
  fs.mkdirSync(pkgHome, { recursive: true });
  for (const item of ['lib', 'bin', 'plugin', 'skill', 'cordis.patch.yml', 'package.json', 'README.md']) {
    const src = path.join(REPO_ROOT, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(pkgHome, item), { recursive: true });
  }

  const dest = path.join(profileDir, 'node_modules', 'dsh-free-deepseek');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(pkgHome, dest, { recursive: true });
  log(`✓ 插件文件已就位：${dest}`);

  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  // file: 依赖让 pnpm 能从这里解析，避免「插件面板删掉后装不回来」
  const spec = `file:${pkgHome.replace(/\\/g, '/')}`;
  pkg.dependencies = { ...(pkg.dependencies || {}), 'dsh-free-deepseek': spec };
  const bundles = new Set(pkg.dsh?.profile?.bundles || []);
  bundles.add('dsh-free-deepseek');
  pkg.dsh = { ...(pkg.dsh || {}), profile: { ...(pkg.dsh?.profile || {}), bundles: [...bundles] } };
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  log(`✓ 已登记到 profile（依赖 ${spec}）`);

  fs.mkdirSync(DSH_HOME, { recursive: true });
  fs.writeFileSync(path.join(DSH_HOME, 'config.json'), `${JSON.stringify({ coreDir: CORE, port: PORT }, null, 2)}\n`);
  log(`✓ 内核路径已写入 ${path.join(DSH_HOME, 'config.json')}`);
  log('  重启 DeepSeek Harness 后，模型选择器里会出现「DeepSeek Flash / DeepSeek Reasoner」');
}

/* --------------------------------- codex -------------------------------- */

function cmdCodex() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const marketDir = path.join(DSH_HOME, 'codex-marketplace');
  const pluginDir = path.join(marketDir, 'plugins', 'dsh-free-deepseek');

  fs.mkdirSync(path.join(marketDir, '.agents', 'plugins'), { recursive: true });
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });

  const src = path.join(REPO_ROOT, 'plugin');
  fs.copyFileSync(path.join(src, 'server.mjs'), path.join(pluginDir, 'server.mjs'));
  fs.copyFileSync(path.join(src, '.codex-plugin', 'plugin.json'), path.join(pluginDir, '.codex-plugin', 'plugin.json'));
  fs.writeFileSync(
    path.join(pluginDir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          dsh_free_deepseek: {
            command: process.execPath,
            args: [path.join(pluginDir, 'server.mjs')],
            cwd: '.',
            env: { DSH_HOME, DSH_CORE: CORE, DSH_PORT: String(PORT) },
            startup_timeout_sec: 60,
            tool_timeout_sec: 600,
          },
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(marketDir, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify(
      {
        name: 'dsh-free-deepseek',
        interface: { displayName: 'DSH Free DeepSeek' },
        plugins: [
          {
            name: 'dsh-free-deepseek',
            source: { source: 'local', path: './plugins/dsh-free-deepseek' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Developer Tools',
          },
        ],
      },
      null,
      2,
    ),
  );
  log(`✓ 插件已生成：${pluginDir}`);

  const cfgPath = path.join(codexHome, 'config.toml');
  let cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  if (!cfg.includes('[marketplaces.dsh-free-deepseek]')) {
    cfg += `\n[marketplaces.dsh-free-deepseek]\nsource_type = "local"\nsource = '${marketDir}'\n`;
    fs.writeFileSync(cfgPath, cfg);
    log(`✓ 已注册到 ${cfgPath}`);
  } else {
    log('· Codex 里已注册过 marketplace');
  }
  log('  打开 Codex → 插件，搜索 dsh-free-deepseek 安装即可');
}

/* ------------------------------- workbuddy ------------------------------ */

function cmdSkill() {
  const targets = [path.join(os.homedir(), '.workbuddy-ai', 'skills'), path.join(os.homedir(), '.workbuddy', 'skills')];
  const srcSkill = path.join(REPO_ROOT, 'skill', 'dsh-free-deepseek');
  if (!fs.existsSync(srcSkill)) die(`找不到技能源目录：${srcSkill}`);
  for (const root of targets) {
    const dest = path.join(root, 'dsh-free-deepseek');
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
      fs.copyFileSync(path.join(srcSkill, 'SKILL.md'), path.join(dest, 'SKILL.md'));
      fs.copyFileSync(SELF, path.join(dest, 'scripts', 'dsh.mjs'));
      log(`✓ 技能已安装：${dest}`);
    } catch (err) {
      log(`· 跳过 ${dest}：${err.message}`);
    }
  }
  log('  重启对话后，在技能列表里搜 dsh-free-deepseek 即可');
}

/* ---------------------------------- main -------------------------------- */

const [cmd, ...rest] = process.argv.slice(2);

const HELP = `dsh — DeepSeek 网页版 token 自由工具箱

  dsh install              安装/更新内核
  dsh token <userToken>    写入网页登录态
  dsh up | down | restart  启停服务
  dsh status               查看状态
  dsh chat "问题"          直接问一句
  dsh model [flash|reasoner|auto]  切换默认档位
  dsh codex                注册到 Codex 本地插件市场
  dsh harness              装进 DeepSeek Harness（模型选择器里多出 DeepSeek）
  dsh skill                安装到 WorkBuddy 技能列表
  dsh mcp                  stdio MCP server
`;

switch (cmd) {
  case 'install': {
    cloneCore();
    installDeps();
    installChromium();
    buildPow();
    writeEnv();
    cmdCodex();
    cmdSkill();
    try {
      cmdHarness();
    } catch (err) {
      log(`· 跳过 Harness 注册：${err.message}`);
    }
    log('');
    log('✓ 安装完成。下一步：dsh token <userToken> 然后 dsh up');
    break;
  }
  case 'token':
    await cmdToken(rest);
    break;
  case 'up':
    await cmdUp();
    break;
  case 'down':
    cmdDown();
    break;
  case 'restart':
    cmdDown();
    await new Promise((r) => setTimeout(r, 800));
    await cmdUp();
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'chat':
    await cmdChat(rest);
    break;
  case 'model':
    cmdModel(rest);
    break;
  case 'codex':
    cmdCodex();
    break;
  case 'harness':
    cmdHarness();
    break;
  case 'skill':
    cmdSkill();
    break;
  case 'mcp':
    await import(path.join(REPO_ROOT, 'plugin', 'server.mjs'));
    break;
  default:
    log(HELP);
}

/**
 * 把 DeepSeek 内核打进插件包（core/），并预编译各平台的 PoW 求解器。
 *
 * 目的：换一台电脑只要「装插件 + 填一次 token」，不需要 git、不需要 clone、
 * 不需要装 Go 去编 ds-pow。
 *
 * 用法：
 *   node scripts/bundle-core.mjs <内核目录>
 *   # 默认找环境变量 DSH_FREE_DEEPSEEK_CORE，再退回 ~/.dsh-free-deepseek/fuckds
 *
 * 需要 Go 才能编二进制；只想复用已有二进制时加 --no-build。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'core');

const TARGETS = [
  ['windows', 'amd64', 'win32', 'x64'],
  ['linux', 'amd64', 'linux', 'x64'],
  ['linux', 'arm64', 'linux', 'arm64'],
  ['darwin', 'amd64', 'darwin', 'x64'],
  ['darwin', 'arm64', 'darwin', 'arm64'],
];

function findCore() {
  const candidates = [
    process.argv[2],
    process.env.DSH_FREE_DEEPSEEK_CORE,
    path.join(os.homedir(), '.dsh-free-deepseek', 'fuckds'),
    path.join(ROOT, '..', 'fuckds'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'src', 'index.mjs'))) return path.resolve(dir);
  }
  throw new Error(`找不到内核目录，试过：\n  ${candidates.join('\n  ')}`);
}

function goBinary() {
  for (const cmd of ['go', path.join(os.homedir(), 'go', 'bin', 'go'), '/usr/local/go/bin/go']) {
    try {
      execFileSync(cmd, ['version'], { stdio: 'ignore' });
      return cmd;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const core = findCore();
console.log(`内核目录：${core}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });

// 1. 运行时代码
fs.cpSync(path.join(core, 'src'), path.join(OUT, 'src'), { recursive: true });
fs.cpSync(path.join(core, 'package.json'), path.join(OUT, 'package.json'));
console.log('✓ 已复制 src 与 package.json');

// 2. PoW 求解器
const noBuild = process.argv.includes('--no-build');
const go = noBuild ? null : goBinary();

if (go) {
  for (const [goos, goarch, platform, arch] of TARGETS) {
    const ext = platform === 'win32' ? '.exe' : '';
    const file = path.join(OUT, 'bin', `ds-pow-${platform}-${arch}${ext}`);
    execFileSync(
      go,
      ['build', '-trimpath', '-ldflags=-s -w', '-o', file, '.'],
      { cwd: core, env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch }, stdio: 'inherit' },
    );
    fs.chmodSync(file, 0o755);
    console.log(`✓ ds-pow-${platform}-${arch} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  }
} else {
  // 没 Go：直接搬内核目录里已有的二进制，只保证当前平台可用
  const existing = path.join(core, 'bin');
  if (!fs.existsSync(existing)) {
    throw new Error(`没有 Go 可以编译，${existing} 里也没有现成二进制`);
  }
  for (const name of fs.readdirSync(existing)) {
    if (!name.startsWith('ds-pow')) continue;
    fs.cpSync(path.join(existing, name), path.join(OUT, 'bin', name));
    console.log(`✓ 复用已有 ${name}`);
  }
}

console.log(`\n打包完成：${OUT}`);

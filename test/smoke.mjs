#!/usr/bin/env node
/**
 * 离线自检：用桩模块模拟 DSH 宿主（@deepseek-ai/* / @earendil-works/pi-ai），
 * 验证插件能装配出 adapter、注册 provider，并且 shim 能正确转发与翻译请求。
 *
 *   node test/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-free-deepseek-test-'));
const nm = path.join(tmp, 'node_modules');

function stub(spec, file, code) {
  const dir = path.join(nm, ...spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), code);
}

stub('@deepseek-ai/dsh-llm', 'index.js', 'export const resolveRetryPolicy = (p, who) => ({ policy: p, who });');
stub(
  '@deepseek-ai/dsh-llm-pi-ai',
  'index.js',
  'export class PiAiAdapter { constructor(options) { this.options = options; } }',
);
stub('@earendil-works/pi-ai', 'index.js', 'export const createProvider = (spec) => ({ ...spec });');
stub(
  '@earendil-works/pi-ai',
  'package.json',
  JSON.stringify({
    name: '@earendil-works/pi-ai',
    version: '1.3.0',
    type: 'module',
    exports: { '.': './index.js', './api/openai-completions.lazy': './api.js' },
  }),
);
stub('@earendil-works/pi-ai', 'api.js', 'export const openAICompletionsApi = () => ({ api: "openai-completions" });');

// 把被测代码拷进临时包，保证裸导入解析到桩模块
const pkgDir = path.join(tmp, 'pkg');
fs.mkdirSync(pkgDir, { recursive: true });
fs.cpSync(path.join(ROOT, 'lib'), path.join(pkgDir, 'lib'), { recursive: true });
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-free-deepseek', type: 'module', main: 'lib/index.js' }));

// 让 core.js 认为内核存在且已就绪：起一个假内核
import { createServer } from 'node:http';
const fakeCore = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: 1, engine: 'browser', token: true }));
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echoedThinking: JSON.parse(body).thinking, gotReasoning: 'reasoning_effort' in JSON.parse(body) }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => fakeCore.listen(0, '127.0.0.1', r));
const corePort = fakeCore.address().port;

process.env.DSH_FREE_DEEPSEEK_CORE = path.join(tmp, 'core');
process.env.DSH_FREE_DEEPSEEK_PORT = String(corePort);
fs.mkdirSync(path.join(tmp, 'core', 'src'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'core', 'src', 'index.mjs'), '// fake');

const { apply, name, inject } = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href);

const calls = { adapters: [], effects: [], emitted: [] };
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  llm: {
    registerAdapter(ids, adapter) {
      calls.adapters.push({ ids, adapter });
      return () => {};
    },
  },
  effect(fn) {
    calls.effects.push(fn);
  },
  emit(evt) {
    calls.emitted.push(evt);
  },
};

await apply(ctx, {});

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (name !== 'llm-dsh-free-deepseek') fail(`插件名不对：${name}`);
if (!inject.includes('llm')) fail('inject 里缺 llm');
if (calls.adapters.length !== 1) fail(`registerAdapter 调用次数异常：${calls.adapters.length}`);
const [{ ids, adapter }] = calls.adapters;
if (ids[0] !== 'deepseek-web') fail(`provider id 不对：${ids}`);
const profile = adapter.options.profiles().get('deepseek-web');
if (!profile) fail('profiles() 里没有 deepseek-web');
if (profile.piProvider.getModels().length !== 2) fail('模型数量应为 2');
const baseUrl = profile.piProvider.getModels()[0].baseUrl;
if (!baseUrl.startsWith('http://127.0.0.1:')) fail(`baseUrl 不对：${baseUrl}`);
if (!calls.emitted.includes('llm/adapters-updated')) fail('没有 emit llm/adapters-updated');

// shim 端到端：reasoning_effort 应被翻译成 thinking，且不再透传
const shimBase = baseUrl.replace(/\/v1$/, '');
const models = await (await fetch(`${shimBase}/v1/models`)).json();
if (models.data?.[0]?.id !== 'deepseek-flash') fail('shim 转发 /v1/models 失败');

const r1 = await (await fetch(`${shimBase}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-reasoner', reasoning_effort: 'high', messages: [] }),
})).json();
if (r1.echoedThinking !== true) fail(`reasoning_effort=high 应翻成 thinking=true，实际 ${r1.echoedThinking}`);
if (r1.gotReasoning !== false) fail('reasoning_effort 不应继续透传给内核');

const r2 = await (await fetch(`${shimBase}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-flash', reasoning_effort: 'none', messages: [] }),
})).json();
if (r2.echoedThinking !== false) fail(`reasoning_effort=none 应翻成 thinking=false，实际 ${r2.echoedThinking}`);

console.log('✓ 插件装配通过：provider=deepseek-web，模型 2 个');
console.log('✓ shim 翻译通过：reasoning_effort → thinking，/v1/models 正常转发');

// 跑一遍 ctx.effect 的清理函数，确认能正常释放 shim，不留悬挂句柄
for (const register of calls.effects) {
  const dispose = register();
  if (typeof dispose === 'function') dispose();
}
fakeCore.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ 清理通过：shim 与假内核均已释放');
process.exit(0);

#!/usr/bin/env node
/**
 * dsh_free_deepseek — 本地 MCP server
 *
 * 让 Codex / Claude Desktop / Cursor 等 harness 直接调用 chat.deepseek.com
 * 网页版能力（免 API 费用），并把本地代理进程托管起来。
 *
 * 协议：MCP over stdio（newline-delimited JSON-RPC 2.0），零依赖。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CORE = process.env.DSH_CORE || path.join(DSH_HOME, 'fuckds');
const PORT = Number(process.env.DSH_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = path.join(CORE, 'data', 'server.log');

const SERVER_INFO = { name: 'dsh-free-deepseek', version: '1.0.0' };
const PROTOCOL = '2024-11-05';

/* ------------------------------ 代理进程托管 ------------------------------ */

async function health(timeout = 1500) {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(timeout) });
    return await res.json();
  } catch {
    return null;
  }
}

let starting = null;

async function ensureProxy() {
  const h = await health();
  if (h?.ok) return h;
  if (!fs.existsSync(path.join(CORE, 'src', 'index.mjs'))) {
    throw new Error(`找不到内核：${CORE}。先执行 dsh install`);
  }
  if (!starting) {
    starting = (async () => {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      const out = fs.openSync(LOG, 'a');
      const child = spawn(process.execPath, [path.join(CORE, 'src', 'index.mjs')], {
        cwd: CORE,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env },
      });
      child.unref();
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = await health();
        if (s?.ok) return s;
      }
      throw new Error(`代理启动超时，见日志 ${LOG}`);
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

/* --------------------------------- 工具实现 -------------------------------- */

async function callChat({ prompt, system, thinking, model, stream = false }) {
  if (!prompt || !prompt.trim()) throw new Error('prompt 不能为空');
  const h = await ensureProxy();
  if (!h.token) throw new Error('还没有 DeepSeek 登录态：执行 dsh token <userToken>');

  const useThinking = thinking === undefined ? model === 'deepseek-reasoner' : Boolean(thinking);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || (useThinking ? 'deepseek-reasoner' : 'deepseek-flash'),
      thinking: useThinking,
      stream: Boolean(stream),
      messages,
    }),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) throw new Error(`上游 ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    reasoning: msg.reasoning_content ?? '',
    usage: data.usage ?? null,
  };
}

function setEnvKV(pairs) {
  const envPath = path.join(CORE, '.env');
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}\n${k}=${v}`;
  }
  fs.writeFileSync(envPath, text);
}

async function callSetMode({ mode }) {
  const m = String(mode || '').toLowerCase();
  if (m === 'flash' || m === 'fast') setEnvKV({ DEFAULT_MODEL: 'deepseek-flash', DEEPSEEK_THINKING: 'never' });
  else if (m === 'reasoner' || m === 'think') setEnvKV({ DEFAULT_MODEL: 'deepseek-reasoner', DEEPSEEK_THINKING: 'always' });
  else if (m === 'auto') setEnvKV({ DEEPSEEK_THINKING: 'auto' });
  else throw new Error('mode 只能是 flash / reasoner / auto');

  // 重启让 .env 生效
  const pidFile = path.join(CORE, 'data', 'server.pid');
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) process.kill(pid, 'SIGTERM');
  } catch {
    /* 没在跑就算了 */
  }
  await new Promise((r) => setTimeout(r, 1000));
  await ensureProxy();
  return { ok: true, mode: m };
}

const TOOLS = [
  {
    name: 'deepseek_chat',
    description:
      '通过本地代理调用 DeepSeek 网页版（chat.deepseek.com）对话，无需 API Key、不消耗官方 API 额度。适合长文写作、代码解释、通用问答。thinking=true 时走深度思考（更慢但更强推理）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '用户消息' },
        system: { type: 'string', description: '可选的 system 提示词' },
        thinking: { type: 'boolean', description: '是否开启深度思考，默认按 model 推断' },
        model: { type: 'string', enum: ['deepseek-flash', 'deepseek-reasoner'], description: '模型档位' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'deepseek_status',
    description: '查看本地 DeepSeek 代理的运行状态（引擎、登录态、并发队列）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'deepseek_set_mode',
    description: '切换默认档位并重启代理：flash（快）/ reasoner（深度思考）/ auto（按请求模型名）。',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['flash', 'reasoner', 'auto'] } },
      required: ['mode'],
    },
  },
];

/* --------------------------------- JSON-RPC -------------------------------- */

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });

    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      let result;
      if (name === 'deepseek_chat') {
        const r = await callChat(args);
        const text = r.reasoning ? `【思考】\n${r.reasoning}\n\n【回答】\n${r.content}` : r.content;
        result = { content: [{ type: 'text', text: text || '(空响应)' }] };
      } else if (name === 'deepseek_status') {
        const h = await health();
        result = {
          content: [
            {
              type: 'text',
              text: h?.ok
                ? `运行中 pid=${h.pid} engine=${h.engine} token=${h.token ? '就绪' : '缺失'} busy=${h.busy} queued=${h.queued}`
                : '未运行（调用 deepseek_chat 会自动拉起）',
            },
          ],
        };
      } else if (name === 'deepseek_set_mode') {
        const r = await callSetMode(args);
        result = { content: [{ type: 'text', text: `已切到 ${r.mode} 档并重启代理` }] };
      } else {
        throw new Error(`未知工具：${name}`);
      }
      return send({ jsonrpc: '2.0', id, result });
    }

    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message || err) } });
    }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* 忽略非法行 */
    }
  }
});
process.stdin.on('end', () => process.exit(0));

// 启动即预热代理，避免第一次工具调用等太久
ensureProxy().catch(() => {});

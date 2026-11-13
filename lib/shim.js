/**
 * Loopback shim：DSH 的 pi-ai 适配器按 OpenAI Completions 协议说话，
 * 这里把它的请求翻译成内核（fuckds）能听懂的形状，再转发过去。
 *
 * 主要翻译：
 *   reasoning_effort / reasoning.effort  →  thinking: true|false
 *   （网页版没有采样参数，temperature 之类原样透传，内核会忽略）
 *
 * 顺带解决两件事：内核端口可能变（每次读配置）、API_KEY 只在 shim 里加。
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const EFFORT_OFF = new Set(['none', 'off', 'minimal', 'disabled']);

function wantsThinking(body) {
  if (typeof body.thinking === 'boolean') return body.thinking;
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.reasoning?.max_tokens !== undefined;
  if (typeof effort === 'string') return !EFFORT_OFF.has(effort.toLowerCase());
  if (body.reasoning && typeof body.reasoning === 'object') return body.reasoning.enabled !== false;
  return undefined;
}

function prepare(body) {
  const out = { ...body };
  const thinking = wantsThinking(body);
  if (thinking !== undefined) out.thinking = thinking;
  delete out.reasoning_effort;
  delete out.reasoning;
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/**
 * @param {{ resolveBase: () => string, resolveApiKey?: () => string | undefined }} options
 * @returns {Promise<{ baseUrl: string, close: () => void }>}
 */
export function startShim(options) {
  const { resolveBase, resolveApiKey } = options;

  const server = createServer(async (req, res) => {
    try {
      const base = resolveBase();
      const url = new URL(req.url, base);

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        const upstream = await fetch(`${base}${url.pathname.replace(/^\/models/, '/v1/models')}`, {
          headers: headers(resolveApiKey),
          signal: AbortSignal.timeout(15000),
        });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(await upstream.text());
        return;
      }

      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        const body = prepare(await readBody(req));
        const upstream = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: headers(resolveApiKey),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240000),
        });

        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (!upstream.body) {
          res.end(await upstream.text());
          return;
        }
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }

      if (url.pathname === '/healthz') {
        const h = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
        res.writeHead(h.status, { 'Content-Type': 'application/json' });
        res.end(await h.text());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `shim: 未处理 ${req.method} ${url.pathname}` } }));
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

function headers(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  const key = apiKey?.();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

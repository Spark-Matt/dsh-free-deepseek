/**
 * dsh-free-deepseek — DeepSeek Harness 宿主侧插件
 *
 * 把「本地 fuckds 代理（chat.deepseek.com 网页版）」注册成 DSH 的一个模型
 * 提供方，于是模型选择器里会多出 DeepSeek Flash / DeepSeek Reasoner，
 * 选中即用，不消耗官方 API 额度。
 *
 * 结构对齐 dsh-workbuddy-connect：loopback shim + PiAiAdapter 手工装配。
 */
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import { ensureCore, readConfig } from './core.js';
import { startShim } from './shim.js';

/** Cordis 插件名（与 cordis.patch.yml 里的 id 对应）。 */
export const name = 'llm-dsh-free-deepseek';

/** 注册 provider 前必须先有模型注册表。 */
export const inject = ['llm'];

const PROVIDER = 'deepseek-web';
const DISPLAY_NAME = 'DeepSeek 网页版（免费）';
const STREAM_IDLE_TIMEOUT_MS = 3e5;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

/** 网页版其实只有一个模型，这里的两个 id 只是「默认是否深度思考」的偏好。 */
const MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash（快）',
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner（深度思考）',
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 8192,
  },
];

const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-free-deepseek: 本地代理没有 pi-ai 凭据生命周期');
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/**
 * 网页版只有「深度思考开/关」两态，所以这里把 DSH 的档位映射成
 * off → 关思考；low/medium/high/max → 开思考（强度由网页版自己决定）。
 * shim 只认 off/none/minimal/disabled 为关闭，其余一律开。
 */
function reasoningFields(model) {
  if (!model.reasoning) return { reasoning: false };
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: 'off',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  };
}

function toPiModel(model, baseUrl) {
  return {
    id: model.id,
    name: model.name,
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl,
    input: ['text'],
    ...reasoningFields(model),
    cost: NO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  };
}

function buildAdapter(baseUrl) {
  const buildModels = () => MODELS.map((m) => toPiModel(m, baseUrl));

  const provider = {
    ...createProvider({
      id: PROVIDER,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'dsh-free-deepseek local proxy',
          async resolve() {
            return { auth: { apiKey: 'local' }, source: 'dsh-free-deepseek' };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-free-deepseek retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  return new PiAiAdapter({
    profiles: () => new Map([[PROVIDER, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => 'local',
  });
}

/**
 * @param {import('cordis').Context} ctx
 * @param {{ port?: number }} [config]
 */
export async function apply(ctx, config = {}) {
  // 整个装配过程兜底：插件失败只能少一个模型提供方，绝不能拖垮 Harness 启动。
  try {
    await register(ctx, config);
  } catch (err) {
    ctx.logger?.error?.(`dsh-free-deepseek: 注册模型提供方失败：${err?.stack || err}`);
  }
}

async function register(ctx, config) {
  const cfg = readConfig();
  const port = Number(config.port || cfg.port);

  let status;
  try {
    status = await ensureCore({ logger: ctx.logger, port, coreDir: cfg.coreDir });
  } catch (err) {
    ctx.logger?.warn?.(`dsh-free-deepseek: ${err.message}`);
  }
  if (status && status.token === false) {
    ctx.logger?.warn?.('dsh-free-deepseek: 还没有 DeepSeek 网页登录态，执行 dsh token <userToken>');
  }

  const shim = await startShim({
    resolveBase: () => `http://127.0.0.1:${port}`,
    resolveApiKey: () => undefined,
  });

  const adapter = buildAdapter(`${shim.baseUrl}/v1`);
  const release = ctx.llm.registerAdapter([PROVIDER], adapter);

  try {
    ctx.effect(() => () => {
      release();
      shim.close();
    });
  } catch {
    release();
    shim.close();
  }

  ctx.emit('llm/adapters-updated');
  ctx.logger?.info?.(`dsh-free-deepseek: 已注册模型提供方 ${PROVIDER}（shim ${shim.baseUrl} → 内核 :${port}）`);
}

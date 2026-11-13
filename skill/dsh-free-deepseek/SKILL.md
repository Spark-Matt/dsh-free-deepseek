---
name: dsh-free-deepseek
description: 免 API Key 使用 DeepSeek（chat.deepseek.com 网页版）。当用户想免费调用 DeepSeek、安装/更新/启停本地 DeepSeek 代理、把 DeepSeek 接进 Codex 或其它 harness、切换「深度思考」档位、排查限流 429 或登录态失效时使用本技能。
agent_created: true
---

# dsh-free-deepseek

把 `chat.deepseek.com` 网页版封装成本地 OpenAI / Anthropic 兼容 API，从而免 API Key、免官方 API 额度地使用 DeepSeek。内核是上游开源项目 `fuckds`（AGPLv3），本技能负责一键安装、托管与档位切换。

## 何时使用

- 用户说「想免费用 DeepSeek」「token 自由」「接入 DeepSeek 网页版」
- 需要在 Codex / Claude Code / Cursor 里用 DeepSeek，但不想买 API 额度
- 代理起不来、返回 401/429、登录态失效需要排查
- 想在 flash（快）与 reasoner（深度思考）之间切换

## 核心命令

统一入口 `scripts/dsh.mjs`（Node ≥ 20）：

```bash
node scripts/dsh.mjs install              # 首次安装：克隆内核 + 装依赖 + Chromium + 写 .env + 注册 Codex 插件
node scripts/dsh.mjs token <userToken>    # 写入网页登录态（多个 token 空格分隔，组成号池）
node scripts/dsh.mjs up                   # 后台启动（默认 http://127.0.0.1:8787）
node scripts/dsh.mjs status               # 运行状态 / 引擎 / 登录态
node scripts/dsh.mjs chat "用一句话解释 QUIC"   # 端到端验证
node scripts/dsh.mjs model reasoner       # 切档位：flash | reasoner | auto
node scripts/dsh.mjs restart              # 改完 .env 后重启生效
node scripts/dsh.mjs down                 # 停止
```

## 取 userToken（唯一需要用户手动做的一步）

1. 浏览器登录 https://chat.deepseek.com
2. F12 → Application → Local Storage → `https://chat.deepseek.com` → `userToken` → 复制 `value`
3. 或在该页 Console 执行：`copy(JSON.parse(localStorage.getItem("userToken")).value)`

拿到后执行 `dsh token '<粘贴>'`。**不要**在网页上点「退出账号」切换账号，会吊销旧 token。

## 模型与档位

网页版只有一个模型，模型名只是别名，真正影响输出的是「深度思考」开关：

| 请求里的 model | 深度思考 | 说明 |
|---|---|---|
| `deepseek-flash` / `deepseek-v3` / `deepseek-web` | 关 | 快，日常问答 |
| `deepseek-reasoner` / `deepseek-r1` | 开 | 慢但推理强 |

优先级：请求体 `thinking: false/true` > `.env` 的 `DEEPSEEK_THINKING=always|never` > 模型别名。
Anthropic 协议用 `thinking: {type: "enabled"|"disabled"}`。
`temperature` / `top_p` / `max_tokens` 网页版不支持，传了也不生效。

## 接入方式

- **Codex**：`dsh codex` 注册本地 marketplace，之后在 Codex 插件面板安装 `dsh-free-deepseek`，会得到 `deepseek_chat` / `deepseek_status` / `deepseek_set_mode` 三个工具。
- **任意 OpenAI SDK**：`base_url = http://127.0.0.1:8787/v1`，`api_key` 随便填（除非设置了 `API_KEY`）。
- **Claude Code / Anthropic SDK**：`base_url = http://127.0.0.1:8787`。

## 排错

- `token=false`：登录态没写入，重跑 `dsh token`
- 429 / 命中限流：网页版单账号约连续 3~4 条后冷却约 1 分钟；加号池（`dsh token t1 t2 t3`）可缓解
- 启动超时：看 `~/.dsh/fuckds/data/server.log`
- 没有 Go 工具链时自动走 browser 引擎（Playwright），可用但每轮慢 1 秒左右；装了 Go 后跑 `dsh install` 会编译 `bin/ds-pow` 切到 direct 引擎

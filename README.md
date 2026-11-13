# dsh-free-deepseek

> 免 API Key 用 DeepSeek。把 `chat.deepseek.com` 网页版注册成 **DeepSeek Harness** 的模型提供方：装完插件，模型选择器里直接出现 DeepSeek Flash / DeepSeek Reasoner，选中即用。

一句话原理：登录你自己的 DeepSeek 网页账号 → 本地起一个代理 → 任何支持 OpenAI / Claude SDK 的工具把 `base_url` 指过来，就相当于用网页版额度跑 agent。

**插件自带内核**：DeepSeek 代理的完整源码 + 五个平台（Windows / Linux / macOS，x64 与 arm64）预编译好的 PoW 求解器都打在包里。所以换一台电脑只需要两步——**装插件、填一次 token**，不用装 git、不用 clone 仓库、不用装 Go 去编二进制。

内核基于开源项目 [fuckds](https://github.com/xingling66666/fuckds)（AGPLv3），本项目做的是**打包、托管与 harness 接入**。

---

## 快速开始

在 DeepSeek Harness 里：**设置 → 插件 → 添加插件 → 输入 `dsh-free-deepseek` → 安装**。

然后写一次登录态（唯一需要手动的一步）：

```bash
npx dsh-free-deepseek token '<你的 userToken>'
```

重启 Harness，模型选择器里就会出现 DeepSeek Flash / DeepSeek Reasoner。

插件第一次运行时会把自带内核铺到 `~/.dsh-free-deepseek/fuckds`、按当前平台挑好 PoW 求解器、生成 `.env`，并以 detached 方式把代理拉起来常驻。服务地址 `http://127.0.0.1:8787`。

想用命令行直接跑整套（不走 Harness 也行）：

```bash
npx -y dsh-free-deepseek install   # 铺内核 + 写配置 + 注册 Harness 插件
dsh token '<你的 userToken>'
dsh up && dsh status
dsh chat "用一句话解释什么是 QUIC"
```

### 怎么拿 userToken

1. 浏览器登录 <https://chat.deepseek.com>
2. `F12` → **Application** → **Local Storage** → `https://chat.deepseek.com` → `userToken` → 复制 `value`
3. 或者在该页 Console 里执行：

```js
copy(JSON.parse(localStorage.getItem("userToken")).value)
```

> 切小号时**不要**点网页上的「退出账号」，会吊销旧 token；应清 localStorage + cookies。多账号可以一次写多个，组成号池自动轮询：
> `dsh token t1 t2 t3`

### 换一台电脑要做什么

| 步骤 | 做什么 | 是否需要手动 |
| --- | --- | --- |
| 1 | 装插件（Harness 面板输包名，或给本地目录路径） | 手动 |
| 2 | 写一次 userToken | 手动（登录态是你个人的，无法预置） |
| 3 | 铺内核、选 PoW 二进制、生成 .env、拉起代理 | **全自动** |

不需要：git、Go 工具链、Chromium / playwright（除非你要用浏览器引擎而不是直连）。

---

## 模型与档位（能不能自己调）

**能。** 网页版其实只有一个模型，请求里的 `model` 只是别名，真正决定输出质量/速度的是「深度思考」开关：

| 请求里的 `model` | 深度思考 | 适用 |
|---|---|---|
| `deepseek-flash` / `deepseek-v3` / `deepseek-web` | 关 | 快，日常问答、批量改写 |
| `deepseek-reasoner` / `deepseek-r1` | 开 | 慢一些，推理/数学/复杂代码 |

优先级：**单次请求参数** > `.env` 全局默认 > 模型别名推断。

```bash
dsh model flash      # 全局默认关思考（最快）
dsh model reasoner   # 全局默认开思考
dsh model auto       # 按每次请求的模型名决定
dsh restart          # 改完重启生效
```

单次请求覆盖：

```json
{ "model": "deepseek-flash", "thinking": true, "messages": [...] }
```

> `temperature` / `top_p` / `max_tokens` / `stop` 网页版不支持，传了不生效（不报错）。

---

## 三种接入方式

### 1. DeepSeek Harness 插件（dsh）

```bash
dsh harness
```

把本包装进 Harness 的 `desktop` profile：`~/.dsh/profiles/desktop/node_modules/dsh-free-deepseek`，并在 profile 的 `package.json` 里登记依赖与 bundle。**重启 Harness** 后，模型选择器里会多出：

| 模型 | 说明 |
|---|---|
| `deepseek-flash`（快） | 日常问答，默认不深度思考 |
| `deepseek-reasoner`（深度思考） | 推理/数学/复杂代码 |

两个模型**都支持档位选择**：`off / minimal / low / medium / high / max`。`off` 关掉深度思考（最快），其余档位开思考（网页版只有开/关两态，强度由它自己决定，档位只是「开」的不同写法）。

插件结构对齐官方 `dsh-workbuddy-connect`：宿主侧 `apply()` 用 `ctx.llm.registerAdapter(['deepseek-web'], adapter)` 注册 provider，内部起一个 loopback shim 把 Harness 的 `reasoning_effort` 翻译成本地内核的 `thinking` 布尔值。插件还会自动托管内核进程，Harness 启动时内核没跑就拉起来。

**它还会检查 `pwsh`（PowerShell 7）**：Harness 的 shell 工具直接调 `pwsh`，而 Windows 只自带 5.1。缺了就会「只能聊天不能干活」（子进程起不来，`0xC0000142`）。插件启动时自动发现并把它的目录注入 `PATH`，缺了会提示你跑：

```bash
dsh pwsh     # 用 winget 装一份 PowerShell 7
```

> 想在 Harness 的插件面板里「输入名字安装」，需要先把包发到 npm：`npm publish`（见文末）。

### 2. Codex 插件

```bash
dsh codex
```

会在 `~/.dsh-free-deepseek/codex-marketplace` 生成一个本地插件市场并写进 `~/.codex/config.toml`。之后打开 **Codex → 插件**，搜 `dsh-free-deepseek` 安装，得到三个工具：

| 工具 | 作用 |
|---|---|
| `deepseek_chat` | 走本地代理问 DeepSeek（可开深度思考） |
| `deepseek_status` | 代理状态、登录态、队列 |
| `deepseek_set_mode` | 切换 flash / reasoner / auto 并自动重启 |

插件会自动拉起代理进程，第一次调用稍慢（约 3~20 秒），之后秒回。

### 3. OpenAI SDK / 任意兼容客户端

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="any")

for chunk in client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "写一个快排"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

### 3. Claude Code / Anthropic SDK

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=any
```

支持 `/v1/messages`、流式、`tools`、`thinking` 块、`count_tokens`。

---

## 命令一览

| 命令 | 说明 |
|---|---|
| `dsh install` | 安装/更新内核 + 注册 Codex 插件 + 装 WorkBuddy 技能 + 装 Harness 插件 |
| `dsh token <t...>` | 写入网页登录态（支持号池） |
| `dsh up` / `down` / `restart` | 后台启停 |
| `dsh status` | 状态：引擎、登录态、并发 |
| `dsh chat "..."` | 端到端验证，`--no-thinking` 关思考 |
| `dsh model [flash\|reasoner\|auto]` | 切换档位 |
| `dsh harness` | 只装 DeepSeek Harness 插件 |
| `dsh codex` | 只注册 Codex 插件 |
| `dsh skill` | 只安装 WorkBuddy 技能 |
| `dsh mcp` | 直接跑 stdio MCP server |

环境变量：`DSH_HOME`（默认 `~/.dsh-free-deepseek`）、`DSH_PORT`（默认 8787）、`DSH_CORE`（指定已有内核目录）、`DSH_ROOT`（Harness 家目录，默认 `~/.dsh`）。

自检：`node test/smoke.mjs`（用桩模块模拟 Harness 宿主，验证 provider 装配与 shim 翻译，不需要真跑 Harness）。

---

## 两种引擎

| 引擎 | 原理 | 单轮耗时 | 依赖 |
|---|---|---|---|
| `browser`（默认，开箱即用） | Playwright 驱动真实网页 | ~2.2–2.9s | Chromium |
| `direct` | 直连网页内部接口 + Go 解 PoW | ~1.2–1.9s | Go ≥ 1.21 |

装了 Go 后重跑 `dsh install` 会自动编译 `bin/ds-pow`，把 `ENGINE` 改成 `direct` 再 `dsh restart` 即可提速。图片输入也只有 direct 引擎支持。

---

## 已知限制

- **限流**：网页版按账号限流，约连续 3~4 条后冷却 1 分钟左右。号池可缓解。
- **无状态上下文**：每条请求都把历史按 `## System` / `## User` / `## Assistant` 段落拼成一条新 prompt 发出，所以超长对话会变慢、且模型不记得「对话 ID」。
- **不是官方 API**：逆向网页接口，账号风控/封禁风险自担；仅供个人学习研究，请勿商用或对外提供服务。
- 采样参数无效（见上）。
- 输出与网页版一致，受网页版本身的策略限制。

---

## 目录结构

```
lib/index.js                   # DSH 宿主插件：注册 provider + 托管内核
lib/shim.js                    # loopback shim：reasoning_effort → thinking
lib/core.js                    # 内核托管：自带内核自动铺开 + 健康检查 + 拉起进程
lib/pwsh.js                    # 发现并注入 PowerShell 7（AppX 别名也能认）
cordis.patch.yml               # DSH bundle 补丁（insert llm-deepseek-web）
bin/dsh.mjs                    # 统一 CLI（安装/启停/档位/接入）
scripts/bundle-core.mjs        # 把内核与五平台 PoW 二进制打进 core/（发布前跑）
core/                          # 构建产物（git 忽略，npm 包内自带）
  src/                         # DeepSeek 代理完整源码
  bin/ds-pow-<平台>-<架构>      # 预编译 PoW 求解器，五个平台
plugin/                        # Codex 插件（MCP server）
  .codex-plugin/plugin.json
  .mcp.json
  server.mjs                   # 零依赖 stdio MCP server
skill/dsh-free-deepseek/
  SKILL.md                     # WorkBuddy 技能描述
test/smoke.mjs                 # 离线自检（桩宿主 + 假内核）
```

---

## 发布到 npm（让 Harness 插件面板能搜到）

```bash
node scripts/bundle-core.mjs ../fuckds   # 先把内核与 PoW 二进制打进 core/
npm login
npm publish
```

发布后，在 DeepSeek Harness 的插件面板里直接输入 `dsh-free-deepseek` 就能安装，无需本地 `dsh harness`。

没有 npm 账号时，面板的「添加插件」也支持**本地目录路径**，填 `~/.dsh-free-deepseek/pkg` 效果一样。

---

## 许可

本项目代码遵循 **AGPL-3.0**，与上游 `fuckds` 保持一致。使用本项目产生的任何账号风险由使用者自行承担，作者不对封号、数据丢失等后果负责。

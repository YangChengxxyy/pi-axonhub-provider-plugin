# pi-axonhub-provider-plugin

[Pi coding agent](https://github.com/badlogic/pi-mono) 扩展，将 [AxonHub](https://github.com/looplj/axonhub) 网关注册为模型 provider。是 [opencode-axonhub-provider-plugin](../opencode-axonhub-provider-plugin) 的 Pi 移植版。

- 自动获取模型列表：`GET {baseURL}/v1/models`（动态 provider：Pi 自动缓存/离线恢复，并按自身的模型目录刷新机制更新）
- API key 通过 `/login axonhub` 交互输入并持久化（存于 `~/.pi/agent/auth.json`），也支持 `AXONHUB_API_KEY` 环境变量兜底（已存储的 key 优先）
- 价格 / 上下文上限 / 推理能力元数据：从 [models.dev](https://models.dev/) 自动匹配（厂商官方价，或 ZenMux 网关价），无需手工配置
- 推理模型自动标记 `reasoning: true`，可直接用 Pi 的思考强度选择器
- 支持 openai / anthropic 两种协议

## 使用

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `AXONHUB_BASE_URL` | AxonHub 根地址 | `https://llm.cccloud.xin` |
| `AXONHUB_API_KEY` | AxonHub API key（环境变量兜底，推荐用 `/login`） | — |
| `AXONHUB_PROTOCOL` | `openai` 或 `anthropic` | `openai` |
| `AXONHUB_PRICING` | `canonical` \| `zenmux` \| `none` | `canonical` |

安装（任选其一）：

```sh
# 1) 作为 Pi 扩展目录安装
ln -s /path/to/pi-axonhub-provider-plugin ~/.pi/agent/extensions/axonhub

# 2) 开发时直接加载
pi -e /path/to/pi-axonhub-provider-plugin
```

配置 API key（任选其一）：

```sh
# 方式一：Pi 内交互输入（持久化，推荐）
# 启动 pi 后执行 /login，选择 axonhub（anthropic 协议下为 axonhub-anthropic）

# 方式二：环境变量
AXONHUB_API_KEY=ah-... pi
```

启动后用 `/model` 选择 `axonhub/<model>`（或 `axonhub-anthropic/<model>`）。

## 协议说明

- `openai`：注册 provider `axonhub`，`baseUrl = {baseURL}/v1`，走 OpenAI Chat Completions，思考强度映射为 `reasoning_effort`
- `anthropic`：注册 provider `axonhub-anthropic`，`baseUrl = {baseURL}/anthropic`（最终请求 `{baseURL}/anthropic/v1/messages`），思考强度走 Anthropic `thinking`

价格与元数据：启动时抓取 `https://models.dev/api.json`，按模型 ID 匹配（大小写、`4.5`/`4-5` 版本风格归一化，支持 `vendor/model` 前缀）。`AXONHUB_PRICING=canonical` 优先取厂商官方数据（anthropic/openai/zai/deepseek/minimax/moonshotai/xai/stepfun/xiaomi），`zenmux` 优先取 ZenMux 网关价。匹配不到的模型回退 ID 启发式（价格留空）。注意：这是上游公开牌价，若你的 AxonHub 渠道有折扣/加价，以 AxonHub 后台实际计费为准。

## 开发

```sh
npm install
npm run typecheck
```

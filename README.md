# pi-weixin-cli

微信消息桥接工具 — 将微信消息与 [Pi Agent](https://github.com/earendil-works/pi-coding-agent) 双向连通。

pi-weixin-cli 是一个**独立可执行程序**，通过 spawn `pi --mode rpc` 子进程并使用 JSONL stdin/stdout 协议与 Pi 通信。你在微信中发送的消息会转发给 Pi，Pi 的回复自动发送回微信。

## 系统要求

- Node.js >= 18
- Pi Agent（已安装并在 PATH 中，`which pi` 可找到）
- 一个微信机器人账号（通过 QQ 邮箱注册的微信机器人平台账号）

## 安装

### 方式一：npm link（推荐，一次安装全局使用）

```bash
cd ~/.pi/agent/extensions/pi-weixin-cli
npm install
npm run build
npm link
```

安装后即可在任何目录直接使用 `pi-weixin-cli` 命令：

```bash
pi-weixin-cli --help
pi-weixin-cli login
pi-weixin-cli status
pi-weixin-cli          # 启动 daemon
```

### 方式二：npx（无需安装，每次编译后执行）

```bash
cd ~/.pi/agent/extensions/pi-weixin-cli
npm install
npm run build

# 通过 npx 运行
npx pi-weixin-cli login
npx pi-weixin-cli status
npx pi-weixin-cli      # 启动 daemon
```

### 方式三：本地直接执行

```bash
cd ~/.pi/agent/extensions/pi-weixin-cli
npm install
npm run build

./dist/main.js login
./dist/main.js
```

## 快速开始

```bash
# 1. 登录微信机器人账号（终端显示二维码，用微信扫码确认）
pi-weixin-cli login

# 2. 启动 daemon 模式（后台消息轮询 + Pi RPC 通信）
pi-weixin-cli

# 或者显式启动：
pi-weixin-cli daemon
```

启动后，脚本会自动 spawn `pi --mode rpc` 子进程，并通过 JSONL 协议维持通信。当有微信消息到达时转发给 Pi，Pi 的回复自动发送回微信。

### 升级/重新安装

```bash
cd ~/.pi/agent/extensions/pi-weixin-cli
git pull              # 更新代码
npm install           # 更新依赖
npm run build         # 重新编译
npm link              # 更新全局链接
```

## 架构

```
微信 App
    │
    ▼
Weixin Backend (ilinkai.weixin.qq.com)
    │  ▲
    │  │  HTTP JSON API (getUpdates / sendMessage)
    ▼  │
┌──────────────────────────────────────────┐
│  pi-weixin-cli（独立 Node.js 进程）       │
│                                          │
│  ┌──────────┐   ┌─────────────────────┐ │
│  │ Poller   │   │ RPC Client          │ │
│  │(long-    │   │ (JSONL stdin/stdout)│ │
│  │ poll)    │   │                     │ │
│  └────┬─────┘   └──────────┬──────────┘ │
│       │                    │            │
│       ▼                    ▼            │
│  ┌────────────┐   ┌──────────────────┐  │
│  │ WeixinApi  │   │ StateMachine     │  │
│  │(HTTP       │   │ + UIBridge       │  │
│  │ client)    │   │ (交互桥接)        │  │
│  └────────────┘   └──────────────────┘  │
└──────────────────────┬───────────────────┘
                       │ spawn + JSONL
                       ▼
                Pi --mode rpc
```

### 数据流

1. **消息接收**：Poller 使用 HTTP long-poll 轮询 Weixin Backend 的 `getUpdates` 接口
2. **消息注入**：收到文本消息后，通过 RPC Client 以 `prompt` 命令发送给 Pi
3. **回复发送**：监听 Pi 的 `agent_end` 事件，提取 assistant 文本内容，通过 `sendMessage` 接口发送回微信
4. **交互桥接**：Pi 的 `ask_user`、`confirm`、`select`、`input` 等交互请求通过 `extension_ui_request` 事件桥接到微信（见下方「交互支持」）
5. **重连机制**：Pi 子进程意外退出时，自动以指数退避策略重连（最多 10 次，基础延迟 2s，最大 60s）

## CLI 命令参考

| 命令 | 说明 |
|------|------|
| `pi-weixin-cli` | 启动 daemon 模式（默认） |
| `pi-weixin-cli daemon` | 同上的显式写法 |
| `pi-weixin-cli login` | 扫描二维码登录微信机器人账号 |
| `pi-weixin-cli logout [id]` | 登出指定账号；不指定 id 时列出所有账号 |
| `pi-weixin-cli logout --all` | 删除所有已登录账号 |
| `pi-weixin-cli status` | 显示所有已保存账号的信息 |
| `pi-weixin-cli toggle` | 启用/禁用消息接收 |
| `pi-weixin-cli config show` | 显示当前配置 |
| `pi-weixin-cli config toggle` | 切换提示功能（启用/禁用） |
| `pi-weixin-cli config interval N` | 设置提示间隔（每 N 条消息附加一次提示） |
| `pi-weixin-cli config message <文本>` | 设置附加提示的文本内容 |
| `pi-weixin-cli config reset` | 恢复默认配置 |
| `pi-weixin-cli --help` | 显示帮助信息 |

## 微信内斜线命令

在发给 Pi 的消息中，可以输入斜线命令：

| 命令 | 说明 |
|------|------|
| `/new` | 新建 Pi session |
| `/compact` | 压缩上下文 |
| `/abort` | 中止当前 agent 运行 |
| `/session` | 显示当前 session 状态 |
| `/model` | 切换模型（回复编号选择） |
| `/help` | 显示可用命令列表 |

## 交互支持（UI Bridge）

pi-weixin-cli 支持将 Pi 的终端交互操作桥接到微信：

| Pi 交互方法 | 在微信中的表现 | 用户如何响应 |
|-------------|---------------|-------------|
| `ask_user` | 显示问题和等待回复提示 | 直接在微信中回复文本 |
| `confirm` | 显示确认信息和选项编号 | 回复数字选择 |
| `select` | 显示选项列表（编号） | 回复数字选择 |
| `input` | 显示输入提示 | 直接在微信中回复文本 |
| `editor` | 显示编辑器提示 | 直接在微信中回复文本 |
| `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` | 通知类消息，直接显示 | 无需响应（fire-and-forget） |

> **注意**：交互请求有超时机制。如果用户在超时时间内未回复，Pi 将收到 `cancelled` 信号。

### 图片消息支持

pi-weixin-cli 支持接收微信图片并转发给 Pi：
- 微信图片会随文字消息一起通过 Pi RPC 的 `images` 字段发送
- 支持 CDN 下载和自动解密（如果图片加密）
- 纯图片消息也会被处理，不依赖文字内容

## 配置

配置文件位于 `~/.pi/agent/extensions/pi-weixin-cli/settings.json`：

```json
{
  "enabled": true,
  "hintInterval": 3,
  "hintMessage": "[系统提示] 当前用户通过微信与 Pi 交互...",
  "hintsEnabled": true
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | daemon 启动时是否启用消息接收 |
| `hintsEnabled` | boolean | `true` | 是否启用提示功能 |
| `hintInterval` | number | `3` | 每 N 条消息附加一次提示文本 |
| `hintMessage` | string | （系统提示） | 附加的提示文本内容 |

所有配置项都可通过 `config` 命令动态修改，无需重启 daemon（下次启动时生效）。

## 数据目录

所有持久化数据保存在 `~/.pi/agent/extensions/pi-weixin-cli/state/`：

| 文件 | 说明 |
|------|------|
| `accounts.json` | 已登录的微信机器人账号（botToken, userId, baseUrl） |
| `context-tokens.json` | 每个用户的 sync context token（用于 getUpdates 游标） |

## 限制（当前版本）

- **仅文本和图片**：语音、视频、文件消息会被接收但内容不处理（静默跳过）
- **纯文本回复**：Pi 的回复以纯文本发送，不支持 Markdown 渲染或富文本
- **单会话处理**：消息按 FIFO 顺序逐条处理，Pi 同一时间只处理一条微信消息
- **无会话隔离**：所有微信消息注入同一个 Pi RPC 会话，不同微信用户共享 Pi 上下文
- **需要常驻终端**：daemon 模式在前台运行（非 systemd service），关闭终端即停止

## 卸载

```bash
# 移除全局链接
npm uninstall -g pi-weixin-cli

# 删除项目文件
rm -rf ~/.pi/agent/extensions/pi-weixin-cli
```

## License

MIT

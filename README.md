# pi-weixin-cli

微信消息桥接工具 — 将微信消息与 [Pi Agent](https://github.com/earendil-works/pi-coding-agent) 双向连通。

pi-weixin-cli 是一个**独立可执行程序**，通过 spawn `pi --mode rpc` 子进程并使用 JSONL stdin/stdout 协议与 Pi 通信。你在微信中发送的消息会转发给 Pi，Pi 的回复自动发送回微信。

## 系统要求

- Node.js >= 18
- Pi Agent（已安装并在 PATH 中，`which pi` 可找到）

## 安装

### 方式一：npm 全局安装（推荐，最简单）

```bash
npm install -g pi-weixin-cli
```

安装后即可在任何目录直接使用：

```bash
pi-weixin-cli --help
pi-weixin-cli login
pi-weixin-cli status
pi-weixin-cli          # 启动 daemon
```

升级：
```bash
npm update -g pi-weixin-cli
```

### 方式二：从源码安装（开发或自定义）

```bash
git clone https://github.com/Guanzhw/pi-weixin-cli.git
cd pi-weixin-cli
npm install
npm run build
npm link
```

### 方式三：npx 直接运行（无需安装）

```bash
npx pi-weixin-cli login
npx pi-weixin-cli status
npx pi-weixin-cli      # 启动 daemon
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

### 升级

**从 npm 全局安装：**
```bash
npm update -g pi-weixin-cli
```

**从源码安装：**
```bash
cd pi-weixin-cli
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
| `pi-weixin-cli config reset` | 恢复默认配置 |
| `pi-weixin-cli --help` | 显示帮助信息 |

## 微信内斜线命令

在发给 Pi 的消息中，可以输入斜线命令：

| 命令 | 说明 |
|------|------|
| `/new` | 新建 Pi session |
| `/compact [instructions]` | 压缩上下文（可附加压缩说明） |
| `/abort` | 中止当前 agent 运行 |
| `/session` | 显示当前 session 状态（模型、token 等） |
| `/messages` | 查看最近 20 条对话消息 |
| `/export [path]` | 导出 session 为 HTML |
| `/model` | 切换模型（回复编号选择） |
| `/cycle-model` | 轮播到下一个可用模型 |
| `/thinking [level]` | 设置（off/minimal/low/medium/high/xhigh）或轮播 thinking level |
| `/steer-mode <mode>` | 设置 steering 消息队列模式（all / one-at-a-time） |
| `/follow-mode <mode>` | 设置 follow-up 消息队列模式（all / one-at-a-time） |
| `/auto-compact <on|off>` | 自动压缩开关 |
| `/auto-retry <on|off>` | 自动重试开关 |
| `/abort-retry` | 中止当前重试 |
| `/clone` | 克隆当前 session |
| `/fork` | 从历史消息 fork（回复编号选择） |
| `/last` | 查看最后一条 assistant 回复 |
| `/name <name>` | 设置 session 显示名称 |
| `/resume` | 恢复历史 session（回复编号选择） |
| `/help` | 显示可用命令列表 |

> **通用转发**：Pi 扩展命令（如 `/skill:xxx`、prompt template）无需在 pi-weixin-cli 中注册，直接发送即可自动转发给 Pi 处理。

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
- 微信图片下载后保存到 `~/.config/pi-weixin-cli/images/`
- 在 prompt 中告知 Pi 图片的本地文件路径，Pi 可自行用 `read` 或 vision 工具处理
- 支持 WeChat CDN 加密图片的自动解密（AES-128-ECB）
- 纯图片消息也会被处理，不依赖文字内容

示例：用户发送一张图片，Pi 收到的消息为：

```
用户消息...

[用户发送了一张图片]
🖼️ /home/qq110/.config/pi-weixin-cli/images/2026-05-27_17-15-40_2oud9v.jpeg
```

### 文件传输支持

pi-weixin-cli 支持接收微信文件并转发给 Pi：

- 文件自动下载并保存到 `~/.config/pi-weixin-cli/files/`
- 在 prompt 中告知 Pi 文件路径，Pi 可自行用 `read` 或 `bash` 工具处理
- 支持任意文件类型（文本、PDF、压缩包、可执行文件等），无大小限制

示例：用户发送 `report.pdf`，Pi 收到的消息为：

```
用户消息...

[用户发送了一个文件：report.pdf]
📄 /home/qq110/.config/pi-weixin-cli/files/2026-05-27_20-12-34_report.pdf
```

### 语音消息支持

pi-weixin-cli 支持接收微信语音消息：
- 微信会自动将语音转写为文字
- pi-weixin-cli 提取转写后的文本内容发送给 Pi
- 语音文件保存到 `~/.config/pi-weixin-cli/voices/`
- 在 prompt 中告知 Pi 语音文件路径和转写文本

示例：用户发送一条语音"你好，帮我查一下今天的天气"，Pi 收到的消息为：

```
你好，帮我查一下今天的天气

[用户发送了一条语音]
🎤 /home/qq110/.config/pi-weixin-cli/voices/2026-05-28_01-36-46_xxx.silk
```

### 视频消息支持

pi-weixin-cli 支持接收微信视频消息：
- 视频文件保存到 `~/.config/pi-weixin-cli/videos/`
- 在 prompt 中告知 Pi 视频文件路径

示例：用户发送一个视频，Pi 收到的消息为：

```
[用户发送了一个视频]
🎬 /home/qq110/.config/pi-weixin-cli/videos/2026-05-28_01-36-46_xxx.mp4
```

## Bash 命令执行

在微信中发送以 `!` 开头的消息，会通过 Pi 的 RPC `bash` 命令在 Pi session 的当前工作目录中执行 shell：

```
!ls -la
```

- 命令输出会立即返回微信
- 结果自动存入 Pi 的 `BashExecutionMessage`，下次发消息时 AI 会自动看到命令结果
- 不产生额外的 agent 回复（与 Pi TUI 的 `!` 命令行为一致）
- `!!` 和 `!` 在 RPC 模式下行为相同

## 配置

配置文件位于 `~/.config/pi-weixin-cli/settings.json`：

```json
{
  "enabled": true
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | daemon 启动时是否启用消息接收 |

所有配置项都可通过 `config` 命令动态修改，无需重启 daemon（下次启动时生效）。

## 数据目录

所有持久化数据保存在 `~/.config/pi-weixin-cli/`：

| 目录/文件 | 说明 |
|-----------|------|
| `accounts.json` | 已登录的微信机器人账号（botToken, userId, baseUrl） |
| `context-tokens.json` | 每个用户的 sync context token（用于 getUpdates 游标） |
| `images/` | 收到的微信图片 |
| `files/` | 收到的微信文件 |
| `voices/` | 收到的微信语音消息 |
| `videos/` | 收到的微信视频 |

## 限制（当前版本）

- **纯文本回复**：Pi 的回复以纯文本发送，不支持 Markdown 渲染或富文本
- **单会话处理**：消息按 FIFO 顺序逐条处理，Pi 同一时间只处理一条微信消息
- **无会话隔离**：所有微信消息注入同一个 Pi RPC 会话，不同微信用户共享 Pi 上下文
- **需要常驻终端**：daemon 模式在前台运行（非 systemd service），关闭终端即停止
- **bash 结果延迟可见**：`!command` 的结果在 Pi 内部静默存储，需**下一次用户消息**触发后 AI 才能看到（RPC 协议设计）

## 卸载

```bash
# 移除全局链接
npm uninstall -g pi-weixin-cli

# 删除项目文件
rm -rf ~/.config/pi-weixin-cli ~/pi-weixin-cli
```

## License

MIT

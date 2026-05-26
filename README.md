# pi-weixin-cli

Weixin (WeChat) integration extension for [pi](https://github.com/earendil-works/pi-coding-agent).

Receive and reply to WeChat messages directly from your pi terminal session.

## Requirements

- pi (>=2026.3.x)
- Node.js >= 18

## Installation

```bash
# 1. Create the extension directory
mkdir -p ~/.pi/agent/extensions/pi-weixin-cli

# 2. Copy extension files into the directory
# (if cloning from git, the files should already be there)
cp -r src package.json README.md ~/.pi/agent/extensions/pi-weixin-cli/

# 3. Install dependencies
cd ~/.pi/agent/extensions/pi-weixin-cli
npm install

# 4. Restart pi or run /reload
# In an existing pi session:
#   /reload
```

## Quick Start

```bash
# 1. In pi, start a new session or use an existing one
pi

# 2. Run the login command
/weixin-login

# 3. A QR code will appear in your terminal — scan it with WeChat

# 4. Once confirmed, the connection is active.
#    WeChat messages will be delivered to your pi session automatically.
```

## Commands

| Command | Description |
|---------|-------------|
| `/weixin-login` | Display a QR code to scan with WeChat for login |
| `/weixin-logout` | Remove a logged-in WeChat account |
| `/weixin-status` | Show the online status of all accounts |
| `/weixin-toggle` | Enable or disable WeChat message receiving |

## How It Works

1. **Login**: `/weixin-login` displays a QR code in your terminal. Scan it with WeChat
   to authenticate. The bot token is saved locally.

2. **Polling**: Once authenticated, the extension starts a background long-poll
   to the WeChat backend (`ilinkai.weixin.qq.com`) waiting for new messages.

3. **Message Flow**:
   - When a new WeChat message arrives and pi is idle, it's injected directly
     into your pi session as a user message.
   - If pi is busy (processing a previous prompt or running tools), the message
     is queued and delivered when pi becomes idle.
   - When pi finishes responding, the assistant's reply is sent back to WeChat.

4. **State**: Account credentials, sync cursors, and session tokens are persisted
   at `~/.pi/agent/extensions/pi-weixin-cli/state/` and survive pi restarts.

## Architecture

```
WeChat App
    │
    ▼
Weixin Backend (ilinkai.weixin.qq.com)
    │  ▲
    │  │  HTTP JSON API (getUpdates / sendMessage)
    ▼  │
┌─────────────────────────────┐
│  pi-weixin-cli extension    │
│  ┌─────────┐  ┌──────────┐ │
│  │ Poller  │  │  Bridge  │ │
│  │ (long-  │  │ (queue + │ │
│  │  poll)  │  │  inject) │ │
│  └────┬────┘  └────┬─────┘ │
│       │            │       │
│       ▼            ▼       │
│  WeixinApi (HTTP client)   │
└───────────────┬─────────────┘
                │
                ▼
         Pi Agent Session
```

## Limitations (MVP)

- **Text only**: Images, voice, files, and video messages are received but
  their content is not processed (they are silently skipped). Only text
  items are bridged.
- **No rich formatting**: Assistant replies are sent as plain text.
- **Single-threaded**: Messages are processed sequentially in FIFO order.
  Pi processes one WeChat message at a time.

## Troubleshooting

**QR code doesn't display properly**:
Make sure your terminal supports Unicode and has sufficient width for QR codes.

**"No accounts found" on startup**:
Run `/weixin-login` to log in again. Accounts persist across pi restarts.

**Messages not being received**:
Check status with `/weixin-status`. If offline, run `/weixin-login` again.
The poller automatically retries on network errors with exponential backoff.

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-weixin-cli
# Then in pi: /reload
```

## License

MIT

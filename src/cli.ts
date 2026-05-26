// ── CLI Command Handler ─────────────────────────────────────────────────
// Implements all CLI subcommands for pi-weixin-cli standalone mode.
// Invoked when the binary is called with arguments (other than "daemon").

import process from "node:process";

import { startQRLogin } from "./auth.js";
import { WeixinApi } from "./api.js";
import {
  loadAccounts,
  unregisterAccount,
} from "./storage.js";
import {
  loadConfig,
  saveConfig,
  resetConfig,
  type WeixinConfig,
} from "./config.js";

// ── Help ──────────────────────────────────────────────────────────────

const HELP = `pi-weixin-cli — 微信消息桥接工具

用法:
  pi-weixin-cli [命令]

命令:
  login              使用手机微信扫描二维码登录账号
  logout [id]        登出账号。不指定 id 时列出所有账号；使用 --all 删除全部
  status             显示所有已登录账号及其状态
  toggle             切换消息接收功能（启用/禁用）
  config show        显示当前配置
  config toggle      切换提示功能（启用/禁用）
  config interval N  设置提示间隔（每 N 条消息附加一次提示）
  config message 文本  设置提示文本内容
  config reset       恢复默认配置
  --help, -h         显示此帮助信息

不传任何参数则启动 daemon 模式（后台消息轮询）。
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

// ── Utility ────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

/** 截断字符串防止过长。 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// ── Handlers ───────────────────────────────────────────────────────────

/** login — 显示二维码并在终端等待扫码确认。 */
async function handleLogin(): Promise<number> {
  const api = new WeixinApi();
  let qrDisplayed = false;

  const result = await startQRLogin(api, {
    onDisplayQR(qrStr) {
      qrDisplayed = true;
      process.stdout.write(`\n${qrStr}\n\n`);
    },
    onStatus(msg) {
      process.stdout.write(`  ${msg}\n`);
    },
    onError(msg) {
      process.stderr.write(`  错误: ${msg}\n`);
    },
  });

  if (result.success) {
    process.stdout.write(`\n✓ 登录成功！账号 ID: ${result.account.id}\n`);
    process.stdout.write(`  User ID: ${result.account.userId}\n`);
    process.stdout.write(`  Base URL: ${result.account.baseUrl}\n`);
    return 0;
  }

  if (!qrDisplayed) {
    process.stderr.write(`✗ ${result.error}\n`);
  } else {
    process.stdout.write(`✗ ${result.error}\n`);
  }
  return 1;
}

/** logout — 登出并删除账号。 */
function handleLogout(args: string[]): number {
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    process.stdout.write("没有已登录的账号。\n");
    return 0;
  }

  // --all: delete all accounts
  if (args.includes("--all")) {
    for (const a of accounts) {
      unregisterAccount(a.id);
      process.stdout.write(`  已删除: ${a.id}\n`);
    }
    process.stdout.write("已删除所有账号。\n");
    return 0;
  }

  const id = args[0];

  if (id) {
    const found = accounts.find((a) => a.id === id);
    if (!found) {
      process.stderr.write(`错误: 未找到账号 "${id}"。\n`);
      process.stdout.write("\n已保存的账号:\n");
      for (const a of accounts) {
        process.stdout.write(`  ${a.id}\n`);
      }
      return 1;
    }
    unregisterAccount(id);
    process.stdout.write(`已登出账号: ${id}\n`);
    return 0;
  }

  // No id given — list accounts
  process.stdout.write("已保存的账号:\n");
  for (const a of accounts) {
    process.stdout.write(`  ${a.id}\n`);
  }
  process.stdout.write("\n用法: pi-weixin-cli logout <账号ID>\n");
  process.stdout.write("  或: pi-weixin-cli logout --all    (删除全部)\n");
  return 0;
}

/** status — 显示所有已保存的账号。 */
function handleStatus(): number {
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    process.stdout.write("没有已登录的账号。\n");
    return 0;
  }

  process.stdout.write(`已保存 ${accounts.length} 个账号:\n\n`);
  for (const a of accounts) {
    process.stdout.write(`  ID:        ${a.id}\n`);
    process.stdout.write(`  User ID:   ${a.userId}\n`);
    process.stdout.write(`  Base URL:  ${a.baseUrl}\n`);
    process.stdout.write(`  创建时间:  ${formatTime(a.createdAt)}\n`);
    process.stdout.write(`  状态:      已保存（daemon 未运行时无法检测在线状态）\n`);
    process.stdout.write("\n");
  }
  return 0;
}

/** toggle — 切换全局消息接收开关。 */
function handleToggle(): number {
  const config = loadConfig();
  config.enabled = !config.enabled;
  saveConfig(config);

  const status = config.enabled ? "已启用" : "已禁用";
  process.stdout.write(`消息接收: ${status}\n`);
  process.stdout.write(
    config.enabled
      ? "daemon 启动时将开始接收微信消息。\n"
      : "daemon 启动时将跳过消息接收。\n",
  );
  return 0;
}

// ── Config Subcommands ─────────────────────────────────────────────────

function handleConfig(args: string[]): number {
  const sub = args[0];

  switch (sub) {
    case "show":
      return handleConfigShow();
    case "toggle":
      return handleConfigToggle();
    case "interval":
      return handleConfigInterval(args[1]);
    case "message":
      return handleConfigMessage(args.slice(1));
    case "reset":
      return handleConfigReset();
    default: {
      process.stderr.write(`错误: 未知的 config 子命令 "${sub ?? "(无)"}"。\n\n`);
      process.stdout.write("可用子命令:\n");
      process.stdout.write("  show       显示当前配置\n");
      process.stdout.write("  toggle     切换提示功能\n");
      process.stdout.write("  interval N 设置提示间隔\n");
      process.stdout.write("  message 文本  设置提示文本\n");
      process.stdout.write("  reset      恢复默认配置\n");
      return 1;
    }
  }
}

function handleConfigShow(): number {
  const config = loadConfig();
  process.stdout.write("当前配置:\n\n");
  process.stdout.write(`  消息接收:    ${config.enabled ? "启用" : "禁用"}\n`);
  process.stdout.write(`  提示功能:    ${config.hintsEnabled ? "启用" : "禁用"}\n`);
  process.stdout.write(`  提示间隔:    ${config.hintInterval} 条\n`);
  process.stdout.write(`  提示文本:\n`);
  process.stdout.write(`    ${config.hintMessage}\n`);
  return 0;
}

function handleConfigToggle(): number {
  const config = loadConfig();
  config.hintsEnabled = !config.hintsEnabled;
  saveConfig(config);
  process.stdout.write(`提示功能: ${config.hintsEnabled ? "已启用" : "已禁用"}\n`);
  return 0;
}

function handleConfigInterval(arg: string | undefined): number {
  if (!arg) {
    process.stderr.write("错误: 请指定提示间隔。\n");
    process.stdout.write("用法: pi-weixin-cli config interval <N>\n");
    return 1;
  }
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`错误: "${arg}" 不是有效的正整数。\n`);
    return 1;
  }
  const config = loadConfig();
  config.hintInterval = n;
  saveConfig(config);
  process.stdout.write(`提示间隔已设置为: ${n} 条\n`);
  return 0;
}

function handleConfigMessage(args: string[]): number {
  if (args.length === 0) {
    process.stderr.write("错误: 请指定提示文本。\n");
    process.stdout.write("用法: pi-weixin-cli config message <文本>\n");
    return 1;
  }
  const text = args.join(" ");
  const config = loadConfig();
  config.hintMessage = text;
  saveConfig(config);
  process.stdout.write(`提示文本已更新:\n  ${truncate(text, 120)}\n`);
  return 0;
}

function handleConfigReset(): number {
  resetConfig();
  process.stdout.write("配置已恢复为默认值。\n");
  return 0;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * 解析并执行 CLI 命令。
 * @returns 进程退出码（0 = 成功，非 0 = 错误）。
 */
export async function runCLI(args: string[]): Promise<number> {
  // Route to command or help
  const cmd = args[0];

  switch (cmd) {
    case "--help":
    case "-h":
      printHelp();
      return 0;

    case "login":
      return await handleLogin();

    case "logout":
      return handleLogout(args.slice(1));

    case "status":
      return handleStatus();

    case "toggle":
      return handleToggle();

    case "config":
      return handleConfig(args.slice(1));

    default: {
      process.stderr.write(
        `未知命令: ${cmd ?? "(无)"}\n`,
      );
      process.stderr.write('运行 "pi-weixin-cli --help" 查看可用命令。\n');
      return 1;
    }
  }
}

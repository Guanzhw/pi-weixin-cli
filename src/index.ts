// ── pi-weixin-cli Extension Entry ──────────────────────────────────────
// A Pi extension that bridges WeChat messages to Pi sessions, enabling
// WeChat-based conversation with the Pi agent.
//
// Commands:
//   /weixin-login    — Scan QR code to log in to WeChat
//   /weixin-logout   — Remove a logged-in WeChat account
//   /weixin-status   — Show connection status of all accounts
//   /weixin-toggle   — Enable / disable message receiving
//   /weixin-config   — Configure TUI hint injection

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WeixinApi } from "./api.js";
import { WeixinBridge } from "./bridge.js";
import { Poller } from "./poller.js";
import { startQRLogin } from "./auth.js";
import {
  loadAccounts,
  unregisterAccount,
} from "./storage.js";
import type { WeixinAccount } from "./types.js";
import { loadConfig, saveConfig } from "./config.js";
import type { WeixinConfig } from "./config.js";

// ── Extension State ────────────────────────────────────────────────────

interface ActivePoller {
  poller: Poller;
  account: WeixinAccount;
}

// ── Default Export ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const api = new WeixinApi();
  const config = loadConfig();
  const bridge = new WeixinBridge(
    {
      sendUserMessage(text, options) {
        pi.sendUserMessage(text, options);
      },
    },
    api,
    config,
    (msg) => {
      // Log messages are forwarded as Pi appendEntries for session tracing
      pi.appendEntry("weixin-log", { msg, ts: Date.now() });
    },
  );

  const pollers = new Map<string, ActivePoller>();

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Start pollers for all saved accounts.
   * Called on session_start and after successful login.
   */
  function startAllPollers(): void {
    const accounts = loadAccounts();
    for (const account of accounts) {
      startPoller(account);
    }
  }

  function startPoller(account: WeixinAccount): void {
    if (pollers.has(account.id)) return;

    const poller = new Poller(
      api,
      account,
      (acc, msg, text) => {
        bridge.onWeixinMessage(acc, msg, text);
      },
      (msg) => {
        pi.appendEntry("weixin-poll", { account: account.id, msg, ts: Date.now() });
      },
    );

    poller.start();
    pollers.set(account.id, { poller, account });

    // Notify WeChat backend that this bot is online
    api.notifyStart(account.botToken, account.baseUrl).then((resp) => {
      const raw = (resp as any).__raw ?? JSON.stringify(resp);
      pi.appendEntry("weixin-poll", { account: account.id, msg: `notifyStart OK: ${raw.slice(0, 200)}`, ts: Date.now() });
    }).catch((err) => {
      pi.appendEntry("weixin-poll", { account: account.id, msg: `notifyStart failed: ${err}`, ts: Date.now() });
    });
  }

  function stopPoller(accountId: string): void {
    const entry = pollers.get(accountId);
    if (entry) {
      entry.poller.stop();
      pollers.delete(accountId);
    }
  }

  function stopAllPollers(): void {
    for (const [, entry] of pollers) {
      entry.poller.stop();
    }
    pollers.clear();
  }

  // ── Event Handlers ───────────────────────────────────────────────────

  pi.on("session_start", async (_event) => {
    // Reset WeChat message counter for the new session
    bridge.resetMessageCount();

    // Restore accounts and start polling
    startAllPollers();
    const count = pollers.size;
    if (count > 0) {
      pi.appendEntry("weixin-state", {
        accounts: count,
        ts: Date.now(),
        msg: `已恢复 ${count} 个微信账号连接`,
      });
    }
  });

  pi.on("session_shutdown", async () => {
    // Save state, stop pollers
    bridge.enabled = false;
    stopAllPollers();
    pi.appendEntry("weixin-state", { msg: "微信桥接已关闭", ts: Date.now() });
  });

  pi.on("agent_start", async () => {
    bridge.isAgentIdle = false;
  });

  pi.on("agent_end", async (event) => {
    await bridge.handleAgentEnd(event.messages);
    bridge.isAgentIdle = true;
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "ask_user") {
      const input = event.input as {
        question?: string;
        options?: Array<string | { title: string; description?: string }>;
        context?: string;
      };
      const question = input.question || input.context || "Pi 需要你确认一个操作";
      const options = input.options || [];

      // Only send notification when we're currently processing a WeChat message
      if (bridge.isProcessingWeixin) {
        try {
          await bridge.notifyAskUser(question, options);
        } catch (err) {
          // Notification failure should not affect the main agent flow
          const msg = err instanceof Error ? err.message : String(err);
          pi.appendEntry("weixin-askuser", { error: msg, ts: Date.now() });
        }
      }
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────

  pi.registerCommand("weixin-login", {
    description: "Scan QR code to log in to WeChat",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify("开始微信登录流程...", "info");

      const result = await startQRLogin(api, {
        onDisplayQR: (qrStr: string) => {
          // Print QR code to terminal
          console.log("\n" + qrStr);
        },
        onStatus: (msg: string) => {
          ctx.ui.notify(msg, "info");
          pi.appendEntry("weixin-auth", { msg, ts: Date.now() });
        },
        onError: (msg: string) => {
          ctx.ui.notify(msg, "error");
          pi.appendEntry("weixin-auth", { error: msg, ts: Date.now() });
        },
      });

      if (result.success) {
        ctx.ui.notify(
          `微信登录成功！账号: ${result.account.id}`,
          "info",
        );
        // Start polling for the new account
        startPoller(result.account);
        pi.appendEntry("weixin-auth", {
          success: true,
          account: result.account.id,
          ts: Date.now(),
        });
      } else {
        ctx.ui.notify(`登录失败: ${result.error}`, "error");
      }
    },
  });

  pi.registerCommand("weixin-logout", {
    description: "Remove a logged-in WeChat account",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const accounts = loadAccounts();

      if (accounts.length === 0) {
        ctx.ui.notify("没有已登录的微信账号", "info");
        return;
      }

      // Single account → confirm and remove directly
      if (accounts.length === 1) {
        const confirmed = await ctx.ui.confirm(
          "确认登出",
          `是否登出微信账号 ${accounts[0].id}？`,
        );
        if (!confirmed) return;

        stopPoller(accounts[0].id);
        unregisterAccount(accounts[0].id);
        ctx.ui.notify(`已登出: ${accounts[0].id}`, "info");
        pi.appendEntry("weixin-auth", { action: "logout", account: accounts[0].id, ts: Date.now() });
        return;
      }

      // Multiple accounts → let user pick
      const choices = accounts.map((a) => `${a.id} (${a.userId})`);
      const picked = await ctx.ui.select("选择要登出的账号:", choices);
      if (!picked) return;

      const pickedId = picked.split(" ")[0];
      const confirmed = await ctx.ui.confirm(
        "确认登出",
        `是否登出微信账号 ${pickedId}？`,
      );
      if (!confirmed) return;

      stopPoller(pickedId);
      unregisterAccount(pickedId);
      ctx.ui.notify(`已登出: ${pickedId}`, "info");
      pi.appendEntry("weixin-auth", { action: "logout", account: pickedId, ts: Date.now() });
    },
  });

  pi.registerCommand("weixin-status", {
    description: "Show connection status of all WeChat accounts",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const accounts = loadAccounts();

      if (accounts.length === 0) {
        ctx.ui.notify("没有已登录的微信账号。使用 /weixin-login 登录", "info");
        return;
      }

      ctx.ui.notify(`微信账号 (${accounts.length}):`, "info");
      for (const acc of accounts) {
        const isPolling = pollers.has(acc.id) && pollers.get(acc.id)!.poller.isRunning;
        const status = isPolling ? "🟢 在线" : "🔴 离线";
        const createdAt = new Date(acc.createdAt).toLocaleString("zh-CN");
        console.log(`  ${status} ${acc.id} (${acc.userId}) — 登录于 ${createdAt}`);
      }
    },
  });

  pi.registerCommand("weixin-toggle", {
    description: "Enable / disable WeChat message receiving",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      bridge.enabled = !bridge.enabled;
      const status = bridge.enabled ? "已启用" : "已禁用";
      ctx.ui.notify(`微信消息接收${status}`, "info");
      pi.appendEntry("weixin-toggle", { enabled: bridge.enabled, ts: Date.now() });
    },
  });

  pi.registerCommand("weixin-config", {
    description: "Configure WeChat hint settings",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cfg = loadConfig();
      const parts = args.trim().split(/\s+/);
      const subcmd = parts[0] || "";

      if (!subcmd || subcmd === "show") {
        console.log("=== pi-weixin-cli 配置 ===");
        console.log(`提示功能: ${cfg.hintsEnabled ? "已启用" : "已禁用"}`);
        console.log(`提示间隔: 每 ${cfg.hintInterval} 条消息`);
        console.log(`提示文本:`);
        console.log(`  ${cfg.hintMessage}`);
        console.log(`当前 session 已注入消息数: ${bridge.getMessageCount()}`);
        console.log("\n用法: /weixin-config <子命令>");
        console.log("  show          显示当前配置");
        console.log("  toggle        启用/禁用提示");
        console.log("  interval <N>  设置提示间隔（条数）");
        console.log("  message <文本> 设置提示文本");
        console.log("  reset         恢复默认配置");
        return;
      }

      if (subcmd === "toggle") {
        cfg.hintsEnabled = !cfg.hintsEnabled;
        saveConfig(cfg);
        bridge.updateConfig(cfg);
        ctx.ui.notify(`提示功能已${cfg.hintsEnabled ? "启用" : "禁用"}`, "info");
        return;
      }

      if (subcmd === "interval" && parts[1]) {
        const n = parseInt(parts[1], 10);
        if (isNaN(n) || n < 1) {
          ctx.ui.notify("间隔必须是正整数", "error");
          return;
        }
        cfg.hintInterval = n;
        saveConfig(cfg);
        bridge.updateConfig(cfg);
        ctx.ui.notify(`提示间隔已设为每 ${n} 条消息`, "info");
        return;
      }

      if (subcmd === "message") {
        const text = parts.slice(1).join(" ").trim();
        if (!text) {
          ctx.ui.notify("提示文本不能为空", "error");
          return;
        }
        cfg.hintMessage = text;
        saveConfig(cfg);
        bridge.updateConfig(cfg);
        ctx.ui.notify("提示文本已更新", "info");
        return;
      }

      if (subcmd === "reset") {
        const defaultCfg: WeixinConfig = {
          hintInterval: 3,
          hintMessage:
            "[系统提示] 当前用户通过微信远程交互，无法使用终端 TUI。请直接做出最佳决策，不要调用 ask_user、confirm、select 等需要用户交互的工具。",
          hintsEnabled: true,
        };
        saveConfig(defaultCfg);
        bridge.updateConfig(defaultCfg);
        ctx.ui.notify("配置已恢复默认值", "info");
        return;
      }

      ctx.ui.notify(
        `未知子命令: ${subcmd}，使用 /weixin-config show 查看用法`,
        "error",
      );
    },
  });
}

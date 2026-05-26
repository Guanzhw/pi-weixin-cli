// ── pi-weixin-cli Extension Entry ──────────────────────────────────────
// A Pi extension that bridges WeChat messages to Pi sessions, enabling
// WeChat-based conversation with the Pi agent.
//
// Commands:
//   /weixin-login    — Scan QR code to log in to WeChat
//   /weixin-logout   — Remove a logged-in WeChat account
//   /weixin-status   — Show connection status of all accounts
//   /weixin-toggle   — Enable / disable message receiving

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

// ── Extension State ────────────────────────────────────────────────────

interface ActivePoller {
  poller: Poller;
  account: WeixinAccount;
}

// ── Default Export ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const api = new WeixinApi();
  const bridge = new WeixinBridge(
    {
      sendUserMessage(text, options) {
        pi.sendUserMessage(text, options);
      },
    },
    api,
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
}

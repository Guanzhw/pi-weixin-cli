#!/usr/bin/env node
// ── pi-weixin-cli RPC Entry Point ──────────────────────────────────────
// Standalone process that bridges WeChat messages to Pi via RPC protocol.
//
// Architecture:
//   WeChat API (getUpdates long-poll)
//     → Poller (per-account message pump)
//       → StateMachine (message routing: normal vs UI response)
//         → RpcClient (JSONL stdin/stdout to Pi subprocess)
//           → UIBridge (extension_ui_request ↔ WeChat messages)
//         → WeixinApi.sendMessage (reply back to WeChat)
//
// The RPC client spawns `pi --mode rpc --no-session` and communicates
// via JSONL on stdin/stdout. Each WeChat message becomes a `prompt`
// command, and the assistant's reply is extracted from the `agent_end`
// event and sent back to the WeChat user.
//
// When Pi's extension calls ctx.ui.select/confirm/input/editor, the
// StateMachine transitions to WAITING_UI_RESPONSE and the UIBridge
// forwards the prompt to WeChat. The user's reply is parsed and sent
// back as extension_ui_response, allowing Pi to continue.
//
// If the Pi RPC subprocess crashes or exits unexpectedly, the daemon
// automatically reconnects with exponential backoff (max 10 retries).

import process from "node:process";
import crypto from "node:crypto";

import { WeixinApi } from "./api.js";
import { Poller, type MessageCallback, type LogCallback } from "./poller.js";
import { RpcClient } from "./rpc-client.js";
import { loadAccounts, saveContextToken, loadContextTokens } from "./storage.js";
import { loadConfig } from "./config.js";
import type { WeixinAccount, ImageItem } from "./types.js";
import { MessageItemType, MessageType, MessageState } from "./types.js";
import type { AgentEndEvent, ExtensionUIRequestEvent, ImageContent } from "./types-rpc.js";
import { processImageForPi } from "./media-handler.js";
import { StateMachine, type UIMethod, type UIRequestContext } from "./state-machine.js";
import { formatUIRequestForWeixin, isFireAndForget, parseUserResponse } from "./ui-bridge.js";
import { runCLI } from "./cli.js";

// ── Pending Context (for reply routing) ────────────────────────────────

interface PendingContext {
  account: WeixinAccount;
  userId: string;
  contextToken: string;
  sessionId: string;
}

// ── Message Queue Entry ────────────────────────────────────────────────

interface QueuedMessage {
  account: WeixinAccount;
  userId: string;
  contextToken: string;
  sessionId: string;
  text: string;
  /** Optional image item from the WeChat message. */
  imageItem?: ImageItem;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract the last assistant text reply from Pi's agent_end messages array.
 * Mirrors bridge.ts extractAssistantReply().
 */
function extractAssistantReply(messages: unknown[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;

  let lastAssistantText = "";
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m["role"] !== "assistant") continue;
    const content = m["content"];
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      if (c === null || typeof c !== "object") continue;
      const item = c as Record<string, unknown>;
      if (item["type"] !== "text") continue;
      const text = item["text"];
      if (typeof text === "string" && text) {
        lastAssistantText = text;
      }
    }
  }

  return lastAssistantText || null;
}

/**
 * Send a text reply back to a WeChat user.
 * Mirrors bridge.ts sendReply.
 */
async function sendWeixinReply(
  api: WeixinApi,
  account: WeixinAccount,
  toUserId: string,
  contextToken: string,
  sessionId: string,
  replyText: string,
): Promise<void> {
  try {
    await api.sendMessage(
      {
        msg: {
          from_user_id: "",
          client_id: crypto.randomUUID(),
          to_user_id: toUserId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          create_time_ms: Date.now(),
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: replyText },
            },
          ],
          context_token: contextToken,
          session_id: sessionId || undefined,
        },
      },
      account.botToken,
      account.baseUrl,
    );
    log(`[weixin] 回复已发送 (${replyText.length} 字符) → ${toUserId}`);
  } catch (err) {
    log(
      `[weixin] 回复发送失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Logging ────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${msg}\n`);
}

// ── Slash Command Type ─────────────────────────────────────────────────

interface SlashCommand {
  command: string;
  args: string;
}

// ── Daemon ─────────────────────────────────────────────────────────────

async function runDaemon(): Promise<void> {
  log("pi-weixin-cli RPC 模式启动中...");

  // ── Load config ──────────────────────────────────────────────────────
  const config = loadConfig();

  // ── Respect config.enabled ───────────────────────────────────────────
  if (!config.enabled) {
    log("配置中消息接收已禁用。使用 'pi-weixin-cli toggle' 启用。");
    process.exit(0);
  }

  // ── Load accounts ────────────────────────────────────────────────────
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    log("错误: 没有已登录的微信账号。");
    log("请先使用 'pi-weixin-cli login' 命令登录，或手动编辑 accounts.json。");
    log("账号文件位于: ~/.pi/agent/extensions/pi-weixin-cli/state/accounts.json");
    process.exit(1);
  }

  log(`已加载 ${accounts.length} 个微信账号: ${accounts.map((a) => a.id).join(", ")}`);

  // ── Initialize API client ────────────────────────────────────────────
  const api = new WeixinApi();

  // ── Mutable state (may be reset during reconnect) ────────────────────
  let rpcClient: RpcClient | null = null;
  let shuttingDown = false;

  // ── State Machine ────────────────────────────────────────────────────
  const sm = new StateMachine();

  /** Queue of messages waiting to be sent to Pi. */
  const messageQueue: QueuedMessage[] = [];

  /** Context of the currently processing WeChat message. */
  let pendingContext: PendingContext | null = null;

  /** Pending model selections: userId → models array (for /model flow). */
  const pendingModelSelections = new Map<string, unknown[]>();

  // ── Slash command helpers ──────────────────────────────────────────

  /** Parse a slash command from message text. Returns null if not a command. */
  function parseSlashCommand(text: string): SlashCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      return { command: trimmed.slice(1).toLowerCase(), args: "" };
    }
    return {
      command: trimmed.slice(1, spaceIdx).toLowerCase(),
      args: trimmed.slice(spaceIdx + 1).trim(),
    };
  }

  /** Format session state into a human-readable text block. */
  function formatSessionState(state: unknown): string {
    if (state === null || typeof state !== "object") {
      return `📊 Session 状态: ${JSON.stringify(state)}`;
    }
    const s = state as Record<string, unknown>;
    const lines = ["📊 Session 状态："];
    if (s.sessionId !== undefined) lines.push(`会话ID: ${s.sessionId}`);
    if (s.model !== undefined) {
      const model = s.model as Record<string, unknown> | string;
      const modelName = typeof model === "string" ? model : (model.name ?? model.id ?? JSON.stringify(model));
      lines.push(`模型: ${modelName}`);
    }
    if (s.thinkingLevel !== undefined) lines.push(`思考级别: ${s.thinkingLevel}`);
    if (s.isStreaming !== undefined) lines.push(`流式输出: ${s.isStreaming ? "是" : "否"}`);
    if (s.messageCount !== undefined) lines.push(`消息数: ${s.messageCount}`);
    return lines.join("\n");
  }

  /**
   * Handle a slash command from a WeChat user.
   * Executes immediately (does not enter the message queue).
   */
  async function handleSlashCommand(
    cmd: SlashCommand,
    account: WeixinAccount,
    userId: string,
    contextToken: string,
    sessionId: string,
  ): Promise<void> {
    if (!rpcClient) return;

    try {
      switch (cmd.command) {
        case "new": {
          await rpcClient.newSession();
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 已新建 session");
          log(`[slash] /new → 已新建 session (user=${userId})`);
          break;
        }

        case "compact": {
          await rpcClient.compact(cmd.args || undefined);
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 上下文已压缩");
          log(`[slash] /compact → 已压缩 (user=${userId})`);
          break;
        }

        case "abort": {
          rpcClient.sendAbort();
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 已中止当前任务");
          log(`[slash] /abort → 已中止 (user=${userId})`);
          break;
        }

        case "session": {
          const state = await rpcClient.getState();
          const formatted = formatSessionState(state);
          await sendWeixinReply(api, account, userId, contextToken, sessionId, formatted);
          log(`[slash] /session → 已返回状态 (user=${userId})`);
          break;
        }

        case "model": {
          const result = (await rpcClient.getAvailableModels()) as Record<string, unknown> | null;
          const models = result?.models as unknown[] | undefined;
          if (!models || models.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 未获取到可用模型列表");
            return;
          }

          pendingModelSelections.set(userId, models);

          const lines = ["📋 可用模型列表："];
          models.forEach((m: unknown, i: number) => {
            const item = m as Record<string, unknown>;
            const provider = item.provider ? `[${item.provider}] ` : "";
            const name = (item.name ?? item.id ?? item.modelId ?? `模型 ${i + 1}`) as string;
            const current = item.current ? " ← 当前" : "";
            lines.push(`${i + 1}. ${provider}${name}${current}`);
          });
          lines.push("", "回复数字编号切换模型");

          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /model → 已发送模型列表 (${models.length} 个, user=${userId})`);
          break;
        }

        case "help": {
          const helpText = [
            "📋 可用命令：",
            "/new — 新建 session",
            "/compact — 压缩上下文",
            "/abort — 中止当前任务",
            "/session — 查看 session 状态",
            "/model — 切换模型",
            "/help — 显示此帮助",
          ].join("\n");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, helpText);
          log(`[slash] /help → 已发送帮助 (user=${userId})`);
          break;
        }

        default:
          await sendWeixinReply(
            api,
            account,
            userId,
            contextToken,
            sessionId,
            `⚠️ 未知命令: /${cmd.command}。发送 /help 查看可用命令。`,
          );
          log(`[slash] 未知命令: /${cmd.command} (user=${userId})`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`[slash] 命令 /${cmd.command} 执行失败: ${errMsg}`);
      await sendWeixinReply(
        api,
        account,
        userId,
        contextToken,
        sessionId,
        `❌ 命令 /${cmd.command} 执行失败: ${errMsg}`,
      ).catch(() => {});
    }
  }

  /** Whether we're currently processing a WeChat-triggered agent turn. */
  let processingWeixin = false;

  /** Active poller instances (stopped/restarted during reconnect). */
  const pollers: Poller[] = [];

  // ── Poller callbacks ─────────────────────────────────────────────────

  const onPollLog: LogCallback = (msg) => {
    log(`[poller] ${msg}`);
  };

  const onMessage: MessageCallback = (account, msg, text, imageItem) => {
    // Guard: if Pi is not connected, discard messages (reconnect in progress)
    if (!rpcClient) {
      log(`[weixin] 收到消息但 Pi 未连接，丢弃: ${text.slice(0, 40)}...`);
      return;
    }

    const userId = msg.from_user_id ?? "";
    const contextToken = msg.context_token ?? "";
    const sessionId = msg.session_id ?? "";

    // Save context token for this user (must echo verbatim in replies)
    if (userId && contextToken) {
      saveContextToken(account.id, userId, contextToken);
    }

    log(`[weixin] 收到消息: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""} | from=${userId} ctx=${contextToken.slice(0, 20)}...`);

    // Load latest context token from storage (may have been updated)
    const tokens = loadContextTokens(account.id);
    const latestToken = tokens[userId] ?? contextToken;

    // ── Pending model selection check (for /model flow) ─────────────
    const pendingModels = pendingModelSelections.get(userId);
    if (pendingModels) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= pendingModels.length) {
        pendingModelSelections.delete(userId);
        const model = pendingModels[num - 1] as Record<string, unknown>;
        const modelId = (model.id ?? model.modelId ?? "") as string;
        const provider = (model.provider ?? "") as string;

        void (async () => {
          try {
            await rpcClient!.setModel(provider, modelId);
            const name = (model.name ?? modelId) as string;
            await sendWeixinReply(
              api,
              account,
              userId,
              latestToken,
              sessionId,
              `✅ 已切换模型: ${name}`,
            );
            log(`[slash] 模型已切换: ${name} (user=${userId})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`[slash] 切换模型失败: ${errMsg}`);
            await sendWeixinReply(
              api,
              account,
              userId,
              latestToken,
              sessionId,
              `❌ 切换模型失败: ${errMsg}`,
            ).catch(() => {});
          }
        })();
        return;
      }
      // Not a valid selection number — clear pending and fall through
      pendingModelSelections.delete(userId);
    }

    // ── Slash command detection ───────────────────────────────────────
    const slashResult = parseSlashCommand(text);
    if (slashResult) {
      void handleSlashCommand(slashResult, account, userId, latestToken, sessionId);
      return;
    }

    // ── Route by state machine ─────────────────────────────────────────
    if (sm.isWaitingUIResponse) {
      const uiReq = sm.pendingUIRequest!;
      log(`[weixin] 当前状态=WAITING_UI_RESPONSE (${uiReq.method}), 解释为 UI 回复`);

      // Parse the user's response into an extension_ui_response payload
      const parsed = parseUserResponse(text, uiReq.method, uiReq.options);
      log(`[weixin] 解析 UI 回复: ${JSON.stringify(parsed)}`);

      // Send the response back to Pi via stdin
      try {
        rpcClient.sendExtensionUIResponse(uiReq.requestId, parsed);
      } catch (err) {
        log(`[rpc] 发送 UI 响应失败: ${err}`);
      }

      // Transition back to agent-running (Pi continues processing)
      sm.setAgentRunning();

      return;
    }

    // ── Normal message: inject or queue ────────────────────────────────
    if (!processingWeixin && !rpcClient.isStreaming) {
      // Pi is idle — inject immediately
      injectMessage({
        account,
        userId,
        contextToken: latestToken,
        sessionId,
        text,
        imageItem,
      }).catch((err) => log(`[weixin] 注入失败: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      // Pi is busy or already processing — queue
      log(`[weixin] Pi 忙碌，消息入队 (队列长度: ${messageQueue.length + 1})`);
      messageQueue.push({
        account,
        userId,
        contextToken: latestToken,
        sessionId,
        text,
        imageItem,
      });
    }
  };

  // ── Message injection / queue ────────────────────────────────────────

  /**
   * Inject a WeChat message into Pi.
   * Appends TUI-disable hint at configured interval.
   * If the message contains an image, downloads and converts it first.
   */
  async function injectMessage(qm: QueuedMessage): Promise<void> {
    if (!rpcClient) return;

    processingWeixin = true;
    pendingContext = {
      account: qm.account,
      userId: qm.userId,
      contextToken: qm.contextToken,
      sessionId: qm.sessionId,
    };

    const messageText = qm.text;

    // ── Image processing ────────────────────────────────────────────
    let imageContents: ImageContent[] | undefined;
    if (qm.imageItem) {
      try {
        log(`[weixin] 处理图片...`);
        const result = await processImageForPi(qm.imageItem);
        if (result) {
          imageContents = [result];
          log(`[weixin] 图片已下载并转换 (${result.mimeType}, ${(result.data.length / 1024).toFixed(1)}KB base64)`);
        } else {
          log(`[weixin] 图片处理失败：无法获取图片 URL`);
          // Send degradation notice
          await sendWeixinReply(
            api,
            qm.account,
            qm.userId,
            qm.contextToken,
            qm.sessionId,
            "⚠️ 图片下载失败，仅发送文本",
          );
        }
      } catch (err) {
        log(`[weixin] 图片处理异常: ${err instanceof Error ? err.message : String(err)}`);
        // Send degradation notice
        await sendWeixinReply(
          api,
          qm.account,
          qm.userId,
          qm.contextToken,
          qm.sessionId,
          "⚠️ 图片下载失败，仅发送文本",
        ).catch(() => {});
      }
    }

    const summary = qm.text.slice(0, 60) || (imageContents ? `[图片]` : "[空消息]");
    log(`[weixin] 发送 prompt: ${summary}${qm.text.length > 60 ? "..." : ""}${imageContents ? ` + ${imageContents.length} 张图片` : ""}`);
    rpcClient.sendPrompt(messageText, imageContents);
  }

  /**
   * Process the message queue.
   * Only injects when Pi is truly idle (not streaming, not waiting for UI).
   */
  function flushQueue(): void {
    if (!rpcClient || processingWeixin || messageQueue.length === 0) return;

    // Don't dequeue while Pi is busy or waiting for user input
    if (rpcClient.isStreaming || sm.isWaitingUIResponse) return;

    const next = messageQueue.shift()!;
    log(`[weixin] 队列有 ${messageQueue.length + 1} 条消息，注入下一条`);
    setImmediate(() => {
      injectMessage(next).catch((err) => log(`[weixin] 队列注入失败: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  // ── RPC Event Binding ────────────────────────────────────────────────

  /**
   * Bind all RPC event handlers to a (new) RpcClient instance.
   * The "exit" handler triggers the reconnect loop instead of exiting.
   */
  function bindRpcEvents(client: RpcClient): void {
    client.on("agent_start", () => {
      log("[rpc] agent_start");
      sm.setAgentRunning();
    });

    client.on("agent_end", async (event: AgentEndEvent) => {
      log("[rpc] agent_end");

      // If we were processing a WeChat message, send the reply back
      if (pendingContext !== null) {
        const ctx = pendingContext;
        pendingContext = null;

        const reply = extractAssistantReply(event.messages);
        if (reply) {
          await sendWeixinReply(
            api,
            ctx.account,
            ctx.userId,
            ctx.contextToken,
            ctx.sessionId,
            reply,
          );
        } else {
          log("[weixin] agent_end 中未找到 assistant 文本回复");
        }

        processingWeixin = false;
      }

      // Transition to idle
      sm.setIdle();

      // Process next queued message
      flushQueue();
    });

    client.on("message_update", () => {
      // Silent — we only care about the final reply
    });

    /**
     * Handle extension_ui_request events from Pi.
     *
     * Two categories:
     *   1. Fire-and-forget (notify, setStatus, setWidget, setTitle,
     *      set_editor_text) — just forward to WeChat, no response expected.
     *   2. Dialog (select, confirm, input, editor) — store pending UI request,
     *      forward to WeChat, wait for user's reply.
     */
    client.on("extension_ui_request", (event: ExtensionUIRequestEvent) => {
      const method = event.method;
      log(`[rpc] extension_ui_request: method=${method} id=${event.id}`);

      // ── Fire-and-forget: forward to WeChat if we have a pending context ──
      if (isFireAndForget(method)) {
        if (pendingContext) {
          const formatted = formatUIRequestForWeixin(event);
          if (formatted) {
            sendWeixinReply(
              api,
              pendingContext.account,
              pendingContext.userId,
              pendingContext.contextToken,
              pendingContext.sessionId,
              formatted,
            ).catch((err) => log(`[weixin] 通知发送失败: ${err}`));
          }
        } else {
          log(`[rpc] 忽略 ${method} (无活跃微信会话)`);
        }
        return;
      }

      // ── Dialog: block until user responds ──────────────────────────────
      // Only bridge to WeChat if we're currently processing a WeChat message
      if (!pendingContext) {
        log(`[rpc] 忽略 ${method} (无活跃微信会话，Pi 将等待超时)`);
        return;
      }

      const ctx = pendingContext;
      const formatted = formatUIRequestForWeixin(event);

      // Send the question to WeChat
      if (formatted) {
        sendWeixinReply(
          api,
          ctx.account,
          ctx.userId,
          ctx.contextToken,
          ctx.sessionId,
          formatted,
        ).catch((err) => log(`[weixin] UI 请求发送失败: ${err}`));
      }

      // Extract timeout (in ms) from the event — it's optional on select/confirm/input
      const timeoutMs = event.timeout;

      // Build UI request context for the state machine
      const uiCtx: UIRequestContext = {
        requestId: event.id,
        method: method as UIMethod,
        account: ctx.account,
        userId: ctx.userId,
        contextToken: ctx.contextToken,
        sessionId: ctx.sessionId,
        title: event.title,
        message: event.message,
        placeholder: event.placeholder,
        prefill: event.prefill,
        options: event.options,
      };

      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        uiCtx.timeoutAt = Date.now() + timeoutMs;
        uiCtx.timeoutId = setTimeout(() => {
          log(`[rpc] UI 请求 ${event.id} (${method}) 超时，发送 cancelled`);
          try {
            // Use the current rpcClient at timeout time, not the closure
            if (rpcClient && rpcClient.isRunning) {
              rpcClient.sendExtensionUIResponse(event.id, { cancelled: true });
            }
          } catch (err) {
            log(`[rpc] 发送 cancelled 响应失败: ${err}`);
          }
          sm.setAgentRunning();
        }, timeoutMs);
      }

      sm.setWaitingUIResponse(uiCtx);
    });

    client.on("tool_execution_start", (event) => {
      log(`[rpc] tool_start: ${event.toolName ?? "unknown"}`);
    });

    client.on("tool_execution_end", () => {
      // Silent — tool results are large
    });

    client.on("response", (event) => {
      if (!event.success) {
        log(`[rpc] response error: ${event.command} → ${event.error ?? "unknown"}`);
      }
    });

    client.on("error", (err) => {
      log(`[rpc] error: ${err.message}`);
    });

    // ── Exit → Auto-Reconnect ──────────────────────────────────────────
    client.on("exit", async (code, signal) => {
      log(`[rpc] Pi 子进程已退出 (code=${code}, signal=${signal})`);
      rpcClient = null;
      await reconnect();
    });
  }

  // ── Reconnect Logic ──────────────────────────────────────────────────

  /**
   * Restart the Pi RPC subprocess with exponential backoff.
   *
   * Parameters:
   *   - Base delay: 2s, max: 60s
   *   - Jitter: random 0–1000ms per attempt
   *   - Max retries: 10 (total worst-case ≈ 570s)
   *
   * On success: pollers are restarted, message flow resumes.
   * On failure after max retries: process exits with code 1.
   */
  async function reconnect(): Promise<void> {
    if (shuttingDown) return;

    // ── Stop all pollers (no point receiving messages without Pi) ─────
    for (const poller of pollers) {
      poller.stop();
    }
    pollers.length = 0;
    log("[rpc] 所有轮询器已停止（等待 Pi 重连）");

    // ── Reset volatile state ──────────────────────────────────────────
    sm.setIdle();
    messageQueue.length = 0;
    pendingContext = null;
    processingWeixin = false;

    // ── Exponential backoff retry loop ────────────────────────────────
    const maxRetries = 10;
    const baseDelay = 2_000;
    const maxDelay = 60_000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (shuttingDown) {
        log("[rpc] 重连期间收到关闭信号，退出。");
        process.exit(0);
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = Math.random() * 1_000;
      const totalDelay = delay + jitter;

      log(
        `[rpc] 重连尝试 ${attempt}/${maxRetries}，等待 ${Math.round(totalDelay)}ms...`,
      );
      await new Promise((r) => setTimeout(r, totalDelay));

      try {
        const newClient = new RpcClient();
        await newClient.spawn();
        rpcClient = newClient;
        bindRpcEvents(newClient);

        log(
          `[rpc] 重连成功 (PID: ${(newClient as any).proc?.pid ?? "unknown"})`,
        );

        // ── Restart pollers ───────────────────────────────────────────
        for (const account of accounts) {
          const poller = new Poller(api, account, onMessage, onPollLog);
          poller.start();
          pollers.push(poller);

          api
            .notifyStart(account.botToken, account.baseUrl)
            .then(() => log(`[weixin] notifyStart OK for ${account.id}`))
            .catch((err) =>
              log(`[weixin] notifyStart failed for ${account.id}: ${err}`),
            );
        }
        log(`[rpc] 已重启 ${pollers.length} 个轮询器`);

        return; // Success — reconnect complete
      } catch (err) {
        log(
          `[rpc] 重连失败 (${attempt}/${maxRetries}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ── Exhausted retries ──────────────────────────────────────────────
    log(`[rpc] 重连失败，已达最大重试次数 (${maxRetries})，退出。`);
    process.exit(1);
  }

  // ── Spawn initial Pi RPC subprocess ──────────────────────────────────
  log("正在启动 Pi RPC 子进程...");

  try {
    const initialClient = new RpcClient();
    await initialClient.spawn();
    rpcClient = initialClient;
    bindRpcEvents(initialClient);

    log(
      `Pi RPC 子进程已启动 (PID: ${(initialClient as any).proc?.pid ?? "unknown"})`,
    );
  } catch (err) {
    log(
      `启动 Pi RPC 子进程失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // ── Start Pollers ────────────────────────────────────────────────────

  for (const account of accounts) {
    const poller = new Poller(api, account, onMessage, onPollLog);
    poller.start();
    pollers.push(poller);

    // Notify WeChat backend that this bot is online
    api
      .notifyStart(account.botToken, account.baseUrl)
      .then(() => log(`[weixin] notifyStart OK for ${account.id}`))
      .catch((err) => log(`[weixin] notifyStart failed for ${account.id}: ${err}`));
  }

  log(`${pollers.length} 个轮询器已启动`);

  // ── Graceful Shutdown ────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`收到 ${signal}，正在优雅关闭...`);

    // Stop all pollers
    for (const poller of pollers) {
      poller.stop();
    }
    log("所有轮询器已停止");

    // Notify backend that we're going offline
    for (const account of accounts) {
      try {
        await api.notifyStop(account.botToken, account.baseUrl);
        log(`[weixin] notifyStop OK for ${account.id}`);
      } catch {
        // Best effort
      }
    }

    // Kill Pi subprocess (if still running)
    if (rpcClient && rpcClient.isRunning) {
      rpcClient.kill();
      log("已发送 SIGTERM 到 Pi 子进程");
    }

    // Give a short grace period for cleanup, then exit
    setTimeout(() => {
      log("退出。");
      process.exit(0);
    }, 2000).unref();
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => {});
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => {});
  });

  log("pi-weixin-cli RPC 模式已启动，等待微信消息...");
}

// ── Entry ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "daemon") {
    await runDaemon();
  } else {
    const exitCode = await runCLI(args);
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(`致命错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// ── Weixin ↔ Pi Message Bridge ─────────────────────────────────────────
// Manages the two-way message flow:
//   WeChat message → inject via pi.sendUserMessage() → capture assistant reply → send back
//
// Queue discipline (FIFO per account):
//   - Pi idle  → inject immediately (triggers new agent turn)
//   - Pi busy  → queue, inject next at agent_end
//   - agent_end → extract reply, send to WeChat, check queue

import { WeixinApi } from "./api.js";
import { saveContextToken } from "./storage.js";
import type {
  WeixinAccount,
  WeixinMessage,
  QueuedWeixinMessage,
} from "./types.js";
import { MessageItemType, MessageType, MessageState } from "./types.js";
import crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────

/** Minimal Pi ExtensionAPI interface used by the bridge. */
interface PiAPI {
  sendUserMessage(
    text: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
}

export type LogCallback = (msg: string) => void;

// ── Constants ──────────────────────────────────────────────────────────

const BOT_AGENT = "pi-weixin-cli/0.1.0";

// ── Bridge ─────────────────────────────────────────────────────────────

export class WeixinBridge {
  private readonly pi: PiAPI;
  private readonly api: WeixinApi;
  private readonly log?: LogCallback;

  /** Queue of messages waiting to be injected into Pi. */
  private readonly messageQueue: QueuedWeixinMessage[] = [];

  /** Context of the currently-injected WeChat message (if any). */
  private pendingContext: {
    account: WeixinAccount;
    userId: string;
    contextToken: string;
    sessionId: string;
  } | null = null;

  /** True while a WeChat message is being processed (injected → reply sent). */
  private processingWeixin = false;

  /** Whether Pi's agent is currently idle (not streaming). */
  private _isAgentIdle = true;

  /** Whether the bridge is accepting new messages. */
  private _enabled = true;

  constructor(pi: PiAPI, api: WeixinApi, log?: LogCallback) {
    this.pi = pi;
    this.api = api;
    this.log = log;
  }

  // ── State Accessors ──────────────────────────────────────────────────

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(val: boolean) {
    this._enabled = val;
    if (!val) {
      // Clear queue and pending state
      this.messageQueue.length = 0;
      this.processingWeixin = false;
      this.pendingContext = null;
    }
  }

  get isAgentIdle(): boolean {
    return this._isAgentIdle;
  }

  set isAgentIdle(val: boolean) {
    this._isAgentIdle = val;
  }

  get isProcessingWeixin(): boolean {
    return this.processingWeixin;
  }

  /**
   * Called by the Poller when a new WeChat message arrives.
   * Injects into Pi immediately if idle, otherwise queues.
   */
  onWeixinMessage(
    account: WeixinAccount,
    msg: WeixinMessage,
    text: string,
  ): void {
    if (!this._enabled) return;

    const userId = msg.from_user_id ?? "";
    const contextToken = msg.context_token ?? "";
    const sessionId = msg.session_id ?? "";

    // Save context token immediately when receiving a message
    // (must be echoed verbatim in outbound replies for this user session)
    if (userId && contextToken) {
      saveContextToken(account.id, userId, contextToken);
    }

    if (!this.processingWeixin && this._isAgentIdle) {
      // Pi is idle — inject now
      this.log?.(`[weixin] 收到消息，Pi 空闲，立即注入: ${text.slice(0, 60)} | session_id=${sessionId || "(none)"} ctx=${contextToken.slice(0,20)}...`);
      this.injectMessage(account, userId, contextToken, sessionId, text);
    } else {
      // Pi busy or already processing a WeChat message — queue
      this.log?.(`[weixin] Pi 忙碌，消息入队: ${text.slice(0, 60)}`);
      this.messageQueue.push({ account, userId, contextToken, sessionId, text });
    }
  }

  /**
   * Handle agent_end event from Pi.
   * If a WeChat message was processed, send the assistant's reply back to WeChat.
   * Then check the queue for the next message.
   */
  async handleAgentEnd(messages: unknown[] | undefined): Promise<void> {
    if (this.pendingContext !== null) {
      const ctx = this.pendingContext;
      this.pendingContext = null;

      // Use the latest context_token from storage if available,
      // falling back to the one captured at receipt time.
      const token = ctx.contextToken;

      const reply = extractAssistantReply(messages);
      if (reply) {
        this.log?.(
          `[weixin] 发送回复 (${reply.length} 字符)`,
        );
        await this.sendReply(ctx.account, ctx.userId, token, ctx.sessionId, reply);
      }

      // Mark this WeChat turn as complete
      this.processingWeixin = false;
    }

    // Process the queue
    this.flushQueue();
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Inject a WeChat message into Pi as a user message.
   * If Pi is still processing, fall back to deliverAs: "steer" so the message
   * is queued for delivery after the current turn finishes.
   */
  private injectMessage(
    account: WeixinAccount,
    userId: string,
    contextToken: string,
    sessionId: string,
    text: string,
  ): void {
    this.processingWeixin = true;
    this.pendingContext = { account, userId, contextToken, sessionId };

    try {
      this.pi.sendUserMessage(text);
      this.log?.(`[weixin] 已注入 Pi session`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already processing") || msg.includes("streamingBehavior") || msg.includes("steer")) {
        try {
          this.pi.sendUserMessage(text, { deliverAs: "steer" });
          this.log?.(`[weixin] 已注入 Pi session (steer)`);
          return;
        } catch (err2) {
          this.log?.(`[weixin] steer 注入也失败: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      } else {
        this.log?.(`[weixin] 注入失败: ${msg}`);
      }
    }

    // Injection failed — reset state and re-queue for retry
    this.processingWeixin = false;
    this.pendingContext = null;
    this.messageQueue.unshift({ account, userId, contextToken, sessionId, text });
    this.log?.(`[weixin] 消息已重新入队等待重试`);
  }

  /**
   * Send a text reply back to a WeChat user.
   */
  private async sendReply(
    account: WeixinAccount,
    toUserId: string,
    contextToken: string,
    sessionId: string,
    replyText: string,
  ): Promise<void> {
    try {
      const resp = await this.api.sendMessage(
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

      // Log raw response + request body for debugging
      const status = (resp as any).__status ?? "unknown";
      const rawResp = (resp as any).__raw ?? JSON.stringify(resp);
      const reqBody = (resp as any).__reqBody ?? "(not captured)";
      this.log?.(`[weixin] sendMessage HTTP ${status}`);
      this.log?.(`[weixin] sendMessage raw: ${rawResp.slice(0, 300)}`);
      this.log?.(`[weixin] sendMessage body: ${reqBody.slice(0, 500)}`);
    } catch (err) {
      this.log?.(
        `[weixin] 回复发送失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Process the message queue. Injects the next queued message if any.
   * Uses setImmediate to give Pi time to finish its state transition
   * before the next injection (prevents "Agent is already processing" errors).
   */
  private flushQueue(): void {
    if (
      !this._enabled ||
      this.processingWeixin ||
      this.messageQueue.length === 0
    ) {
      return;
    }

    const next = this.messageQueue.shift()!;
    this.log?.(`[weixin] 队列有 ${this.messageQueue.length + 1} 条消息，延迟注入下一条`);
    setImmediate(() => {
      this.injectMessage(next.account, next.userId, next.contextToken, next.sessionId, next.text);
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract the assistant's text reply from Pi's agent_end messages array.
 * Looks for the last assistant message's text content.
 */
function extractAssistantReply(messages: unknown[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;

  // Find the last assistant message (safe property access, no type assertions)
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

// ── getUpdates Long-Poll Engine ────────────────────────────────────────
// Continuously polls the getUpdates endpoint to receive new WeChat messages.
// Each account gets its own poller instance.

import { WeixinApi } from "./api.js";
import { loadSyncState, updateSyncBuf } from "./storage.js";
import type { WeixinAccount, WeixinMessage, ImageItem, FileItem, VoiceItem, VideoItem } from "./types.js";
import { MessageItemType } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

export type MessageCallback = (
  account: WeixinAccount,
  msg: WeixinMessage,
  text: string,
  imageItem?: ImageItem,
  fileItem?: FileItem,
  voiceItem?: VoiceItem,
  videoItem?: VideoItem,
) => void;

export type LogCallback = (msg: string) => void;

// ── Poller ─────────────────────────────────────────────────────────────

const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 2_000;

export class Poller {
  private readonly api: WeixinApi;
  private readonly account: WeixinAccount;
  private readonly onMessage: MessageCallback;
  private readonly log?: LogCallback;

  private controller: AbortController | null = null;
  private running = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  /** Timeout for the next getUpdates call, adjusted per server suggestion. */
  private currentPollTimeoutMs = 65_000;

  constructor(
    api: WeixinApi,
    account: WeixinAccount,
    onMessage: MessageCallback,
    log?: LogCallback,
  ) {
    this.api = api;
    this.account = account;
    this.onMessage = onMessage;
    this.log = log;
  }

  get accountId(): string {
    return this.account.id;
  }

  /** Start the poll loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.backoffMs = INITIAL_BACKOFF_MS;

    this.log?.(`[${this.account.id}] 开始轮询微信消息`);
    this.pollLoop().catch((err) => {
      this.log?.(`[${this.account.id}] 轮询异常退出: ${err}`);
    });
  }

  /** Stop the poll loop gracefully. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    this.log?.(`[${this.account.id}] 轮询已停止`);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async pollLoop(): Promise<void> {
    const signal = this.controller!.signal;
    let getUpdatesBuf = loadSyncState(this.account.id).getUpdatesBuf;

    while (!signal.aborted) {
      try {
        const resp = await this.api.getUpdates(
          { get_updates_buf: getUpdatesBuf },
          this.account.botToken,
          this.account.baseUrl,
          this.currentPollTimeoutMs,
        );

        // Reset backoff on successful response
        this.backoffMs = INITIAL_BACKOFF_MS;

        // Use server-suggested timeout for next poll, with reasonable bounds
        if (typeof resp.longpolling_timeout_ms === "number" && resp.longpolling_timeout_ms > 0) {
          this.currentPollTimeoutMs = Math.min(
            Math.max(resp.longpolling_timeout_ms + 5000, 10_000),
            120_000,
          );
        }

        // Handle API error codes
        if (resp.ret !== undefined && resp.ret !== 0) {
          if (resp.errcode === -14) {
            // Session timeout — reset sync buf
            this.log?.(`[${this.account.id}] 会话超时，重置同步游标`);
            getUpdatesBuf = "";
            updateSyncBuf(this.account.id, "");
            continue;
          }
          this.log?.(`[${this.account.id}] API 返回 ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          // Continue polling — errors are often recoverable
        }

        // Update sync buf
        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          updateSyncBuf(this.account.id, getUpdatesBuf);
        }

        // Process messages
        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            // Skip messages from self (bot messages we sent)
            if (msg.message_type === 2) continue;

            const text = extractText(msg);
            const voiceText = extractVoiceText(msg);
            const voiceItem = extractVoice(msg);
            const videoItem = extractVideo(msg);
            const imageItem = extractImage(msg);
            const fileItem = extractFile(msg);

            // Combine text and voice transcript; prefer explicit text, fallback to voice
            let messageText = text || "";
            if (voiceText) {
              messageText = messageText
                ? `${messageText}\n\n[语音消息] ${voiceText}`
                : `[语音消息] ${voiceText}`;
            }

            // Deliver if there is text, an image, a file, a voice, or a video
            if (messageText || imageItem || fileItem || voiceItem || videoItem) {
              this.onMessage(this.account, msg, messageText, imageItem, fileItem, voiceItem, videoItem);
            }
          }
        }
      } catch (err: unknown) {
        if (signal.aborted) break;

        const errMsg = err instanceof Error ? err.message : String(err);
        this.log?.(`[${this.account.id}] 轮询错误: ${errMsg}`);

        // Backoff and retry
        await this.backoff(signal);
        if (signal.aborted) break;
      }
    }
  }

  /** Exponential backoff with jitter, capped at MAX_BACKOFF_MS. */
  private async backoff(signal: AbortSignal): Promise<void> {
    const jitter = Math.random() * 0.3 + 0.85; // 85%–115%
    const delayMs = Math.min(this.backoffMs * jitter, MAX_BACKOFF_MS);

    await sleep(delayMs, signal);

    // Exponential backoff for next attempt
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

/** Extract the first text content from a Weixin message's item list. */
function extractText(msg: WeixinMessage): string | null {
  if (!msg.item_list || msg.item_list.length === 0) return null;
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
  }
  return null;
}

/** Extract the first image item from a Weixin message's item list. */
function extractImage(msg: WeixinMessage): ImageItem | undefined {
  if (!msg.item_list || msg.item_list.length === 0) return undefined;
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.IMAGE && item.image_item) {
      return item.image_item;
    }
  }
  return undefined;
}

/** Extract the first file item from a Weixin message's item list. */
function extractFile(msg: WeixinMessage): FileItem | undefined {
  if (!msg.item_list || msg.item_list.length === 0) return undefined;
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.FILE && item.file_item) {
      return item.file_item;
    }
  }
  return undefined;
}

/** Extract the first voice item from a Weixin message's item list. */
function extractVoice(msg: WeixinMessage): VoiceItem | undefined {
  if (!msg.item_list || msg.item_list.length === 0) return undefined;
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.VOICE && item.voice_item) {
      return item.voice_item;
    }
  }
  return undefined;
}

/** Extract the first video item from a Weixin message's item list. */
function extractVideo(msg: WeixinMessage): VideoItem | undefined {
  if (!msg.item_list || msg.item_list.length === 0) return undefined;
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.VIDEO && item.video_item) {
      return item.video_item;
    }
  }
  return undefined;
}

/** Extract voice-to-text transcript from a Weixin message's item list. */
function extractVoiceText(msg: WeixinMessage): string | null {
  if (!msg.item_list || msg.item_list.length === 0) return null;
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

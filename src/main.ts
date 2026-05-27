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
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { WeixinApi } from "./api.js";
import { Poller, type MessageCallback, type LogCallback } from "./poller.js";
import { RpcClient } from "./rpc-client.js";
import { loadAccounts, saveContextToken, loadContextTokens } from "./storage.js";
import { loadConfig } from "./config.js";
import type { WeixinAccount, ImageItem, FileItem, VoiceItem, VideoItem } from "./types.js";
import { MessageItemType, MessageType, MessageState } from "./types.js";
import type { AgentEndEvent, ExtensionUIRequestEvent } from "./types-rpc.js";
import { saveImageLocally, saveFileLocally, saveVoiceLocally, saveVideoLocally } from "./media-handler.js";
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
  /** Optional file item from the WeChat message. */
  fileItem?: FileItem;
  /** Optional voice item from the WeChat message. */
  voiceItem?: VoiceItem;
  /** Optional video item from the WeChat message. */
  videoItem?: VideoItem;
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
  const ts = toLocalISOString(new Date());
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function toLocalISOString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, "0")}${tz}`;
}

// ── Slash Command Type ─────────────────────────────────────────────────

interface SlashCommand {
  command: string;
  args: string;
}

interface BashCommand {
  command: string;
}

// ── Daemon ─────────────────────────────────────────────────────────────

async function runDaemon(): Promise<void> {
  log("pi-weixin-cli RPC 模式启动中...");
  const daemonCwd = process.cwd();

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
    log("账号文件位于: ~/.config/pi-weixin-cli/accounts.json");
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

  /** Pending session selections: userId → sessions array (for /resume flow). */
  const pendingResumeSelections = new Map<
    string,
    { path: string; label: string }[]
  >();

  /** Pending fork selections: userId → fork messages array (for /fork flow). */
  const pendingForkSelections = new Map<
    string,
    { entryId: string; text: string }[]
  >();

  // ── Session listing helper ─────────────────────────────────────────

  /** Scan ~/.pi/agent/sessions/ and return the most recent N sessions. */
  /**
   * Read the first 16KB of a session file to extract a human-readable title.
   * Returns the session name (set_session_name), first user message, or null.
   */
  function extractSessionTitle(filePath: string): string | null {
    const BUF_SIZE = 16384;
    const buf = Buffer.alloc(BUF_SIZE);
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const bytesRead = fs.readSync(fd, buf, 0, BUF_SIZE, 0);
      const raw = buf.toString("utf-8", 0, bytesRead);

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          // Prefer explicit session name
          if (entry.type === "set_session_name" && entry.name) return entry.name;
          // Fall back to first user message
          if (entry.type === "message" && entry.message?.role === "user") {
            const content = entry.message.content;
            if (Array.isArray(content) && content.length > 0) {
              const first = content[0];
              if (first?.type === "text" && first.text) {
                return first.text.replace(/\n/g, " ").slice(0, 60);
              }
            }
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* file read error */
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return null;
  }

  /** Scan ~/.pi/agent/sessions/ and return the most recent N sessions. */
  function listRecentSessions(limit = 10): { path: string; label: string }[] {
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
    const entries: { path: string; mtime: number; label: string }[] = [];

    try {
      for (const project of fs.readdirSync(sessionsDir)) {
        const projectDir = path.join(sessionsDir, project);
        let isDir = false;
        try { isDir = fs.statSync(projectDir).isDirectory(); } catch { continue; }
        if (!isDir) continue;

        for (const file of fs.readdirSync(projectDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(projectDir, file);
          let fileStat: fs.Stats;
          try { fileStat = fs.statSync(filePath); } catch { continue; }

          // Parse filename timestamp: "2026-05-27T11-13-09-592Z_uuid.jsonl"
          const tsMatch = file.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
          const shortTs = tsMatch
            ? `${tsMatch[1]}-${tsMatch[2]} ${tsMatch[3]}:${tsMatch[4]}`
            : file.slice(0, 20);

          const title = extractSessionTitle(filePath);
          const displayTitle = title ?? "(无标题)";

          entries.push({
            path: filePath,
            mtime: fileStat.mtimeMs,
            label: `${shortTs}  ${displayTitle}  [${project}]`,
          });
        }
      }
    } catch {
      return [];
    }

    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, limit);
  }

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

  /** Parse a bash command from message text. Returns null if not a command. */
  function parseBashCommand(text: string): BashCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("!")) return null;
    return { command: trimmed.startsWith("!!") ? trimmed.slice(2).trim() : trimmed.slice(1).trim() };
  }

  /** Format session state into a human-readable text block. */
  /** Format a number of tokens in compact form: 75000 → "75.0k", 3000000 → "3.0M". */
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  /** Read the session JSONL file's first event to extract cwd. */
  function getSessionCwd(sessionFile: string): string | null {
    try {
      const fd = fs.openSync(sessionFile, "r");
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString("utf-8", 0, n).split("\n")[0];
      const entry = JSON.parse(firstLine);
      return (entry.cwd as string) ?? null;
    } catch {
      return null;
    }
  }

  function formatSessionState(state: unknown, stats?: unknown): string {
    const lines: string[] = [];
    let autoCompactTag = "";

    // ── Header: model + thinking ────────────────────────────────────
    if (state !== null && typeof state === "object") {
      const s = state as Record<string, unknown>;
      const model = s.model as Record<string, unknown> | string | undefined;
      const modelName = typeof model === "string"
        ? model
        : (model?.name ?? model?.id ?? "?") as string;
      const thinking = (s.thinkingLevel ?? "?") as string;
      const msgCount = s.messageCount !== undefined ? ` · ${s.messageCount}msgs` : "";
      autoCompactTag = s.autoCompactionEnabled ? "(auto)" : "";

      // Get cwd from session file (first JSONL event), fallback to daemon cwd
      const sessionFile = s.sessionFile as string | undefined;
      const cwd = sessionFile ? (getSessionCwd(sessionFile) ?? daemonCwd) : daemonCwd;

      lines.push(`📊 ${modelName} · ${thinking}${msgCount}` + (cwd ? ` · ${cwd}` : ""));
    } else {
      lines.push("📊 Session 状态");
    }

    // ── Stats line: ↑input ↓output Rremaining $cost percent%/window ──
    if (stats !== null && typeof stats === "object") {
      const st = stats as Record<string, unknown>;
      const tokens = st.tokens as Record<string, number> | undefined;
      const ctx = st.contextUsage as Record<string, unknown> | undefined;

      if (tokens) {
        const input = tokens.input ?? 0;
        const output = tokens.output ?? 0;
        const total = tokens.total ?? 0;
        const cost = (st.cost as number) ?? 0;

        const statsParts: string[] = [];
        statsParts.push(`↑${fmtTokens(input)}`);
        statsParts.push(`↓${fmtTokens(output)}`);

        if (ctx) {
          const ctxWindow = ctx.contextWindow as number;
          const ctxPercent = ctx.percent as number | null;
          if (ctxWindow) {
            const remaining = ctxWindow - (tokens.input + tokens.cacheWrite + tokens.output);
            statsParts.push(`R${fmtTokens(Math.max(0, remaining))}`);
          }
          if (ctxPercent !== null && ctxPercent !== undefined) {
            statsParts.push(`${ctxPercent.toFixed(1)}%/${fmtTokens(ctxWindow)}`);
          }
        }

        statsParts.push(cost === 0 ? "$0" : `$${cost.toFixed(2)}`);
        if (autoCompactTag) statsParts.push(autoCompactTag);
        lines.push(statsParts.join(" "));
      }
    }

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
          const result = (await rpcClient.newSession()) as { cancelled?: boolean } | null;
          const cancelled = result?.cancelled;
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            cancelled ? "⚠️ 新建 session 被取消" : "✅ 已新建 session");
          log(`[slash] /new (user=${userId})`);
          break;
        }

        case "compact": {
          const result = (await rpcClient.compact(cmd.args || undefined)) as { summary?: string } | null;
          const summary = result?.summary ? `\n\n摘要: ${result.summary.slice(0, 200)}` : "";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 上下文已压缩${summary}`);
          log(`[slash] /compact (user=${userId})`);
          break;
        }

        case "abort": {
          rpcClient.sendAbort();
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 已中止当前任务");
          log(`[slash] /abort (user=${userId})`);
          break;
        }

        case "session": {
          const [state, stats] = await Promise.all([
            rpcClient.getState(),
            rpcClient.getSessionStats().catch(() => null),
          ]);
          const formatted = formatSessionState(state, stats);
          await sendWeixinReply(api, account, userId, contextToken, sessionId, formatted);
          log(`[slash] /session (user=${userId})`);
          break;
        }

        case "messages": {
          const result = (await rpcClient.getMessages()) as { messages?: unknown[] } | null;
          const messages = result?.messages ?? [];
          if (messages.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "📭 当前 session 没有消息");
            return;
          }
          const lines: string[] = [`📋 最近 ${Math.min(messages.length, 20)} 条消息：`];
          const recent = messages.slice(-20);
          for (const msg of recent) {
            const m = msg as Record<string, unknown>;
            const role = (m.role ?? "unknown") as string;
            let text = "";
            const content = m.content;
            if (Array.isArray(content)) {
              const first = content[0] as Record<string, unknown> | undefined;
              text = (first?.text ?? first?.data ?? "") as string;
            } else if (typeof content === "string") {
              text = content;
            }
            text = text.replace(/\n/g, " ").slice(0, 60);
            lines.push(`[${role}] ${text || "(无文本)"}`);
          }
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /messages (user=${userId}, count=${messages.length})`);
          break;
        }

        case "export": {
          const result = (await rpcClient.exportHtml(cmd.args || undefined)) as { path?: string } | null;
          const exportPath = result?.path ?? "(未知路径)";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Session 已导出\n📄 ${exportPath}`);
          log(`[slash] /export → ${exportPath} (user=${userId})`);
          break;
        }

        case "clone": {
          const result = (await rpcClient.clone()) as { cancelled?: boolean } | null;
          const cancelled = result?.cancelled;
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            cancelled ? "⚠️ 克隆被取消" : "✅ 已克隆当前 session");
          log(`[slash] /clone (user=${userId})`);
          break;
        }

        case "last": {
          const result = (await rpcClient.getLastAssistantText()) as { text?: string | null } | null;
          const text = result?.text ?? "(无 assistant 回复)";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `🤖 最后一条回复:\n\n${text}`);
          log(`[slash] /last (user=${userId})`);
          break;
        }

        case "cycle-model": {
          const result = (await rpcClient.cycleModel()) as { model?: { name?: string; id?: string } } | null;
          const modelName = result?.model?.name ?? result?.model?.id ?? "未知模型";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 已切换模型: ${modelName}`);
          log(`[slash] /cycle-model → ${modelName} (user=${userId})`);
          break;
        }

        case "thinking": {
          if (cmd.args) {
            await rpcClient.setThinkingLevel(cmd.args);
            await sendWeixinReply(api, account, userId, contextToken, sessionId,
              `✅ Thinking level 已设置为: ${cmd.args}`);
            log(`[slash] /thinking ${cmd.args} (user=${userId})`);
          } else {
            const result = (await rpcClient.cycleThinkingLevel()) as { level?: string } | null;
            const level = result?.level ?? "未知";
            await sendWeixinReply(api, account, userId, contextToken, sessionId,
              `✅ Thinking level 已切换为: ${level}`);
            log(`[slash] /thinking cycle → ${level} (user=${userId})`);
          }
          break;
        }

        case "steer-mode": {
          const mode = cmd.args || "one-at-a-time";
          await rpcClient.setSteeringMode(mode);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Steering mode 已设置为: ${mode}`);
          log(`[slash] /steer-mode ${mode} (user=${userId})`);
          break;
        }

        case "follow-mode": {
          const mode = cmd.args || "one-at-a-time";
          await rpcClient.setFollowUpMode(mode);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Follow-up mode 已设置为: ${mode}`);
          log(`[slash] /follow-mode ${mode} (user=${userId})`);
          break;
        }

        case "auto-compact": {
          const enabled = cmd.args === "on" || cmd.args === "true";
          await rpcClient.setAutoCompaction(enabled);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 自动压缩已${enabled ? "开启" : "关闭"}`);
          log(`[slash] /auto-compact ${enabled} (user=${userId})`);
          break;
        }

        case "auto-retry": {
          const enabled = cmd.args === "on" || cmd.args === "true";
          await rpcClient.setAutoRetry(enabled);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 自动重试已${enabled ? "开启" : "关闭"}`);
          log(`[slash] /auto-retry ${enabled} (user=${userId})`);
          break;
        }

        case "abort-retry": {
          await rpcClient.abortRetry();
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 已中止重试");
          log(`[slash] /abort-retry (user=${userId})`);
          break;
        }

        case "name": {
          if (!cmd.args) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 用法: /name <session名称>");
            return;
          }
          await rpcClient.setSessionName(cmd.args);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Session 名称已设置为: ${cmd.args}`);
          log(`[slash] /name ${cmd.args} (user=${userId})`);
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
          log(`[slash] /model → ${models.length} 个模型 (user=${userId})`);
          break;
        }

        case "resume": {
          const sessions = listRecentSessions(10);
          if (sessions.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 未找到历史 session");
            return;
          }
          pendingResumeSelections.set(userId, sessions);
          const lines = ["📋 最近 session："];
          sessions.forEach((s, i) => {
            lines.push(`${i + 1}. ${s.label}`);
          });
          lines.push("", "回复数字编号恢复 session");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /resume → ${sessions.length} 个 session (user=${userId})`);
          break;
        }

        case "fork": {
          const result = (await rpcClient.getForkMessages()) as { messages?: { entryId: string; text: string }[] } | null;
          const messages = result?.messages ?? [];
          if (messages.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 没有可 fork 的消息");
            return;
          }
          pendingForkSelections.set(userId, messages);
          const lines = ["📋 可 fork 的消息："];
          messages.forEach((m, i) => {
            const preview = m.text.replace(/\n/g, " ").slice(0, 60);
            lines.push(`${i + 1}. ${preview || "(空消息)"}`);
          });
          lines.push("", "回复数字编号选择 fork 起点");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /fork → ${messages.length} 条消息 (user=${userId})`);
          break;
        }

        case "help": {
          const helpText = [
            "📋 可用命令：",
            "/new — 新建 session",
            "/compact [instructions] — 压缩上下文",
            "/abort — 中止当前任务",
            "/session — 查看 session 状态",
            "/messages — 查看对话消息",
            "/export [path] — 导出 session 为 HTML",
            "/resume — 恢复历史 session",
            "/model — 切换模型",
            "/cycle-model — 轮播模型",
            "/thinking [level] — 设置/切换 thinking level",
            "/steer-mode <mode> — 设置 steering 模式",
            "/follow-mode <mode> — 设置 follow-up 模式",
            "/auto-compact <on|off> — 自动压缩开关",
            "/auto-retry <on|off> — 自动重试开关",
            "/abort-retry — 中止重试",
            "/clone — 克隆当前 session",
            "/fork — 从历史消息 fork",
            "/last — 最后一条 assistant 回复",
            "/name <name> — 设置 session 名称",
            "/help — 显示此帮助",
            "",
            "Pi 扩展命令也可以直接发送，如 /skill:xxx",
          ].join("\n");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, helpText);
          log(`[slash] /help (user=${userId})`);
          break;
        }

        default: {
          // 未知命令 —— 通用转发给 Pi
          const fullCmd = cmd.args ? `/${cmd.command} ${cmd.args}` : `/${cmd.command}`;
          if (rpcClient.isStreaming) {
            rpcClient.sendPromptSteer(fullCmd);
          } else {
            rpcClient.sendPrompt(fullCmd);
          }
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 已转发: ${fullCmd}`);
          log(`[slash] 通用转发: ${fullCmd} (user=${userId})`);
          break;
        }
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

  /**
   * Execute a shell command via Pi's RPC bash tool and reply the output to the WeChat user.
   * The bash result is automatically stored as a BashExecutionMessage in Pi's message state
   * and will be included in the LLM context on the next prompt (same as TUI `!` behavior).
   */
  async function handleBashCommand(
    cmd: BashCommand,
    account: WeixinAccount,
    userId: string,
    contextToken: string,
    sessionId: string,
  ): Promise<void> {
    if (!rpcClient) return;

    try {
      const result = (await rpcClient.sendBash(cmd.command)) as {
        output: string;
        exitCode: number;
        cancelled: boolean;
        truncated: boolean;
        fullOutputPath?: string;
      };

      let outputText = result.output ?? "";
      if (result.truncated && result.fullOutputPath) {
        outputText += `\n\n(输出已截断，完整日志: ${result.fullOutputPath})`;
      }

      const exitEmoji = result.exitCode === 0 ? "✅" : `❌ (exit ${result.exitCode})`;
      const cancelledTag = result.cancelled ? " ⏹️ 已取消" : "";

      // Reply to WeChat user with command output
      const userReply = `${exitEmoji} \`${cmd.command}\`${cancelledTag}\n\`\`\`\n${outputText}\n\`\`\``;
      await sendWeixinReply(api, account, userId, contextToken, sessionId, userReply);


    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`[bash] 执行失败: ${errMsg}`);
      await sendWeixinReply(
        api,
        account,
        userId,
        contextToken,
        sessionId,
        `❌ 命令执行失败: ${errMsg}`,
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

  const onMessage: MessageCallback = (account, msg, text, imageItem, fileItem, voiceItem, videoItem) => {
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

    // ── Pending resume selection check (for /resume flow) ──────────
    const pendingSessions = pendingResumeSelections.get(userId);
    if (pendingSessions) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= pendingSessions.length) {
        pendingResumeSelections.delete(userId);
        const session = pendingSessions[num - 1];

        void (async () => {
          try {
            const result = (await rpcClient!.switchSession(session.path)) as Record<string, unknown> | null;
            const cancelled = result?.data ? (result.data as Record<string, unknown>).cancelled : false;
            if (cancelled) {
              await sendWeixinReply(api, account, userId, latestToken, sessionId, "⚠️ Session 切换被取消");
            } else {
              await sendWeixinReply(
                api, account, userId, latestToken, sessionId,
                `✅ 已恢复 session: ${session.label}`,
              );
            }
            log(`[slash] session 已切换: ${session.path} (user=${userId})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`[slash] 切换 session 失败: ${errMsg}`);
            await sendWeixinReply(
              api, account, userId, latestToken, sessionId,
              `❌ 切换 session 失败: ${errMsg}`,
            ).catch(() => {});
          }
        })();
        return;
      }
      // Not a valid selection — clear pending and fall through
      pendingResumeSelections.delete(userId);
    }

    // ── Pending fork selection check (for /fork flow) ─────────────────
    const pendingForks = pendingForkSelections.get(userId);
    if (pendingForks) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= pendingForks.length) {
        pendingForkSelections.delete(userId);
        const forkMsg = pendingForks[num - 1];

        void (async () => {
          try {
            const result = (await rpcClient!.fork(forkMsg.entryId)) as { text?: string; cancelled?: boolean } | null;
            const cancelled = result?.cancelled;
            if (cancelled) {
              await sendWeixinReply(api, account, userId, latestToken, sessionId, "⚠️ Fork 被取消");
            } else {
              const preview = result?.text ? result.text.replace(/\n/g, " ").slice(0, 60) : "";
              await sendWeixinReply(
                api, account, userId, latestToken, sessionId,
                `✅ 已从消息 fork\n原文: ${preview || "(空)"}`,
              );
            }
            log(`[slash] fork 完成: ${forkMsg.entryId} (user=${userId})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`[slash] fork 失败: ${errMsg}`);
            await sendWeixinReply(
              api, account, userId, latestToken, sessionId,
              `❌ Fork 失败: ${errMsg}`,
            ).catch(() => {});
          }
        })();
        return;
      }
      // Not a valid selection — clear pending and fall through
      pendingForkSelections.delete(userId);
    }

    // ── Slash command detection ───────────────────────────────────────
    const slashResult = parseSlashCommand(text);
    if (slashResult) {
      void handleSlashCommand(slashResult, account, userId, latestToken, sessionId);
      return;
    }

    // ── Bash command detection (! / !!) ───────────────────────────────
    const bashResult = parseBashCommand(text);
    if (bashResult) {
      void handleBashCommand(bashResult, account, userId, latestToken, sessionId);
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
        fileItem,
        voiceItem,
        videoItem,
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
        fileItem,
        voiceItem,
        videoItem,
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

    let messageText = qm.text;
    let imagePath: string | null = null;

    // ── Image processing (save locally, give path to Pi) ────────────
    if (qm.imageItem) {
      try {
        log(`[weixin] 处理图片...`);
        const savedPath = await saveImageLocally(qm.imageItem);
        if (savedPath) {
          imagePath = savedPath;
          log(`[weixin] 图片已保存: ${savedPath}`);
        } else {
          log(`[weixin] 图片处理失败：无法获取图片 URL`);
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

    // Append image path to message text if present
    if (imagePath) {
      messageText += `\n\n[用户发送了一张图片]\n🖼️ ${imagePath}`;
    }

    // ── File processing (store locally, give path to Pi) ──────────────
    let filePath: string | null = null;
    if (qm.fileItem) {
      try {
        log(`[weixin] 处理文件...`);
        const savedPath = await saveFileLocally(qm.fileItem);
        if (savedPath) {
          filePath = savedPath;
          log(`[weixin] 文件已保存: ${savedPath}`);
        } else {
          log(`[weixin] 文件处理失败：无法获取下载 URL`);
        }
      } catch (err) {
        const fileName = qm.fileItem.file_name ?? "unknown";
        log(`[weixin] 文件处理异常 (${fileName}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append file path to message text if present
    if (filePath) {
      const fileName = qm.fileItem?.file_name ?? "unknown";
      messageText += `\n\n[用户发送了一个文件：${fileName}]\n📄 ${filePath}`;
    }

    // ── Voice processing (save locally, give path + transcript to Pi) ─
    let voicePath: string | null = null;
    if (qm.voiceItem) {
      try {
        log(`[weixin] 处理语音...`);
        const savedPath = await saveVoiceLocally(qm.voiceItem);
        if (savedPath) {
          voicePath = savedPath;
          log(`[weixin] 语音已保存: ${savedPath}`);
        } else {
          log(`[weixin] 语音处理失败：无法获取下载 URL`);
        }
      } catch (err) {
        log(`[weixin] 语音处理异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append voice path to message text if present
    if (voicePath) {
      messageText += `\n\n[用户发送了一条语音]\n🎤 ${voicePath}`;
    }

    // ── Video processing (save locally, give path to Pi) ────────────
    let videoPath: string | null = null;
    if (qm.videoItem) {
      try {
        log(`[weixin] 处理视频...`);
        const savedPath = await saveVideoLocally(qm.videoItem);
        if (savedPath) {
          videoPath = savedPath;
          log(`[weixin] 视频已保存: ${savedPath}`);
        } else {
          log(`[weixin] 视频处理失败：无法获取下载 URL`);
        }
      } catch (err) {
        log(`[weixin] 视频处理异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append video path to message text if present
    if (videoPath) {
      messageText += `\n\n[用户发送了一个视频]\n🎬 ${videoPath}`;
    }

    // Ensure message is not empty
    if (!messageText.trim()) {
      messageText = imagePath ? "[图片]" : filePath ? "[文件]" : voicePath ? "[语音]" : videoPath ? "[视频]" : "[空消息]";
    }

    const summary = messageText.slice(0, 60) || "[空消息]";
    const fileInfo = qm.fileItem ? ` + 文件: ${qm.fileItem.file_name ?? "unknown"}` : "";
    log(`[weixin] 发送 prompt: ${summary}${messageText.length > 60 ? "..." : ""}${imagePath ? ` + 图片: ${imagePath}` : ""}${voicePath ? ` + 语音: ${voicePath}` : ""}${videoPath ? ` + 视频: ${videoPath}` : ""}${fileInfo}`);
    rpcClient.sendPrompt(messageText);
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
      const aborted = event.aborted ?? false;
      const reply = extractAssistantReply(event.messages);
      const hasPending = pendingContext !== null;

      log(`[rpc] agent_end | aborted=${aborted} hasPending=${hasPending} hasReply=${!!reply}`);

      // If we were processing a WeChat message, send the reply back
      if (hasPending && pendingContext) {
        const ctx = pendingContext;
        pendingContext = null;

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
          // Notify user that Pi produced no output (likely a model/API issue)
          await sendWeixinReply(
            api,
            ctx.account,
            ctx.userId,
            ctx.contextToken,
            ctx.sessionId,
            "⚠️ Pi 未生成回复。可能是当前模型不支持此输入（如图片），或处理异常。可尝试切换模型。",
          ).catch(() => {});
        }

        processingWeixin = false;
      } else if (reply) {
        // Got a reply but no pending context — Pi retried after we cleared context
        log(`[weixin] 发现延迟回复但 pendingContext 已清空: ${reply.slice(0, 60)}...`);
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

// ── Weixin Backend HTTP API Client ─────────────────────────────────────
// Backend: https://ilinkai.weixin.qq.com
// Protocol: JSON over HTTP (POST for most endpoints, GET for QR status)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
  SendTypingResp,
  GetConfigResp,
  GetQRCodeResp,
  QRCodeStatusResp,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 65_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

// ── Package metadata (version + app id) ────────────────────────────────

interface PkgJson {
  version?: string;
  ilink_appid?: string;
}

function readOwnPackageJson(): PkgJson {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  let dir = __dirname;
  const { root } = path.parse(dir);
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf-8")) as PkgJson;
      } catch { /* continue walking */ }
    }
    dir = path.dirname(dir);
  }
  return {};
}

const pkg = readOwnPackageJson();
const CHANNEL_VERSION = pkg.version ?? "0.1.0";
const ILINK_APP_ID: string = pkg.ilink_appid ?? "";

function buildClientVersion(): number {
  const m = String(CHANNEL_VERSION).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 0;
  const major = Number(m[1]) & 0xFF;
  const minor = Number(m[2]) & 0xFF;
  const patch = Number(m[3]) & 0xFF;
  return (major << 16) | (minor << 8) | patch;
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion();

// ── Base Info ──────────────────────────────────────────────────────────

export function buildBaseInfo(): BaseInfo {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: "pi-weixin-cli/0.1.0",
  };
}

// ── Headers ────────────────────────────────────────────────────────────

/**
 * X-WECHAT-UIN header: random uint32 (big-endian) -> decimal string -> base64.
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * Build HTTP headers for authenticated API requests.
 */
function buildAuthHeaders(botToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    "AuthorizationType": "ilink_bot_token",
    "Authorization": `Bearer ${botToken}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

/**
 * Build minimal HTTP headers for unauthenticated requests (QR endpoints).
 */
function buildMinimalHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

// ── API Client ─────────────────────────────────────────────────────────

export class WeixinApi {
  readonly defaultBaseUrl: string;

  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.defaultBaseUrl = baseUrl;
  }

  /**
   * POST request to a Weixin API endpoint.
   */
  private async postJson<T>(
    endpoint: string,
    body: unknown,
    botToken?: string,
    baseUrlArg?: string,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${baseUrlArg ?? this.defaultBaseUrl}/${endpoint}`;
    const headers = botToken ? buildAuthHeaders(botToken) : buildMinimalHeaders();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_API_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET request to a Weixin API endpoint (used for QR status polling).
   */
  private async getJson<T>(
    endpoint: string,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.defaultBaseUrl}/${endpoint}`;
    const headers = buildMinimalHeaders();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_API_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── QR / Auth ──────────────────────────────────────────────────────

  /**
   * Fetch a QR code for WeChat login.
   * POST to ilink/bot/get_bot_qrcode?bot_type=...
   *
   * Response fields:
   *   - qrcode: opaque token used for status polling (pollQRCodeStatus)
   *   - qrcode_img_content: text content to display as QR code (for user to scan)
   */
  async getQRCode(botType = "3"): Promise<GetQRCodeResp> {
    return this.postJson<GetQRCodeResp>(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      { local_token_list: [] },
    );
  }

  /**
   * Poll QR code login status.
   * GET to ilink/bot/get_qrcode_status?qrcode=...
   * The server holds the request for up to ~35s (long-poll).
   *
   * @param qrcode - The raw `qrcode` value returned by getQRCode()
   */
  async pollQRCodeStatus(qrcode: string): Promise<QRCodeStatusResp> {
    return this.getJson<QRCodeStatusResp>(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      QR_LONG_POLL_TIMEOUT_MS,
    );
  }

  // ── Messaging ────────────────────────────────────────────────────────

  /**
   * Long-poll getUpdates. The server holds the connection until new messages
   * arrive or the timeout expires.
   */
  async getUpdates(
    req: GetUpdatesReq,
    botToken: string,
    baseUrlArg?: string,
    timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
  ): Promise<GetUpdatesResp> {
    return this.postJson<GetUpdatesResp>(
      "ilink/bot/getupdates",
      { ...req, base_info: buildBaseInfo() },
      botToken,
      baseUrlArg,
      timeoutMs,
    );
  }

  /** Send a message to a Weixin user. */
  async sendMessage(
    req: SendMessageReq,
    botToken: string,
    baseUrlArg?: string,
  ): Promise<SendMessageResp> {
    const body = { ...req, base_info: buildBaseInfo() };
    const url = `${baseUrlArg ?? this.defaultBaseUrl}/ilink/bot/sendmessage`;
    const headers = buildAuthHeaders(botToken);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const rawText = await resp.text();
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${rawText.slice(0, 300)}`);
      }
      const parsed = JSON.parse(rawText) as SendMessageResp;
      // Attach raw for diagnostics
      (parsed as any).__status = resp.status;
      (parsed as any).__raw = rawText;
      (parsed as any).__reqBody = JSON.stringify(body);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Config / Typing ──────────────────────────────────────────────────

  /** Get account configuration including typing ticket. */
  async getConfig(
    ilinkUserId: string,
    botToken: string,
    contextToken?: string,
    baseUrlArg?: string,
  ): Promise<GetConfigResp> {
    return this.postJson<GetConfigResp>(
      "ilink/bot/getconfig",
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: buildBaseInfo() },
      botToken,
      baseUrlArg,
    );
  }

  /** Send/release typing indicator. status: 1=typing, 2=cancel. */
  async sendTyping(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
    botToken: string,
    baseUrlArg?: string,
  ): Promise<SendTypingResp> {
    return this.postJson<SendTypingResp>(
      "ilink/bot/sendtyping",
      { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: buildBaseInfo() },
      botToken,
      baseUrlArg,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Notify the backend that this account has come online. */
  async notifyStart(
    botToken: string,
    baseUrlArg?: string,
  ): Promise<{ ret?: number }> {
    const body = { base_info: buildBaseInfo() };
    const url = `${baseUrlArg ?? this.defaultBaseUrl}/ilink/bot/msg/notifystart`;
    const headers = buildAuthHeaders(botToken);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const rawText = await resp.text();
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${rawText.slice(0, 300)}`);
      }
      const parsed = JSON.parse(rawText) as { ret?: number };
      (parsed as any).__raw = rawText;
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Notify the backend that this account is going offline. */
  async notifyStop(
    botToken: string,
    baseUrlArg?: string,
  ): Promise<{ ret?: number }> {
    return this.postJson<{ ret?: number }>(
      "ilink/bot/msg/notifystop",
      { base_info: buildBaseInfo() },
      botToken,
      baseUrlArg,
    );
  }
}

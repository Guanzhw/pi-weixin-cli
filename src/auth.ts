// ── QR Code Login ──────────────────────────────────────────────────────
// Flow:
//   1. call getQRCode() → receive QR data
//   2. display qrcode_img_content in terminal via qrcode-terminal
//   3. poll get_qrcode_status?qrcode=... (long-poll) until confirmed or expired
//   4. save account credentials
//
// Key difference from earlier implementations:
//   - The `qrcode` field from getQRCode response is an opaque token used for
//     status polling (passed as ?qrcode= query param).
//   - The `qrcode_img_content` field is the text to display as QR code.
//   - No URL param parsing needed — the API handles everything via opaque tokens.

import qrcode from "qrcode-terminal";
import { WeixinApi } from "./api.js";
import { registerAccount } from "./storage.js";
import type { WeixinAccount, QRCodeStatusResp, QRCodeStatus } from "./types.js";

export type LoginResult =
  | { success: true; account: WeixinAccount }
  | { success: false; error: string };

export interface LoginHooks {
  /** Called with the QR code string to display. */
  onDisplayQR?: (qrStr: string) => void;
  /** Called with status updates (e.g., "scanning...", "confirmed!"). */
  onStatus?: (msg: string) => void;
  /** Called when an error occurs during the flow. */
  onError?: (msg: string) => void;
}

/**
 * Wait for user to scan the QR code, then poll until confirmed.
 * The server holds the request for up to ~35s (long-poll).
 * After confirmed, the response contains botToken and userId.
 *
 * @param qrToken - The opaque `qrcode` token from getQRCode response, passed as ?qrcode= query param.
 */
async function pollLoginStatus(
  api: WeixinApi,
  qrToken: string,
  hooks: LoginHooks,
  signal?: AbortSignal,
): Promise<LoginResult> {
  const POLL_INTERVAL_BASE_MS = 3000; // delay between polls when no connection hold

  while (!signal?.aborted) {
    try {
      const resp: QRCodeStatusResp = await api.pollQRCodeStatus(qrToken);
      const status: QRCodeStatus = resp.status;

      hooks.onStatus?.(`扫码状态: ${status}`);

      switch (status) {
        case "confirmed": {
          if (!resp.bot_token || !resp.ilink_user_id) {
            return {
              success: false,
              error: "登录确认后服务器未返回 bot_token 或 user_id",
            };
          }
          const account: WeixinAccount = {
            id: resp.ilink_bot_id ?? resp.ilink_user_id,
            userId: resp.ilink_user_id,
            botToken: resp.bot_token,
            baseUrl: resp.baseurl ?? api.defaultBaseUrl,
            createdAt: Date.now(),
          };
          registerAccount(account);
          hooks.onStatus?.("登录成功！");
          return { success: true, account };
        }

        case "expired": {
          return { success: false, error: "二维码已过期，请重新运行登录命令" };
        }

        case "scaned_but_redirect": {
          hooks.onStatus?.(`扫码重定向至: ${resp.redirect_host ?? "未知"}`);
          // Continue polling — the server may redirect
          continue;
        }

        case "wait":
        case "scaned":
        case "need_verifycode":
        case "verify_code_blocked":
        case "binded_redirect": {
          // Continue polling
          continue;
        }

        default: {
          // Unknown status — continue polling with backoff
          await delay(POLL_INTERVAL_BASE_MS);
        }
      }
    } catch (err) {
      // Network or timeout error during poll — retry after backoff
      const msg = err instanceof Error ? err.message : String(err);
      hooks.onStatus?.(`轮询中断 (${msg})，正在重试...`);
      await delay(POLL_INTERVAL_BASE_MS);
    }
  }

  return { success: false, error: "登录流程被取消" };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Start the QR code login flow:
 * 1. Fetch QR code data from the backend
 * 2. Display the QR code image content in terminal
 * 3. Long-poll get_qrcode_status with the opaque `qrcode` token until confirmed or expired
 * 4. Save account credentials on success
 *
 * API flow (from OpenClaw reference):
 *   get_bot_qrcode → returns { qrcode (opaque token), qrcode_img_content (display text) }
 *   get_qrcode_status?qrcode=... → long-poll for scan status
 */
export async function startQRLogin(
  api: WeixinApi,
  hooks: LoginHooks,
  signal?: AbortSignal,
): Promise<LoginResult> {
  try {
    hooks.onStatus?.("正在获取登录二维码...");

    const qrResp = await api.getQRCode();
    const qrToken = qrResp.qrcode;
    const qrContent = qrResp.qrcode_img_content;

    if (!qrToken || !qrContent) {
      return { success: false, error: "获取二维码失败：响应中缺少必要字段" };
    }

    // Display QR code in terminal using qrcode_img_content
    return new Promise<LoginResult>((resolve) => {
      qrcode.generate(qrContent, { small: true }, (qrStr: string) => {
        hooks.onDisplayQR?.(qrStr);
        hooks.onStatus?.("请用微信扫描终端中的二维码以登录");

        // Start long-poll loop with the opaque qrcode token
        resolve(pollLoginStatus(api, qrToken, hooks, signal));
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    hooks.onError?.(`登录失败: ${msg}`);
    return { success: false, error: `登录失败: ${msg}` };
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

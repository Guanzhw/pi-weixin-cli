// ── Media Handler ──────────────────────────────────────────────────────
// Downloads, decrypts, and converts WeChat images into Pi's ImageContent
// format for transmission via the RPC prompt/steer commands.

import crypto from "node:crypto";
import type { WeixinMessage, ImageItem } from "./types.js";
import { MessageItemType } from "./types.js";
import type { ImageContent } from "./types-rpc.js";

// ── Constants ──────────────────────────────────────────────────────────

/** Maximum image size in bytes (10 MB). Larger images are rejected. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Download timeout in milliseconds. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Reasonable User-Agent for image downloads. */
const USER_AGENT = "pi-weixin-cli/1.0 (image downloader)";

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Extract image info from the first image item in a WeChat message.
 * Returns null if the message contains no image items.
 */
export function extractImageInfo(
  msg: WeixinMessage,
): {
  fullUrl?: string;
  thumbUrl?: string;
  aesKey?: string;
  encryptType?: number;
  mimeType?: string;
} | null {
  if (!msg.item_list || msg.item_list.length === 0) return null;

  for (const item of msg.item_list) {
    if (item.type !== MessageItemType.IMAGE || !item.image_item) continue;
    const img = item.image_item;

    // Priority: CDN media full_url → top-level url → thumb_media full_url
    const fullUrl = img.media?.full_url || img.url;
    const thumbUrl = img.thumb_media?.full_url;

    // Decryption info (from CDN media or top-level aeskey)
    const aesKey = img.media?.aes_key || img.aeskey;
    const encryptType = img.media?.encrypt_type;

    // Infer MIME type from URL extension
    const mimeType = fullUrl ? inferMimeType(fullUrl) : "image/jpeg";

    return { fullUrl, thumbUrl, aesKey, encryptType, mimeType };
  }

  return null;
}

/**
 * Download an image from a URL.
 * Supports HTTP redirects. Rejects if the response exceeds MAX_IMAGE_BYTES
 * or the download takes longer than DOWNLOAD_TIMEOUT_MS.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    // Check Content-Length if available
    const contentLength = resp.headers.get("content-length");
    if (contentLength) {
      const len = parseInt(contentLength, 10);
      if (!isNaN(len) && len > MAX_IMAGE_BYTES) {
        throw new Error(
          `图片过大 (${(len / 1024 / 1024).toFixed(1)}MB)，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
        );
      }
    }

    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `图片过大 (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB)，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
      );
    }

    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decrypt image data if it was encrypted by WeChat's CDN.
 *
 * If encryptType is 0 or undefined, the buffer is returned unchanged.
 * Otherwise, attempts AES-CBC decryption using the provided AES key.
 *
 * NOTE: WeChat CDN encryption details are not fully confirmed.
 * The implementation attempts a best-effort AES-128-CBC decryption
 * with the key treated as raw bytes (first 16 bytes). If decryption
 * fails, the original buffer is returned as a graceful degradation.
 *
 * TODO: Confirm the exact WeChat CDN encryption algorithm (key format,
 * IV derivation, cipher mode) and update accordingly.
 */
export async function decryptIfNeeded(
  buffer: Buffer,
  aesKey?: string,
  encryptType?: number,
): Promise<Buffer> {
  // No encryption or unknown type — return as-is
  if (!encryptType || encryptType === 0) return buffer;
  if (!aesKey) {
    // Encrypted but no key — can't decrypt, return raw (best-effort)
    return buffer;
  }

  try {
    // Attempt AES-128-CBC decryption.
    // Key: first 16 bytes of the base64-decoded or raw key.
    // IV: first 16 bytes of the ciphertext (typical WeChat pattern).
    let keyBytes: Buffer;
    try {
      keyBytes = Buffer.from(aesKey, "base64");
    } catch {
      keyBytes = Buffer.from(aesKey, "utf-8");
    }

    // Use first 16 bytes as key (AES-128)
    const key = keyBytes.subarray(0, 16);
    if (key.length < 16) {
      // Key too short, can't decrypt
      return buffer;
    }

    // IV is typically the first 16 bytes of the ciphertext in WeChat's scheme
    if (buffer.length < 16) return buffer;
    const iv = buffer.subarray(0, 16);
    const ciphertext = buffer.subarray(16);

    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(true);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted;
  } catch {
    // Decryption failed — return original buffer as fallback
    return buffer;
  }
}

/**
 * Convert a Buffer to Pi's ImageContent format.
 */
export function bufferToBase64(
  buffer: Buffer,
  mimeType: string,
): ImageContent {
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
  };
}

/**
 * End-to-end image processing for a WeChat ImageItem:
 *   extract URL → download → decrypt → base64 → ImageContent.
 *
 * Returns null if the image couldn't be processed (no valid URL, etc).
 */
export async function processImageForPi(
  img: ImageItem,
): Promise<ImageContent | null> {
  const fullUrl = img.media?.full_url || img.url;
  if (!fullUrl) return null;

  // Determine MIME type from URL or default
  const mimeType = inferMimeType(fullUrl);

  // Download
  const rawBuffer = await downloadImage(fullUrl);

  // Decrypt if needed
  const aesKey = img.media?.aes_key || img.aeskey;
  const encryptType = img.media?.encrypt_type;
  const decrypted = await decryptIfNeeded(rawBuffer, aesKey, encryptType);

  // Convert to base64 ImageContent
  return bufferToBase64(decrypted, mimeType);
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Infer MIME type from a URL's file extension (before query params).
 * Falls back to "image/jpeg".
 */
function inferMimeType(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const ext = pathname.split(".").pop();

    switch (ext) {
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      case "bmp":
        return "image/bmp";
      case "svg":
        return "image/svg+xml";
      case "jpg":
      case "jpeg":
      default:
        return "image/jpeg";
    }
  } catch {
    return "image/jpeg";
  }
}

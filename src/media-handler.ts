// ── Media Handler ──────────────────────────────────────────────────────
// Downloads, decrypts, and converts WeChat images into Pi's ImageContent
// format for transmission via the RPC prompt/steer commands.
// Files are downloaded and saved locally; Pi receives the file path.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WeixinMessage, ImageItem, FileItem, VoiceItem, VideoItem } from "./types.js";
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
 * Decrypt image/data if it was encrypted by WeChat's CDN.
 *
 * If no aesKey is provided, the buffer is returned unchanged.
 * Otherwise, ALWAYS attempts AES-CBC decryption (WeChat may not
 * set encryptType consistently). Supports base64, hex, and utf-8
 * key encodings.
 *
 * NOTE: WeChat CDN encryption details are not fully confirmed.
 * The implementation attempts a best-effort AES-128-CBC decryption.
 * If decryption fails or produces garbage, the caller must validate
 * the result and handle accordingly.
 */
/**
 * Decrypt WeChat CDN data using AES-128-ECB with PKCS7 padding.
 *
 * WeChat CDN encrypts media files with AES-128-ECB (not CBC).
 * The aes_key may be encoded as:
 *   - base64(raw 16 bytes)          → from img.media.aes_key
 *   - hex string (32 chars)         → from img.aeskey
 *
 * If no aesKey is provided, returns buffer unchanged.
 * If decryption fails, returns buffer unchanged (graceful fallback).
 */
export async function decryptIfNeeded(
  buffer: Buffer,
  aesKey?: string,
  _encryptType?: number,
): Promise<Buffer> {
  if (!aesKey) {
    return buffer;
  }

  try {
    // Parse key: try base64 first, then hex
    let keyBytes: Buffer;
    const decoded = Buffer.from(aesKey, "base64");
    if (decoded.length === 16) {
      // base64(raw 16 bytes) — common for images
      keyBytes = decoded;
    } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
      // base64(hex string) → decode hex
      keyBytes = Buffer.from(decoded.toString("ascii"), "hex");
    } else if (/^[0-9a-fA-F]{32}$/.test(aesKey)) {
      // raw hex string (32 chars)
      keyBytes = Buffer.from(aesKey, "hex");
    } else {
      console.error(`[media] decrypt: cannot parse aes_key (decoded len=${decoded.length})`);
      return buffer;
    }

    if (keyBytes.length !== 16) {
      console.error(`[media] decrypt: key must be 16 bytes, got ${keyBytes.length}`);
      return buffer;
    }

    // AES-128-ECB: no IV needed
    const decipher = crypto.createDecipheriv("aes-128-ecb", keyBytes, null);
    const decrypted = Buffer.concat([
      decipher.update(buffer),
      decipher.final(),
    ]);

    return decrypted;
  } catch (err) {
    console.error(`[media] decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
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
  let decrypted = await decryptIfNeeded(rawBuffer, aesKey, encryptType);

  // Validate: if decrypted data is not a valid image, try encrypt_query_param fallback
  if (!isValidImageBuffer(decrypted)) {
    const encryptQuery = img.media?.encrypt_query_param;
    if (encryptQuery) {
      try {
        const sep = fullUrl.includes("?") ? "&" : "?";
        const altUrl = fullUrl + sep + encryptQuery;
        const altController = new AbortController();
        const altTimer = setTimeout(() => altController.abort(), DOWNLOAD_TIMEOUT_MS);
        const altResp = await fetch(altUrl, {
          signal: altController.signal,
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
        });
        clearTimeout(altTimer);
        if (altResp.ok) {
          const altBuf = Buffer.from(await altResp.arrayBuffer());
          if (isValidImageBuffer(altBuf)) {
            decrypted = altBuf;
          }
        }
      } catch (altErr) {
        console.error(`[media] processImageForPi: fallback error: ${altErr instanceof Error ? altErr.message : String(altErr)}`);
      }
    }
  }

  // Final validation
  if (!isValidImageBuffer(decrypted)) {
    throw new Error(`图片数据无效 (header: ${decrypted.subarray(0, 8).toString("hex")})`);
  }

  // Convert to base64 ImageContent
  return bufferToBase64(decrypted, mimeType);
}

// ── File storage ───────────────────────────────────────────────────────

/** Directory for storing received WeChat files. */
const FILE_STORAGE_DIR = path.join(os.homedir(), ".config", "pi-weixin-cli", "files");

/** Directory for storing received WeChat images. */
const IMAGE_STORAGE_DIR = path.join(os.homedir(), ".config", "pi-weixin-cli", "images");

/** Directory for storing received WeChat voice messages. */
const VOICE_STORAGE_DIR = path.join(os.homedir(), ".config", "pi-weixin-cli", "voices");

/** Directory for storing received WeChat videos. */
const VIDEO_STORAGE_DIR = path.join(os.homedir(), ".config", "pi-weixin-cli", "videos");

/** Ensure the file storage directory exists. */
function ensureFileStorageDir(): void {
  if (!fs.existsSync(FILE_STORAGE_DIR)) {
    fs.mkdirSync(FILE_STORAGE_DIR, { recursive: true });
  }
}

/** Ensure the image storage directory exists. */
function ensureImageStorageDir(): void {
  if (!fs.existsSync(IMAGE_STORAGE_DIR)) {
    fs.mkdirSync(IMAGE_STORAGE_DIR, { recursive: true });
  }
}

/** Ensure the voice storage directory exists. */
function ensureVoiceStorageDir(): void {
  if (!fs.existsSync(VOICE_STORAGE_DIR)) {
    fs.mkdirSync(VOICE_STORAGE_DIR, { recursive: true });
  }
}

/** Ensure the video storage directory exists. */
function ensureVideoStorageDir(): void {
  if (!fs.existsSync(VIDEO_STORAGE_DIR)) {
    fs.mkdirSync(VIDEO_STORAGE_DIR, { recursive: true });
  }
}

/**
 * Download a WeChat image and save it to local storage.
 * Returns the local file path. Returns null if download fails.
 */
export async function saveImageLocally(img: ImageItem): Promise<string | null> {
  const fullUrl = img.media?.full_url || img.url;
  if (!fullUrl) return null;

  ensureImageStorageDir();

  // Determine MIME type and extension from URL
  const mimeType = inferMimeType(fullUrl);
  const ext = mimeType.split("/")[1] ?? "jpg";

  // Build filename: timestamp_random.ext
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19); // YYYY-MM-DD_HH-MM-SS
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const fileName = `${timestamp}_${randomSuffix}.${ext}`;
  const filePath = path.join(IMAGE_STORAGE_DIR, fileName);

  // Download
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const resp = await fetch(fullUrl, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Decrypt if needed
    const aesKey = img.media?.aes_key || img.aeskey;
    const encryptType = img.media?.encrypt_type;
    let decrypted = await decryptIfNeeded(buffer, aesKey, encryptType);

    // Validate decrypted data looks like an image
    if (!isValidImageBuffer(decrypted)) {
      // Fallback: WeChat CDN may require replacing the encrypted_query_param in the URL
      const encryptQuery = img.media?.encrypt_query_param;
      if (encryptQuery) {
        try {
          // Strategy 1: replace encrypted_query_param value in URL
          let altUrl = fullUrl;
          if (altUrl.includes("encrypted_query_param=")) {
            altUrl = altUrl.replace(/encrypted_query_param=[^&]*/, `encrypted_query_param=${encodeURIComponent(encryptQuery)}`);
          } else {
            const sep = altUrl.includes("?") ? "&" : "?";
            altUrl = altUrl + sep + "encrypted_query_param=" + encodeURIComponent(encryptQuery);
          }

          const altController = new AbortController();
          const altTimer = setTimeout(() => altController.abort(), DOWNLOAD_TIMEOUT_MS);
          const altResp = await fetch(altUrl, {
            signal: altController.signal,
            headers: { "User-Agent": USER_AGENT },
            redirect: "follow",
          });
          clearTimeout(altTimer);

          if (altResp.ok) {
            const altBuf = Buffer.from(await altResp.arrayBuffer());
            if (isValidImageBuffer(altBuf)) {
              decrypted = altBuf;
            }
          } else {
            console.error(`[media] fallback download failed: HTTP ${altResp.status}`);
          }
        } catch (altErr) {
          console.error(`[media] encrypt_query_param fallback error: ${altErr instanceof Error ? altErr.message : String(altErr)}`);
        }
      }
    }

    // Final validation: must be a valid image
    if (!isValidImageBuffer(decrypted)) {
      throw new Error(
        `图片数据无效：解密后仍不是有效的图片格式 (header: ${decrypted.subarray(0, 8).toString("hex")})`,
      );
    }

    fs.writeFileSync(filePath, decrypted);
    return filePath;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`图片下载失败: ${errMsg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a WeChat voice message and save it to local storage.
 * Returns the local file path. Returns null if download fails.
 */
export async function saveVoiceLocally(voice: VoiceItem): Promise<string | null> {
  const fullUrl = voice.media?.full_url;
  if (!fullUrl) return null;

  ensureVoiceStorageDir();

  // Build filename: timestamp_random.silk (WeChat voice default)
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const fileName = `${timestamp}_${randomSuffix}.silk`;
  const filePath = path.join(VOICE_STORAGE_DIR, fileName);

  // Download
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const resp = await fetch(fullUrl, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Decrypt if needed
    const aesKey = voice.media?.aes_key;
    const encryptType = voice.media?.encrypt_type;
    let decrypted = await decryptIfNeeded(buffer, aesKey, encryptType);

    // Fallback: try encrypt_query_param
    if (!isValidImageBuffer(decrypted)) {
      const encryptQuery = voice.media?.encrypt_query_param;
      if (encryptQuery) {
        try {
          let altUrl = fullUrl;
          if (altUrl.includes("encrypted_query_param=")) {
            altUrl = altUrl.replace(/encrypted_query_param=[^&]*/, `encrypted_query_param=${encodeURIComponent(encryptQuery)}`);
          } else {
            const sep = altUrl.includes("?") ? "&" : "?";
            altUrl = altUrl + sep + "encrypted_query_param=" + encodeURIComponent(encryptQuery);
          }
          const altController = new AbortController();
          const altTimer = setTimeout(() => altController.abort(), DOWNLOAD_TIMEOUT_MS);
          const altResp = await fetch(altUrl, {
            signal: altController.signal,
            headers: { "User-Agent": USER_AGENT },
            redirect: "follow",
          });
          clearTimeout(altTimer);
          if (altResp.ok) {
            const altBuf = Buffer.from(await altResp.arrayBuffer());
            decrypted = altBuf;
          }
        } catch (altErr) {
          console.error(`[media] voice encrypt_query_param fallback error: ${altErr instanceof Error ? altErr.message : String(altErr)}`);
        }
      }
    }

    fs.writeFileSync(filePath, decrypted);
    return filePath;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`语音下载失败: ${errMsg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a WeChat video and save it to local storage.
 * Returns the local file path. Returns null if download fails.
 */
export async function saveVideoLocally(video: VideoItem): Promise<string | null> {
  const fullUrl = video.media?.full_url;
  if (!fullUrl) return null;

  ensureVideoStorageDir();

  // Build filename: timestamp_random.mp4
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const fileName = `${timestamp}_${randomSuffix}.mp4`;
  const filePath = path.join(VIDEO_STORAGE_DIR, fileName);

  // Download
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const resp = await fetch(fullUrl, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Decrypt if needed
    const aesKey = video.media?.aes_key;
    const encryptType = video.media?.encrypt_type;
    let decrypted = await decryptIfNeeded(buffer, aesKey, encryptType);

    // Fallback: try encrypt_query_param
    const encryptQuery = video.media?.encrypt_query_param;
    if (encryptQuery) {
      try {
        let altUrl = fullUrl;
        if (altUrl.includes("encrypted_query_param=")) {
          altUrl = altUrl.replace(/encrypted_query_param=[^&]*/, `encrypted_query_param=${encodeURIComponent(encryptQuery)}`);
        } else {
          const sep = altUrl.includes("?") ? "&" : "?";
          altUrl = altUrl + sep + "encrypted_query_param=" + encodeURIComponent(encryptQuery);
        }
        const altController = new AbortController();
        const altTimer = setTimeout(() => altController.abort(), DOWNLOAD_TIMEOUT_MS);
        const altResp = await fetch(altUrl, {
          signal: altController.signal,
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
        });
        clearTimeout(altTimer);
        if (altResp.ok) {
          const altBuf = Buffer.from(await altResp.arrayBuffer());
          decrypted = altBuf;
        }
      } catch (altErr) {
        console.error(`[media] video encrypt_query_param fallback error: ${altErr instanceof Error ? altErr.message : String(altErr)}`);
      }
    }

    fs.writeFileSync(filePath, decrypted);
    return filePath;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`视频下载失败: ${errMsg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a WeChat file and save it to local storage.
 * Returns the local file path. Returns null if download fails.
 */
export async function saveFileLocally(file: FileItem): Promise<string | null> {
  const fullUrl = file.media?.full_url;
  if (!fullUrl) return null;

  ensureFileStorageDir();

  // Sanitize filename: remove path separators and replace unsafe chars
  const rawName = file.file_name ?? "unknown";
  const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_");

  // Build filename: timestamp_safeName
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19); // YYYY-MM-DD_HH-MM-SS
  const fileName = `${timestamp}_${safeName}`;
  const filePath = path.join(FILE_STORAGE_DIR, fileName);

  // Download
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const resp = await fetch(fullUrl, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Decrypt if needed
    const aesKey = file.media?.aes_key;
    const encryptType = file.media?.encrypt_type;
    let decrypted = await decryptIfNeeded(buffer, aesKey, encryptType);

    // If the file looks like an image by extension but the buffer isn't valid,
    // try the encrypt_query_param fallback
    const isImageExt = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(rawName);
    if (isImageExt && !isValidImageBuffer(decrypted)) {
      const encryptQuery = file.media?.encrypt_query_param;
      if (encryptQuery) {
        try {
          const sep = fullUrl.includes("?") ? "&" : "?";
          const altUrl = fullUrl + sep + encryptQuery;
          const altController = new AbortController();
          const altTimer = setTimeout(() => altController.abort(), DOWNLOAD_TIMEOUT_MS);
          const altResp = await fetch(altUrl, {
            signal: altController.signal,
            headers: { "User-Agent": USER_AGENT },
            redirect: "follow",
          });
          clearTimeout(altTimer);
          if (altResp.ok) {
            const altBuf = Buffer.from(await altResp.arrayBuffer());
            if (isValidImageBuffer(altBuf)) {
              decrypted = altBuf;
            }
          }
        } catch (altErr) {
          console.error(`[media] file encrypt_query_param fallback error: ${altErr instanceof Error ? altErr.message : String(altErr)}`);
        }
      }
    }

    fs.writeFileSync(filePath, decrypted);
    return filePath;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`文件下载失败 (${rawName}): ${errMsg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Check if a buffer starts with a known image magic number.
 * Supports JPEG, PNG, GIF, WebP, BMP.
 */
function isValidImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const jpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  const gif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
  const webp = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
  const bmp = buffer[0] === 0x42 && buffer[1] === 0x4D;
  return jpeg || png || gif || webp || bmp;
}

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

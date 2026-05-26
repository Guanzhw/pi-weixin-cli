// ── Weixin Protocol Types ────────────────────────────────────────────────
// Extracted and adapted from @tencent-weixin/openclaw-weixin src/api/types.ts
//
// Backend endpoint: https://ilinkai.weixin.qq.com
// Protocol: HTTP JSON POST, long-poll on getUpdates and get_qrcode_status

// ── Constants ──────────────────────────────────────────────────────────

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

// ── Base Info ──────────────────────────────────────────────────────────

export interface BaseInfo {
  channel_version?: string;
  /** Self-declared identity (UA-style), for observability only. */
  bot_agent?: string;
}

// ── CDN Media ──────────────────────────────────────────────────────────

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

// ── Message Items ──────────────────────────────────────────────────────

export interface TextItem {
  text?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ── Weixin Message (core message type) ─────────────────────────────────

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** Session token: echo verbatim in every reply. */
  context_token?: string;
  run_id?: string;
}

// ── API Request/Response Types ─────────────────────────────────────────

export interface GetUpdatesReq {
  /** @deprecated compat only. */
  sync_buf?: string;
  /** Sync cursor. Send "" on first request or after reset. */
  get_updates_buf?: string;
  base_info?: BaseInfo;
}

export interface GetUpdatesResp {
  ret?: number;
  /** Error code (e.g. -14 = session timeout). */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** @deprecated compat only. */
  sync_buf?: string;
  /** New sync cursor for the next getUpdates request. */
  get_updates_buf?: string;
  /** Server-suggested long-poll timeout (ms). */
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
  base_info?: BaseInfo;
}

export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 1 = typing, 2 = cancel typing. */
  status?: number;
  base_info?: BaseInfo;
}

export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  /** Base64-encoded typing ticket. */
  typing_ticket?: string;
}

// ── QR / Auth Types ────────────────────────────────────────────────────

export interface GetQRCodeResp {
  /** Opaque token used for status polling (passed as ?qrcode= query param). */
  qrcode?: string;
  /** Text content to display as QR code (for user to scan). */
  qrcode_img_content?: string;
}

export type QRCodeStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QRCodeStatusResp {
  status: QRCodeStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** User ID of the person who scanned the QR code. */
  ilink_user_id?: string;
  /** New host to redirect polling to. */
  redirect_host?: string;
}

export interface NotifyStartReq {
  base_info?: BaseInfo;
}

export interface NotifyStartResp {
  ret?: number;
  errmsg?: string;
}

export interface NotifyStopReq {
  base_info?: BaseInfo;
}

export interface NotifyStopResp {
  ret?: number;
  errmsg?: string;
}

// ── Account / Internal State Types ─────────────────────────────────────

export interface WeixinAccount {
  /** Unique identifier (normalized user ID). */
  id: string;
  /** ilink_user_id from login QR response. */
  userId: string;
  /** Bearer token for API calls. */
  botToken: string;
  /** API base URL (may be redirected). */
  baseUrl: string;
  /** Creation timestamp (ms). */
  createdAt: number;
}

export interface WeixinSyncState {
  /** Sync cursor for getUpdates long-poll. */
  getUpdatesBuf: string;
  /** Per-user context tokens: userId → contextToken. */
  contextTokens: Record<string, string>;
}

export interface QueuedWeixinMessage {
  account: WeixinAccount;
  /** The WeChat message metadata for reply routing. */
  userId: string;
  contextToken: string;
  sessionId: string;
  /** The extracted text content. */
  text: string;
}

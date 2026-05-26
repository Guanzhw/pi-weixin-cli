// ── UI Bridge ──────────────────────────────────────────────────────────
// Bidirectional bridge between Pi's extension UI protocol (JSONL over RPC)
// and WeChat messages.
//
// Direction 1 (Pi → WeChat): format extension_ui_request events into
//   human-readable WeChat messages.
//
// Direction 2 (WeChat → Pi): parse a WeChat user's text reply into the
//   correct extension_ui_response payload.
//
// Supported methods:
//   Dialog (blocking): select, confirm, input, editor
//   Fire-and-forget:  notify, setStatus, setWidget, setTitle, set_editor_text

import type { ExtensionUIRequestEvent } from "./types-rpc.js";

// ── Constants ──────────────────────────────────────────────────────────

const CONFIRM_YES_PATTERN = /^(确认|是|yes|y|1|同意|允许|allow|ok|true)$/i;
const CANCEL_PATTERN = /^(保持原样|cancel|取消|no|n|0|false)$/i;

// ── Direction 1: Pi → WeChat ──────────────────────────────────────────

/**
 * Determine if an extension_ui_request method is fire-and-forget
 * (does not expect a response).
 */
export function isFireAndForget(method: string): boolean {
  switch (method) {
    case "notify":
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
      return true;
    default:
      return false;
  }
}

/**
 * Format an extension_ui_request event into a human-readable WeChat message.
 *
 * For dialog methods (select/confirm/input/editor) the user is expected to
 * reply with a meaningful answer. For fire-and-forget methods the message
 * is purely informational.
 *
 * Returns an empty string for fire-and-forget methods that carry no
 * actionable content (setStatus/setWidget/setTitle/set_editor_text are
 * internal UI updates only).
 */
export function formatUIRequestForWeixin(event: ExtensionUIRequestEvent): string {
  const method = event.method as string;

  switch (method) {
    // ── Dialog: select ────────────────────────────────────────────────
    case "select": {
      let text = `🤖 Pi 需要你选择一项：\n\n`;
      if (event.title) text += `📌 ${event.title}\n`;
      if (event.message) text += `${event.message}\n`;

      const opts = event.options;
      if (opts && opts.length > 0) {
        text += `\n请回复选项对应的数字：`;
        opts.forEach((opt, i) => {
          text += `\n${i + 1}. ${opt}`;
        });
      } else {
        text += `\n请直接回复你的选择`;
      }
      return text;
    }

    // ── Dialog: confirm ───────────────────────────────────────────────
    case "confirm": {
      let text = `🤖 Pi 需要你确认：\n\n`;
      if (event.title) text += `📌 ${event.title}\n`;
      if (event.message) text += `${event.message}\n`;
      text += `\n请回复「确认」或「取消」`;
      return text;
    }

    // ── Dialog: input ─────────────────────────────────────────────────
    case "input": {
      let text = `🤖 Pi 在问你：\n\n`;
      if (event.title) text += `📌 ${event.title}\n`;
      if (event.placeholder) text += `\n💡 提示：${event.placeholder}`;
      text += `\n\n请直接回复你的回答`;
      return text;
    }

    // ── Dialog: editor ────────────────────────────────────────────────
    case "editor": {
      let text = `🤖 Pi 需要你编辑文本：\n\n`;
      if (event.title) text += `📌 ${event.title}\n`;
      if (event.prefill) {
        text += `\n当前内容：\n\`\`\`\n${event.prefill.slice(0, 500)}\n\`\`\``;
        if (event.prefill.length > 500) text += `\n...(内容过长，截断显示)`;
      }
      text += `\n\n请直接回复修改后的完整文本，或回复「保持原样」`;
      return text;
    }

    // ── Fire-and-forget: notify ───────────────────────────────────────
    case "notify": {
      const icon =
        event.notifyType === "error"
          ? "❌"
          : event.notifyType === "warning"
            ? "⚠️"
            : "ℹ️";
      return `${icon} Pi 通知：${event.message ?? ""}`;
    }

    // ── Other fire-and-forget: no actionable WeChat payload ────────────
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
    default:
      return "";
  }
}

// ── Direction 2: WeChat → Pi ──────────────────────────────────────────

/**
 * Parse a WeChat user's text reply into an extension_ui_response payload.
 *
 * @param text  - Raw text from the WeChat user.
 * @param method - The dialog method (select / confirm / input / editor).
 * @param options - For "select", the list of options the user chose from.
 * @returns A partial RpcExtensionUIResponseCommand payload.
 */
export function parseUserResponse(
  text: string,
  method: string,
  options?: string[],
): { value?: string; confirmed?: boolean; cancelled?: true } {
  const trimmed = text.trim();

  switch (method) {
    // ── confirm ───────────────────────────────────────────────────────
    case "confirm": {
      if (!trimmed || CANCEL_PATTERN.test(trimmed)) {
        return { confirmed: false };
      }
      if (CONFIRM_YES_PATTERN.test(trimmed)) {
        return { confirmed: true };
      }
      // 无法明确判断的文本，返回 false（偏向保守/安全）
      return { confirmed: false };
    }

    // ── select ────────────────────────────────────────────────────────
    case "select": {
      if (!trimmed) {
        return { cancelled: true };
      }

      // 1. Try exact numeric match (1-indexed)
      const num = parseInt(trimmed, 10);
      if (options && options.length > 0 && !isNaN(num) && num >= 1 && num <= options.length) {
        return { value: options[num - 1] };
      }

      // 2. Try exact case-insensitive match
      if (options && options.length > 0) {
        const exactMatch = options.find(
          (opt) => opt.toLowerCase() === trimmed.toLowerCase(),
        );
        if (exactMatch) return { value: exactMatch };
      }

      // 3. Try partial / substring match (returns first match)
      if (options && options.length > 0) {
        const partialMatch = options.find((opt) =>
          opt.toLowerCase().includes(trimmed.toLowerCase()),
        );
        if (partialMatch) return { value: partialMatch };
      }

      // 4. Fallback: use raw text
      return { value: trimmed };
    }

    // ── input / editor ────────────────────────────────────────────────
    case "input":
    case "editor": {
      if (!trimmed || CANCEL_PATTERN.test(trimmed)) {
        return { cancelled: true };
      }
      return { value: trimmed };
    }

    default:
      return { value: trimmed };
  }
}

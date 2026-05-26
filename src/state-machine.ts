// ── State Machine ──────────────────────────────────────────────────────
// Tracks the pi-weixin-cli lifecycle for routing between normal messages
// and extension UI responses.
//
// States:
//   IDLE                 — No active turn. Normal WeChat messages → send RPC prompt.
//   AGENT_RUNNING        — Pi is processing a turn (between agent_start and agent_end).
//                          New WeChat messages → queue.
//   WAITING_UI_RESPONSE  — Pi is blocked on a select/confirm/input/editor dialog from
//                          an extension. WeChat messages → interpret as UI response.
//
// Transitions:
//   IDLE ──send prompt──▶ AGENT_RUNNING
//   AGENT_RUNNING ──extension_ui_request──▶ WAITING_UI_RESPONSE
//   WAITING_UI_RESPONSE ──send ui_response──▶ AGENT_RUNNING
//   WAITING_UI_RESPONSE ──timeout──▶ AGENT_RUNNING
//   AGENT_RUNNING ──agent_end──▶ IDLE

import type { WeixinAccount } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

export type UIMethod = "select" | "confirm" | "input" | "editor";

/** Context captured from a pending extension_ui_request dialog. */
export interface UIRequestContext {
  /** Unique ID from Pi's extension_ui_request, used to match the response. */
  requestId: string;
  /** Dialog method. */
  method: UIMethod;
  /// WeChat routing context (captured from the WeChat message that triggered this turn).
  account: WeixinAccount;
  userId: string;
  contextToken: string;
  sessionId: string;
  /// Display information from the UI request.
  title?: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
  /** Absolute timestamp (ms) at which the request times out, or undefined. */
  timeoutAt?: number;
  /** Reference to the timeout timer so it can be cleared on cancellation. */
  timeoutId?: ReturnType<typeof setTimeout>;
}

export type State =
  | { kind: "IDLE" }
  | { kind: "AGENT_RUNNING" }
  | { kind: "WAITING_UI_RESPONSE"; uiRequest: UIRequestContext };

// ── StateMachine ───────────────────────────────────────────────────────

export class StateMachine {
  private _state: State = { kind: "IDLE" };

  // ── Queries ──────────────────────────────────────────────────────────

  get state(): State {
    return this._state;
  }

  get isIdle(): boolean {
    return this._state.kind === "IDLE";
  }

  get isAgentRunning(): boolean {
    return this._state.kind === "AGENT_RUNNING";
  }

  get isWaitingUIResponse(): boolean {
    return this._state.kind === "WAITING_UI_RESPONSE";
  }

  /** Returns the pending UI request context, or null if not in WAITING_UI_RESPONSE state. */
  get pendingUIRequest(): UIRequestContext | null {
    return this._state.kind === "WAITING_UI_RESPONSE" ? this._state.uiRequest : null;
  }

  // ── Transitions ──────────────────────────────────────────────────────

  /** Transition from any state to IDLE. */
  setIdle(): void {
    this.clearPendingTimeout();
    this._state = { kind: "IDLE" };
  }

  /** Transition to AGENT_RUNNING. */
  setAgentRunning(): void {
    this.clearPendingTimeout();
    this._state = { kind: "AGENT_RUNNING" };
  }

  /** Transition to WAITING_UI_RESPONSE with the given UI request context. */
  setWaitingUIResponse(ctx: UIRequestContext): void {
    this.clearPendingTimeout();
    this._state = { kind: "WAITING_UI_RESPONSE", uiRequest: ctx };
  }

  /**
   * Clear the timeout timer attached to a pending UI request.
   * Safe to call from any state.
   */
  private clearPendingTimeout(): void {
    if (this._state.kind === "WAITING_UI_RESPONSE") {
      const tid = this._state.uiRequest.timeoutId;
      if (tid) clearTimeout(tid);
    }
  }
}

// ── RPC Protocol Types ──────────────────────────────────────────────────
// Mirrors the Pi RPC protocol (dist/modes/rpc/rpc-types.d.ts).
// Commands are sent as JSON lines on stdin.
// Events are received as JSON lines on stdout.

// ── Shared Types ─────────────────────────────────────────────────────

/** Pi's image content block for prompt/steer commands. */
export interface ImageContent {
  type: "image";
  /** Base64-encoded image data (no data URI prefix). */
  data: string;
  /** MIME type, e.g. "image/jpeg", "image/png". */
  mimeType: string;
}

// ── Commands (stdin) ───────────────────────────────────────────────────

export interface RpcPromptCommand {
  type: "prompt";
  message: string;
  /** Optional images to attach to the prompt. */
  images?: ImageContent[];
}

export interface RpcSteerCommand {
  type: "steer";
  message: string;
  /** Optional images to attach to the steer. */
  images?: ImageContent[];
}

export interface RpcAbortCommand {
  type: "abort";
}

export interface RpcExtensionUIResponseCommand {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

export interface RpcGetStateCommand {
  type: "get_state";
  id?: string;
}

export interface RpcNewSessionCommand {
  type: "new_session";
  parentSession?: string;
  id?: string;
}

export interface RpcCompactCommand {
  type: "compact";
  customInstructions?: string;
  id?: string;
}

export interface RpcGetAvailableModelsCommand {
  type: "get_available_models";
  id?: string;
}

export interface RpcSetModelCommand {
  type: "set_model";
  provider: string;
  modelId: string;
  id?: string;
}

export interface RpcGetCommandsCommand {
  type: "get_commands";
  id?: string;
}

export interface RpcSwitchSessionCommand {
  type: "switch_session";
  sessionPath: string;
  id?: string;
}

export interface RpcGetSessionStatsCommand {
  type: "get_session_stats";
  id?: string;
}

export interface RpcBashCommand {
  type: "bash";
  command: string;
  id?: string;
}

export interface RpcAbortBashCommand {
  type: "abort_bash";
  id?: string;
}

export type RpcStdinCommand =
  | RpcPromptCommand
  | RpcSteerCommand
  | RpcAbortCommand
  | RpcExtensionUIResponseCommand
  | RpcGetStateCommand
  | RpcNewSessionCommand
  | RpcCompactCommand
  | RpcGetAvailableModelsCommand
  | RpcSetModelCommand
  | RpcGetCommandsCommand
  | RpcSwitchSessionCommand
  | RpcGetSessionStatsCommand
  | RpcBashCommand
  | RpcAbortBashCommand;

// ── Events (stdout) ────────────────────────────────────────────────────

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  /** All messages from the completed agent turn. */
  messages?: unknown[];
  /** Whether the turn was aborted. */
  aborted?: boolean;
}

export interface MessageUpdateEvent {
  type: "message_update";
  /** The assistant message event (text_delta, tool_use, etc). */
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    [key: string]: unknown;
  };
}

export interface ExtensionUIRequestEvent {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  text?: string;
  timeout?: number;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolName?: string;
  [key: string]: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolName?: string;
  result?: unknown;
  [key: string]: unknown;
}

export interface ResponseEvent {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
}

/** Union of all possible stdout events from Pi RPC. */
export type RpcStdoutEvent =
  | AgentStartEvent
  | AgentEndEvent
  | MessageUpdateEvent
  | ExtensionUIRequestEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | ResponseEvent;

// ── Weixin Extension Configuration ────────────────────────────────────
// Persistent configuration for pi-weixin-cli extension.
// Saves to ~/.pi/agent/extensions/pi-weixin-cli/settings.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface WeixinConfig {
  /** 是否启用消息接收（daemon 启动时读取）。CLI 模式下通过 `toggle` 命令切换。 */
  enabled: boolean;
  /** 每 N 条微信消息附加一次提示 */
  hintInterval: number;
  /** 附加的提示文本 */
  hintMessage: string;
  /** 是否启用提示功能 */
  hintsEnabled: boolean;
}

export const DEFAULT_CONFIG: WeixinConfig = {
  enabled: true,
  hintInterval: 3,
  hintMessage:
    "[系统提示] 当前用户通过微信与 Pi 交互。Pi 的 ask_user、confirm、select、input 等交互操作已通过消息桥接支持，可直接在微信中回复选项或文本。",
  hintsEnabled: true,
};

function getConfigPath(): string {
  return path.join(
    os.homedir(),
    ".pi",
    "agent",
    "extensions",
    "pi-weixin-cli",
    "settings.json",
  );
}

export function loadConfig(): WeixinConfig {
  try {
    const filePath = getConfigPath();
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: WeixinConfig): void {
  const filePath = getConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

/** 恢复默认配置并持久化。 */
export function resetConfig(): void {
  saveConfig({ ...DEFAULT_CONFIG });
}

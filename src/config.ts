// ── Configuration ──────────────────────────────────────────────────────
// Persistent configuration for pi-weixin-cli.
// Saves to ~/.config/pi-weixin-cli/settings.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface WeixinConfig {
  /** 是否启用消息接收（daemon 启动时读取）。CLI 模式下通过 `toggle` 命令切换。 */
  enabled: boolean;
}

export const DEFAULT_CONFIG: WeixinConfig = {
  enabled: true,
};

function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "pi-weixin-cli", "settings.json");
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

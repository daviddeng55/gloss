// User settings in settings.json (project folder). Anything missing uses the default.
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CROP, type CropOptions } from "./crop.ts";

export type Settings = {
  ask: CropOptions & {
    /** Press to start circling, press again (or click) to send. Electron accelerator syntax; "Alt" = Option. */
    shortcut: string;
  };
};

export const DEFAULT_SETTINGS_FILE: Settings = { ask: { shortcut: "Alt+A", ...DEFAULT_CROP } };

export function loadSettings(path: string): Settings {
  if (!existsSync(path)) return DEFAULT_SETTINGS_FILE;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    return { ask: { ...DEFAULT_SETTINGS_FILE.ask, ...(raw.ask ?? {}) } };
  } catch {
    return DEFAULT_SETTINGS_FILE;
  }
}

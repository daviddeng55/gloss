// User settings in settings.json (project folder). Anything missing uses the default.
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CROP, type CropOptions } from "./crop.ts";

export type Settings = {
  /** Which local models to use: `review` for summaries, quizzes and marking; `ask` for circle-and-ask. */
  ai: { reviewModel: string; askModel: string };
  /** How often the screen is checked, and how long a page must stay in front before it's read. */
  capture: { intervalSeconds: number; dwellSeconds: number };
  /** Offer help when it looks like you're stuck (never interrupts on its own). */
  learn: { offerHelpWhenStuck: boolean };
  ask: CropOptions & {
    /** Press to start circling, press again (or click) to send. Electron accelerator syntax; "Alt" = Option. */
    shortcut: string;
    voice: boolean; // listen for a spoken question while circling
    locale: string; // speech recognition language, e.g. "en-US"
  };
};

export const DEFAULT_SETTINGS_FILE: Settings = {
  ai: { reviewModel: "qwen3.5:4b", askModel: "qwen3.5:4b" },
  capture: { intervalSeconds: 5, dwellSeconds: 8 },
  learn: { offerHelpWhenStuck: true },
  ask: { shortcut: "Alt+A", voice: true, locale: "en-US", ...DEFAULT_CROP },
};

export function loadSettings(path: string): Settings {
  if (!existsSync(path)) return DEFAULT_SETTINGS_FILE;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    return {
      ai: { ...DEFAULT_SETTINGS_FILE.ai, ...(raw.ai ?? {}) },
      capture: { ...DEFAULT_SETTINGS_FILE.capture, ...(raw.capture ?? {}) },
      learn: { ...DEFAULT_SETTINGS_FILE.learn, ...(raw.learn ?? {}) },
      ask: { ...DEFAULT_SETTINGS_FILE.ask, ...(raw.ask ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS_FILE;
  }
}

/** Keeps values in sensible ranges so a typo in Settings can't break capture. */
export function sanitizeSettings(s: Settings): Settings {
  const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
    const x = Number(n);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : dflt;
  };
  const d = DEFAULT_SETTINGS_FILE;
  const model = (m: unknown, dflt: string) => (typeof m === "string" && /^[\w.:/-]{1,80}$/.test(m) ? m : dflt);
  return {
    ai: { reviewModel: model(s.ai?.reviewModel, d.ai.reviewModel), askModel: model(s.ai?.askModel, d.ai.askModel) },
    capture: {
      intervalSeconds: clamp(s.capture?.intervalSeconds, 2, 60, d.capture.intervalSeconds),
      dwellSeconds: clamp(s.capture?.dwellSeconds, 0, 60, d.capture.dwellSeconds),
    },
    learn: { offerHelpWhenStuck: s.learn?.offerHelpWhenStuck !== false },
    ask: {
      shortcut: String(s.ask?.shortcut || d.ask.shortcut).slice(0, 40),
      voice: s.ask?.voice !== false,
      locale: String(s.ask?.locale || d.ask.locale).slice(0, 12),
      fallbackW: clamp(s.ask?.fallbackW, 200, 3000, d.ask.fallbackW),
      fallbackH: clamp(s.ask?.fallbackH, 150, 2000, d.ask.fallbackH),
      padding: clamp(s.ask?.padding, 0, 200, d.ask.padding),
      minCircle: clamp(s.ask?.minCircle, 10, 300, d.ask.minCircle),
    },
  };
}

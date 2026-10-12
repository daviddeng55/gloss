// Decides which window a capture is about, and whether it may be recorded at all.
// Edit never-record.json to change the never-record list.
import { readFileSync } from "node:fs";
import type { WindowInfo } from "./helper.ts";

export type NeverRecord = { apps: string[]; titles: RegExp[] };

export function loadNeverRecord(path: string): NeverRecord {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { apps?: string[]; titles?: string[] };
  return {
    apps: (raw.apps ?? []).map((a) => a.toLowerCase()),
    titles: (raw.titles ?? []).map((t) => new RegExp(t, "i")),
  };
}

/**
 * The window you're working in. The topmost window tells us the app, but it can be a toolbar
 * strip (Chrome in full screen draws its tabs and toolbar as separate untitled windows), so we
 * take that app's frontmost titled window of a reasonable size instead.
 */
export function pickFrontWindow(windows: WindowInfo[]): WindowInfo | null {
  const top = windows[0];
  if (!top) return null;
  const mine = windows.filter((w) => w.pid === top.pid && w.width >= 200 && w.height >= 200);
  return mine.find((w) => w.title.trim() !== "") ?? mine[0] ?? top;
}

// Code editors and terminals: the session itself runs in one of these.
const EDITORS_AND_TERMINALS = new Set([
  "com.microsoft.vscode",
  "com.microsoft.vscodeinsiders",
  "com.todesktop.230313mzl4w4u92", // Cursor
  "dev.zed.zed",
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp-stable",
  "com.mitchellh.ghostty",
]);

/**
 * This project's own windows: an editor or terminal whose title mentions the project folder or the
 * session command. Studying in VS Code in another folder (e.g. CS 135 work) is still recorded.
 */
export function isOwnWindow(w: WindowInfo, projectName: string): boolean {
  if (!EDITORS_AND_TERMINALS.has(w.bundleId.toLowerCase())) return false;
  if (w.title.trim() === "") return true; // can't tell what's in it, so play safe
  const names = [projectName, "gloss"].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(^|[\\s—–\\-|/])(${names})($|[\\s—–\\-|/])|session\\.ts|npm run session`, "i").test(w.title);
}

/** Browser pages with nothing to study on them. */
const BLANK_PAGE = /^(new tab|start page|untitled|favorites|new private tab|blank page)$/i;

export function isBlankPage(w: WindowInfo): boolean {
  return BLANK_PAGE.test(w.title.replace(/\s*[🔊🔇]\s*$/u, "").trim());
}

/** Returns why this window must not be recorded, or null if it's fine. */
export function blockedReason(w: WindowInfo, list: NeverRecord, projectName: string): string | null {
  if (list.apps.includes(w.bundleId.toLowerCase()) || list.apps.includes(w.app.toLowerCase())) {
    return `${w.app} is on the never-record list`;
  }
  const hit = list.titles.find((re) => re.test(w.title));
  if (hit) return `"${w.title}" matches never-record rule /${hit.source}/`;
  if (isOwnWindow(w, projectName)) return `${w.app} is showing this project (${projectName}), not study material`;
  if (isBlankPage(w)) return "blank browser page";
  return null;
}

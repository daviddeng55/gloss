// Never-record list: checked before every capture. Edit never-record.json to change it.
import { readFileSync } from "node:fs";
import type { FrontWindow } from "./helper.ts";

export type NeverRecord = { apps: string[]; titles: RegExp[] };

export function loadNeverRecord(path: string): NeverRecord {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { apps?: string[]; titles?: string[] };
  return {
    apps: (raw.apps ?? []).map((a) => a.toLowerCase()),
    titles: (raw.titles ?? []).map((t) => new RegExp(t, "i")),
  };
}

/** Returns why this window must not be recorded, or null if it's fine. */
export function blockedReason(w: FrontWindow, list: NeverRecord): string | null {
  if (list.apps.includes(w.bundleId.toLowerCase()) || list.apps.includes(w.app.toLowerCase())) {
    return `app "${w.app}" is on the never-record list`;
  }
  const hit = list.titles.find((re) => re.test(w.title));
  if (hit) return `window title matches never-record rule /${hit.source}/`;
  return null;
}

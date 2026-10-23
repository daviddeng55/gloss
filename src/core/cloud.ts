// Fast mode's privacy rules: what may be sent to the cloud model. Content is only sent if it came from a
// study app on the allow-list (Settings), and every piece of text goes through the redaction filter again
// on its way out (provider.ts). Anything else is answered by the local model, as before.
import { redact } from "./redact.ts";

/** Apps students read course material in. Matched by app name or bundle id, ignoring case. */
export const DEFAULT_STUDY_APPS = [
  "Google Chrome",
  "Safari",
  "Arc",
  "Firefox",
  "Microsoft Edge",
  "Brave Browser",
  "Preview",
  "Skim",
  "Adobe Acrobat",
  "Adobe Acrobat Reader",
  "PDF Expert",
  "Books",
  "Notion",
  "Obsidian",
  "Microsoft OneNote",
  "Microsoft Word",
  "Microsoft PowerPoint",
  "Pages",
  "Keynote",
  "GoodNotes",
  "Notability",
  "DrRacket",
];

const norm = (s: string) => s.trim().toLowerCase();

/** Is this app (name or bundle id) on the allow-list? */
export function isStudyApp(app: string, allowList: string[]): boolean {
  const a = norm(app);
  return !!a && allowList.some((x) => norm(x) === a);
}

/** May content from all of these apps go to the cloud? (Nothing at all is fine: there's nothing to send.) */
export function allFromStudyApps(apps: Iterable<string>, allowList: string[]): boolean {
  for (const app of apps) if (!isStudyApp(app, allowList)) return false;
  return true;
}

/**
 * Text in a picture that the redaction filter would hide (a password, a card number…). Such a picture
 * isn't sent to the cloud at all, since parts of an image can't be blacked out reliably.
 */
export function looksSensitive(text: string): boolean {
  return redact(text).count > 0;
}

/** Tidies the allow-list typed in Settings: one app per entry, no blanks or repeats. */
export function cleanAppList(apps: unknown): string[] {
  if (!Array.isArray(apps)) return [...DEFAULT_STUDY_APPS];
  const out: string[] = [];
  for (const a of apps) {
    const s = String(a).replace(/\s+/g, " ").trim().slice(0, 80);
    if (s && !out.some((x) => norm(x) === norm(s))) out.push(s);
  }
  return out.slice(0, 100);
}

// The Gemini API key lives in the macOS Keychain (the "login" keychain, item "Gloss Gemini API key"),
// never in settings.json, the repo, a .env file or the logs. We use macOS's own `security` tool; the key is
// written through its stdin, so it never shows up in the list of running processes.
import { execFile, spawn } from "node:child_process";

const SERVICE = "Gloss Gemini API key";
const ACCOUNT = "gloss";

/** Gemini keys are letters, digits, "-" and "_" (also keeps the key from breaking the command below). */
export function looksLikeApiKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test(key);
}

/** The saved key, or null if there isn't one. */
export function readApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"], { timeout: 10_000 }, (err, stdout) => {
      const key = String(stdout ?? "").trim();
      resolve(err || !key ? null : key);
    });
  });
}

/** Saves (or replaces) the key. */
export function saveApiKey(key: string): Promise<void> {
  if (!looksLikeApiKey(key)) return Promise.reject(new Error("That doesn't look like a Gemini API key."));
  return new Promise((resolve, reject) => {
    const p = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    p.stderr.on("data", (d) => (errors += String(d)));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 && !errors.trim() ? resolve() : reject(new Error(`Couldn't save the key in the Keychain${errors ? `: ${errors.trim().slice(0, 120)}` : "."}`)),
    );
    p.stdin.end(`add-generic-password -U -a ${ACCOUNT} -s "${SERVICE}" -l "${SERVICE}" -w "${key}"\n`);
  });
}

/** Removes the key (no error if there was none). */
export function deleteApiKey(): Promise<void> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE], { timeout: 10_000 }, () => resolve());
  });
}

// Talks to bin/vision-helper (the Swift program) over stdin/stdout, one JSON object per line.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const HELPER_PATH = fileURLToPath(new URL("../bin/vision-helper", import.meta.url));

export type Box = { x: number; y: number; w: number; h: number }; // fractions of the image, top-left origin
export type TextBlock = { text: string; confidence: number; box: Box };

export type OcrOptions = {
  engine?: "lines" | "document";
  languageCorrection?: boolean;
  languages?: string[];
};

export type FrontWindow = { app: string; bundleId: string; title: string };

export type CaptureResult = FrontWindow & {
  skipped: boolean;
  changeRatio: number;
  width: number;
  height: number;
  blocks?: TextBlock[];
  ms?: number;
};

export type OcrFileResult = { blocks: TextBlock[]; width: number; height: number; ms: number };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class VisionHelper {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** lowPriority runs the helper at "utility" priority so text recognition doesn't hog the CPU. */
  constructor(opts: { lowPriority?: boolean } = {}) {
    if (!existsSync(HELPER_PATH)) {
      throw new Error(`Swift helper not built. Run: npm run build:helper`);
    }
    this.proc = opts.lowPriority
      ? spawn("/usr/sbin/taskpolicy", ["-c", "utility", HELPER_PATH])
      : spawn(HELPER_PATH);
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", (d) => process.stderr.write(`[vision-helper] ${d}`));
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`vision-helper exited (${code})`));
      this.pending.clear();
    });
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error ?? "vision-helper error"));
  }

  private request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  async hasPermission(): Promise<boolean> {
    return (await this.request<{ granted: boolean }>("permission")).granted;
  }

  /** Makes macOS show the Screen Recording prompt and add this app to the list in System Settings. */
  async requestPermission(): Promise<boolean> {
    return (await this.request<{ granted: boolean }>("requestPermission")).granted;
  }

  frontmost(): Promise<FrontWindow> {
    return this.request("frontmost");
  }

  /** Captures the screen in memory. Text is only read if the image changed more than `threshold` (0–1). */
  capture(args: OcrOptions & { mode?: "window" | "display"; threshold?: number; force?: boolean }): Promise<CaptureResult> {
    return this.request("capture", args);
  }

  ocrFile(path: string, opts: OcrOptions = {}): Promise<OcrFileResult> {
    return this.request("ocrFile", { path, ...opts });
  }

  close() {
    this.proc.stdin.end();
  }
}

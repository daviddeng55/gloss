// Talks to "Study Buddy Voice" (helper/voice.swift): on-device speech-to-text. It's started through
// `vision-helper --disclaim` so macOS asks permission for Study Buddy Voice itself.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export type VoiceStatus = { mic: string; speech: string; onDevice?: boolean };
export type VoiceEvent = { event: "partial"; text: string } | { event: "level"; value: number };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class VoiceHelper {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: VoiceEvent) => void>();

  constructor(paths: { visionHelper: string; voice: string }) {
    if (!existsSync(paths.voice)) throw new Error("Study Buddy Voice isn't built. Run: npm run build:helper");
    this.proc = spawn(paths.visionHelper, ["--disclaim", paths.voice]);
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event) {
        for (const l of this.listeners) l(msg);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error ?? "voice error"));
    });
    this.proc.stderr.on("data", (d) => process.stderr.write(`[voice] ${d}`));
    this.proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("Study Buddy Voice stopped"));
      this.pending.clear();
    });
  }

  private request<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Study Buddy Voice didn't answer "${cmd}"`));
      }, timeoutMs);
      const done = (fn: (v: any) => void) => (v: any) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  onEvent(cb: (e: VoiceEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  status(locale: string): Promise<VoiceStatus> {
    return this.request("status", { locale });
  }

  /** Shows the macOS permission prompts (Microphone, then Speech Recognition). Waits for your answers. */
  requestPermission(): Promise<VoiceStatus> {
    return this.request("request", {}, 300_000);
  }

  /** Microphone on. */
  start(locale: string): Promise<void> {
    return this.request("start", { locale });
  }

  /** Microphone off; resolves with what was said. */
  async stop(): Promise<string> {
    return (await this.request<{ text: string }>("stop")).text;
  }

  /** Microphone off, words discarded. */
  async cancel(): Promise<void> {
    await this.request("cancel");
  }

  close() {
    this.proc.stdin.end(); // Study Buddy Voice quits when its input closes
  }
}

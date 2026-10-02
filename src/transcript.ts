// Writes the session transcript as it goes (so nothing is lost if the session is interrupted):
//   sessions/<course>/<date>_<time>.md     — readable transcript
//   sessions/<course>/<date>_<time>.jsonl  — the same entries as data, one per line (imported in Stage 2)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TranscriptEntry = { capturedAt: string; app: string; title: string; text: string };

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export class TranscriptWriter {
  readonly mdPath: string;
  readonly jsonlPath: string;
  private lastSource = "";

  constructor(dir: string, course: { id: string; name: string }, startedAt: Date, header: Record<string, string>) {
    const folder = join(dir, course.id);
    mkdirSync(folder, { recursive: true });
    const base = `${day(startedAt)}_${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
    this.mdPath = join(folder, `${base}.md`);
    this.jsonlPath = join(folder, `${base}.jsonl`);
    const meta = Object.entries(header)
      .filter(([, v]) => v)
      .map(([k, v]) => `- **${k}:** ${v}`)
      .join("\n");
    writeFileSync(this.mdPath, `# ${course.name} — study session ${day(startedAt)} ${clock(startedAt)}\n\n${meta}\n`);
    writeFileSync(this.jsonlPath, "");
  }

  add(entry: TranscriptEntry) {
    const at = new Date(entry.capturedAt);
    const source = `${entry.app} — ${entry.title || "(untitled window)"}`;
    // New heading when the app/window changes; otherwise just a timestamp.
    const heading = source !== this.lastSource ? `\n## ${clock(at)} · ${source}\n\n` : `\n*${clock(at)}*\n\n`;
    this.lastSource = source;
    appendFileSync(this.mdPath, heading + entry.text + "\n");
    appendFileSync(this.jsonlPath, JSON.stringify(entry) + "\n");
  }

  finish(stats: Record<string, string | number>) {
    const lines = Object.entries(stats).map(([k, v]) => `| ${k} | ${v} |`);
    appendFileSync(this.mdPath, `\n---\n\n## Session stats\n\n| | |\n|---|---|\n${lines.join("\n")}\n`);
  }
}

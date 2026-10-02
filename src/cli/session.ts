// Stage 1: run a capture session from the terminal.
//   npm run session -- --course math135 --minutes 10
// Press Ctrl+C to end early; the transcript is saved either way.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CaptureLoop, statsRows } from "../core/capture.ts";
import { VisionHelper } from "../core/helper.ts";
import { loadNeverRecord } from "../core/privacy.ts";
import { TranscriptWriter } from "../core/transcript.ts";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const { values: args } = parseArgs({
  options: {
    course: { type: "string" },
    goal: { type: "string", default: "" },
    minutes: { type: "string", default: "10" },
    interval: { type: "string", default: "5" }, // seconds between captures
    mode: { type: "string", default: "window" }, // "window" (front window only) or "display" (whole screen minus blocked windows)
    engine: { type: "string", default: "document" }, // "document" (paragraphs) or "lines"
    "language-correction": { type: "boolean", default: false },
    threshold: { type: "string", default: "0.02" }, // fraction of the image that must change
    out: { type: "string", default: root("sessions") },
    help: { type: "boolean", short: "h" },
  },
});

const courses = JSON.parse(readFileSync(root("courses.json"), "utf8")) as { id: string; name: string }[];

if (args.help || !args.course) {
  console.log(`Usage: npm run session -- --course <id> [--minutes 10] [--goal "..."]
Options: --interval 5  --mode window|display  --engine document|lines
         --language-correction  --threshold 0.02  --out sessions/
Courses: ${courses.map((c) => c.id).join(", ")}`);
  process.exit(args.help ? 0 : 1);
}

const course = courses.find((c) => c.id === args.course);
if (!course) {
  console.error(`Unknown course "${args.course}". Choose one of: ${courses.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
const minutes = Number(args.minutes);
const intervalMs = Number(args.interval) * 1000;
const threshold = Number(args.threshold);
const mode = args.mode === "display" ? "display" : "window";
const engine = args.engine === "lines" ? "lines" : "document";
const languageCorrection = args["language-correction"];
if (!(minutes > 0) || !(intervalMs >= 1000) || !(threshold >= 0)) {
  console.error("--minutes must be > 0, --interval >= 1 and --threshold >= 0");
  process.exit(1);
}

const helper = new VisionHelper({ lowPriority: true });

if (!(await helper.hasPermission())) {
  await helper.requestPermission();
  console.error(`
Screen Recording permission is needed.

1. macOS may have just shown a prompt. If so, click "Open System Settings".
   Otherwise open: System Settings → Privacy & Security → Screen & System Audio Recording.
2. Turn ON the app you're running this command from (e.g. "Visual Studio Code" or "Terminal").
   If it isn't listed, click "+" and add it from /Applications.
3. Quit that app completely (Cmd+Q) and reopen it — macOS only applies the permission after a restart.
4. Run this command again.
`);
  helper.close();
  process.exit(1);
}

const startedAt = new Date();
const transcript = new TranscriptWriter(args.out, course, startedAt, {
  Goal: args.goal,
  Started: startedAt.toLocaleString(),
  Settings: `every ${intervalMs / 1000}s · ${mode} capture · ${engine} engine · language correction ${languageCorrection ? "on" : "off"}`,
});

const loop = new CaptureLoop({
  helper,
  neverRecord: loadNeverRecord(root("never-record.json")),
  projectName: basename(root(".")),
  settings: { intervalMs, mode, engine, languageCorrection, threshold },
  onEntry: (entry) => transcript.add(entry),
  onLog: (line) => console.log(line),
});

let finished = false;
// Ctrl+C once: finish the current capture, then save. Twice, or closing the terminal: save right away.
process.on("SIGINT", () => {
  if (loop.status === "stopped") {
    finishSession();
    process.exit(130);
  }
  console.log("\nEnding session…");
  loop.stop();
});
for (const sig of ["SIGHUP", "SIGTERM"] as const) {
  process.on(sig, () => {
    loop.stop();
    finishSession();
    process.exit(0);
  });
}

console.log(`Recording ${course.name} for ${minutes} min (Ctrl+C to end early).`);
console.log(`Transcript: ${transcript.mdPath}\n`);
const timer = setTimeout(() => loop.stop(), minutes * 60_000);
await loop.run();
clearTimeout(timer);
finishSession();

function finishSession() {
  if (finished) return;
  finished = true;
  helper.close();
  const s = loop.stats;
  transcript.finish(statsRows(s, loop.activeMs));
  console.log(`
Session saved (${(loop.activeMs / 60_000).toFixed(1)} min).
  Transcript: ${transcript.mdPath}
  Data:       ${transcript.jsonlPath}
  ${s.readOk} reads · ${s.unchanged} unchanged · ${s.neverRecord} skipped (private/own windows) · ${s.errors} errors
  ${s.kept} lines kept · ${s.duplicate} repeats dropped · ${s.noise} noise dropped`);
}

// Stage 1: run a capture session from the terminal.
//   npm run session -- --course math135 --minutes 10
// Press Ctrl+C to end early; the transcript is saved either way.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TextCleaner } from "./clean.ts";
import { VisionHelper } from "./helper.ts";
import { blockedReason, loadNeverRecord, pickFrontWindow } from "./privacy.ts";
import { fixMath } from "./mathfix.ts";
import { redact } from "./redact.ts";
import { TranscriptWriter } from "./transcript.ts";

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

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

const neverRecord = loadNeverRecord(root("never-record.json"));
const projectName = basename(root("."));
const cleaner = new TextCleaner({ engine, mode, minConfidence: 0.35 });
const startedAt = new Date();
const transcript = new TranscriptWriter(args.out, course, startedAt, {
  Goal: args.goal,
  Started: startedAt.toLocaleString(),
  Settings: `every ${intervalMs / 1000}s · ${mode} capture · ${engine} engine · language correction ${languageCorrection ? "on" : "off"}`,
});

const stats = {
  ticks: 0,
  unchanged: 0,
  neverRecord: 0,
  changedMidCapture: 0,
  readOk: 0,
  errors: 0,
  ocrMsTotal: 0,
  linesIn: 0,
  noise: 0,
  duplicate: 0,
  kept: 0,
  redactions: 0,
  mathFixes: 0,
};

let stopping = false;
let finished = false;
// Ctrl+C once: finish the current capture, then save. Twice, or closing the terminal: save right away.
process.on("SIGINT", () => {
  if (stopping) {
    finishSession();
    process.exit(130);
  }
  stopping = true;
  console.log("\nEnding session…");
});
for (const sig of ["SIGHUP", "SIGTERM"] as const) {
  process.on(sig, () => {
    finishSession();
    process.exit(0);
  });
}

console.log(`Recording ${course.name} for ${minutes} min (Ctrl+C to end early).`);
console.log(`Transcript: ${transcript.mdPath}\n`);

const endAt = startedAt.getTime() + minutes * 60_000;
let lastSource = "";
const time = () => new Date().toLocaleTimeString();

while (!stopping && Date.now() < endAt) {
  const tickStart = Date.now();
  stats.ticks++;
  try {
    const windows = await helper.windows();
    const front = pickFrontWindow(windows);
    const reason = front ? blockedReason(front, neverRecord, projectName) : "no window on screen";
    if (!front || reason) {
      stats.neverRecord++;
      lastSource = "";
      console.log(`${time()}  skipped: ${reason}`);
    } else {
      // Force a fresh read whenever the app or window changes.
      const source = `${front.bundleId}|${front.title}`;
      // Whole-display mode also hides any other window that must not be recorded (and this project's own).
      const excludeWindowIds =
        mode === "display"
          ? windows.filter((w) => blockedReason(w, neverRecord, projectName)).map((w) => w.windowId)
          : [];
      const res = await helper.capture({
        mode,
        windowId: front.windowId,
        excludeWindowIds,
        threshold,
        engine,
        languageCorrection,
        force: source !== lastSource,
      });
      lastSource = source;
      const label = `${front.app} — ${front.title || "(untitled)"}`;
      // Check the window again: if the tab or window changed while capturing (say, to Gmail), the
      // image may not match the title we checked, so throw it away and read again next time.
      const after = (await helper.windows()).find((w) => w.windowId === front.windowId);
      if (!res.skipped && (!after || after.title !== front.title)) {
        stats.changedMidCapture++;
        lastSource = "";
        console.log(`${time()}  discarded: window changed while capturing`);
      } else if (res.skipped) {
        stats.unchanged++;
        console.log(`${time()}  unchanged (${(res.changeRatio * 100).toFixed(1)}% different)  ${label}`);
      } else {
        stats.readOk++;
        stats.ocrMsTotal += res.ms ?? 0;
        const { paragraphs, stats: c } = cleaner.clean(res.blocks ?? [], front);
        stats.linesIn += c.linesIn;
        stats.noise += c.noise;
        stats.duplicate += c.duplicate;
        stats.kept += c.kept;
        if (paragraphs.length) {
          const fixed = fixMath(paragraphs.join("\n\n"));
          stats.mathFixes += fixed.count;
          const red = redact(fixed.text);
          stats.redactions += red.count;
          transcript.add({ capturedAt: new Date().toISOString(), app: front.app, title: front.title, text: red.text });
        }
        console.log(
          `${time()}  read ${label}: ${c.linesIn} lines → kept ${c.kept} new, ${c.duplicate} repeated, ${c.noise} noise  (${res.ms} ms)`,
        );
      }
    }
  } catch (err) {
    stats.errors++;
    console.log(`${time()}  error: ${(err as Error).message}`);
  }
  const wait = Math.min(intervalMs - (Date.now() - tickStart), endAt - Date.now());
  // Sleep in short steps so Ctrl+C ends the session promptly.
  for (let t = 0; t < wait && !stopping; t += 250) await sleep(Math.min(250, wait - t));
}

finishSession();

function finishSession() {
  if (finished) return;
  finished = true;
  helper.close();
  const endedAt = new Date();
  const mins = (endedAt.getTime() - startedAt.getTime()) / 60_000;
  transcript.finish({
    Length: `${mins.toFixed(1)} min`,
    "Capture checks": stats.ticks,
    "Read (screen changed)": stats.readOk,
    "Skipped — unchanged": stats.unchanged,
    "Skipped — never-record list or this project": stats.neverRecord,
    "Discarded — window changed mid-capture": stats.changedMidCapture,
    Errors: stats.errors,
    "Average read time": stats.readOk ? `${Math.round(stats.ocrMsTotal / stats.readOk)} ms` : "—",
    "Lines recognised": stats.linesIn,
    "Lines kept": stats.kept,
    "Lines dropped as repeats": stats.duplicate,
    "Lines dropped as noise": stats.noise,
    "Math symbols fixed (∈ ℕ ∀ …)": stats.mathFixes,
    Redactions: stats.redactions,
  });
  console.log(`
Session saved (${mins.toFixed(1)} min).
  Transcript: ${transcript.mdPath}
  Data:       ${transcript.jsonlPath}
  ${stats.readOk} reads · ${stats.unchanged} unchanged · ${stats.neverRecord} skipped (private/own windows) · ${stats.errors} errors
  ${stats.kept} lines kept · ${stats.duplicate} repeats dropped · ${stats.noise} noise dropped`);
}

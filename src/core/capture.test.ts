import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CaptureLoop, DEFAULT_SETTINGS } from "./capture.ts";
import type { TextBlock, VisionHelper, WindowInfo } from "./helper.ts";
import type { TranscriptEntry } from "./transcript.ts";

const win = (title: string, id = 1): WindowInfo => ({
  windowId: id, app: "Google Chrome", bundleId: "com.google.Chrome", pid: 10, title, width: 1400, height: 900,
});
const block = (text: string, y: number): TextBlock => ({ text, confidence: 1, box: { x: 0.1, y, w: 0.6, h: 0.05 } });

/** A pretend screen: `script(t)` says which window is in front and what text it shows at time t (ms). */
function fakeHelper(script: (t: number) => { w: WindowInfo; blocks: TextBlock[] }, mathDelayMs = 0) {
  const t0 = Date.now();
  let lastRead = "";
  const helper = {
    windows: async () => [script(Date.now() - t0).w],
    capture: async () => {
      const { blocks } = script(Date.now() - t0);
      const key = blocks.map((b) => b.text).join("|");
      const changed = key !== lastRead;
      lastRead = key;
      return { skipped: !changed, changeRatio: changed ? 1 : 0, width: 100, height: 100, blocks, ms: 1 };
    },
    image: async () => ({ jpeg: "IMG", width: 10, height: 10 }),
  };
  const mathCalls: string[][] = [];
  const mathPass = async (_img: string, lines: string[]) => {
    mathCalls.push(lines);
    await sleep(mathDelayMs);
    return { lines: lines.map((l) => l.replace("e N", "∈ ℕ")), changed: 1 };
  };
  return { helper: helper as unknown as VisionHelper, mathCalls, mathPass };
}

function makeLoop(h: ReturnType<typeof fakeHelper>, withMath = false) {
  const entries: TranscriptEntry[] = [];
  const loop = new CaptureLoop({
    helper: h.helper,
    neverRecord: { apps: [], titles: [] },
    projectName: "nook",
    settings: { ...DEFAULT_SETTINGS, intervalMs: 40, dwellMs: 150 },
    onEntry: (e) => entries.push(e),
    mathPass: withMath ? h.mathPass : undefined,
  });
  return { loop, entries };
}

test("a page only in front briefly (accidental tab switch) is never read", async () => {
  const notes = { w: win("Lecture notes.pdf", 1), blocks: [block("Proof by induction on n has two steps", 0.3)] };
  const oops = { w: win("Instagram", 2), blocks: [block("Somebody posted a photo of their lunch", 0.3)] };
  const h = fakeHelper((t) => (t > 400 && t < 480 ? oops : notes));
  const { loop, entries } = makeLoop(h);
  const done = loop.run();
  await sleep(900);
  loop.stop();
  await done;
  const text = entries.map((e) => e.text).join("\n");
  assert.match(text, /Proof by induction/);
  assert.doesNotMatch(text, /lunch/);
  assert.ok(loop.stats.dwelling > 0);
});

test("New Tab pages are skipped", async () => {
  const h = fakeHelper(() => ({ w: win("New Tab"), blocks: [block("Gmail Images YouTube Instagram shortcuts", 0.3)] }));
  const { loop, entries } = makeLoop(h);
  const done = loop.run();
  await sleep(400);
  loop.stop();
  await done;
  assert.equal(entries.length, 0);
});

test("math is re-read in the background and text is still saved in order", async () => {
  // Page 1 (math), then page 2 (math), then page 3 (prose). Each math re-read is slow.
  const pages = [
    { w: win("notes.pdf"), blocks: [block("For all n e N, x_n = 2x_(n-1) + 1", 0.3)] },
    { w: win("notes.pdf"), blocks: [block("Then for every n e N, f(n) = n^2", 0.3)] },
    { w: win("notes.pdf"), blocks: [block("The proof is complete and the result follows directly", 0.3)] },
  ];
  const h = fakeHelper((t) => pages[t < 300 ? 0 : t < 450 ? 1 : 2], 250);
  const { loop, entries } = makeLoop(h, true);
  const done = loop.run();
  await sleep(700);
  loop.stop();
  await done; // waits for the queued re-reads
  assert.equal(h.mathCalls.length, 2, "both math pages were re-read");
  assert.deepEqual(
    entries.map((e) => e.text),
    ["For all n ∈ ℕ, x_n = 2x_(n-1) + 1", "Then for every n ∈ ℕ, f(n) = n^2", "The proof is complete and the result follows directly"],
  );
});

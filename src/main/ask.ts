// Stage 4 — circle and ask. During a session: press the shortcut (Option+A) → a transparent overlay
// draws your cursor's path → press it again or click → the circled area (or the area around the
// cursor) is captured and a popup opens where you ask about it. Esc cancels.
import { BrowserWindow, globalShortcut, Notification, screen } from "electron";
import { randomUUID } from "node:crypto";
import { askAboutImage, HINT_LEVELS, type HintLevel } from "../core/ai.ts";
import { cropFor, type Point } from "../core/crop.ts";
import type { StudyDb } from "../core/db.ts";
import type { VisionHelper } from "../core/helper.ts";
import { blockedReason, pickFrontWindow, type NeverRecord } from "../core/privacy.ts";
import type { Settings } from "../core/settings.ts";
import { VoiceHelper } from "../core/voice.ts";
import type { LearnerService } from "./learner.ts";
import type { AskEvent, AskInfo, OverlayEvent } from "../shared/types.ts";

/** What the ask feature needs from the running session. */
export type AskSession = {
  sessionId: string;
  courseId: string;
  courseName: string;
  helper: VisionHelper;
  neverRecord: NeverRecord;
  projectName: string;
  isPaused: () => boolean;
};

type Ask = {
  info: AskInfo;
  sessionId: string;
  courseId: string;
  imageBase64: string; // kept in memory only while the popup is open
  questionId?: string;
  turns: { question: string; level: HintLevel; answer: string }[];
  busy: boolean;
  concept?: { id: string; name: string }; // what the learner model thinks this is about
  window: BrowserWindow;
};

const ASK_SIZE = { width: 480, height: 620 };

/** "Alt+A" -> "⌥A" for on-screen hints. */
function shortcutLabel(accel: string): string {
  return accel
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/gi, "⌘")
    .replace(/Alt|Option/gi, "⌥")
    .replace(/Shift/gi, "⇧")
    .replace(/Control|Ctrl/gi, "⌃")
    .replace(/\+/g, "");
}

export class AskController {
  private session: AskSession | null = null;
  private settings: Settings;
  private tracking = false;
  private path: Point[] = [];
  private poll: NodeJS.Timeout | null = null;
  private overlay: BrowserWindow | null = null;
  private overlayReady: Promise<void> = Promise.resolve();
  private overlayBounds = { x: 0, y: 0, width: 0, height: 0 };
  private asks = new Map<string, Ask>();
  private voice: VoiceHelper | null = null;
  private voiceReady = false; // permissions granted and on-device recognition available
  private listening = false;
  private smokeSpoken = ""; // development check: pretend this was said
  private offVoice: (() => void) | null = null;
  private deps: {
    db: StudyDb;
    preload: string;
    load: (win: BrowserWindow, route: string) => void;
    voicePaths: { visionHelper: string; voice: string };
    learner: LearnerService;
  };

  constructor(settings: Settings, deps: AskController["deps"]) {
    this.settings = settings;
    this.deps = deps;
  }

  // ---------- session start/end ----------

  /** Turns the shortcut on for this session. Returns a message if it couldn't be registered. */
  startSession(session: AskSession, settings: Settings): string | null {
    this.session = session;
    this.settings = settings;
    // Create the overlay now (hidden) so it's loaded and ready the moment you press the shortcut.
    if (!this.overlay) this.overlay = this.makeOverlay();
    if (settings.ask.voice) void this.setUpVoice(settings.ask.locale);
    const accel = settings.ask.shortcut;
    try {
      if (globalShortcut.register(accel, () => this.onShortcut())) return null;
    } catch {
      /* invalid accelerator text */
    }
    return `The ask shortcut "${accel}" couldn't be set up (another app may use it). Change "shortcut" in settings.json.`;
  }

  /**
   * Starts Study Buddy Voice and, the first time, asks macOS for Microphone and Speech Recognition
   * permission. Voice stays off (typing still works) if either is refused.
   */
  private async setUpVoice(locale: string) {
    try {
      this.voice = new VoiceHelper(this.deps.voicePaths);
      this.offVoice = this.voice.onEvent((e) => {
        if (!this.listening) return;
        if (e.event === "partial") this.send({ type: "speech", text: e.text });
        else this.send({ type: "level", value: e.value });
      });
      let st = await this.voice.status(locale);
      if (st.mic === "not-asked" || st.speech === "not-asked") st = await this.voice.requestPermission();
      if (st.mic !== "granted" || st.speech !== "granted") {
        const missing = [st.mic !== "granted" && "Microphone", st.speech !== "granted" && "Speech Recognition"].filter(Boolean).join(" and ");
        this.notify(`Voice is off: ${missing} permission for "Study Buddy Voice" isn't on. You can still type questions.`);
        return;
      }
      if (!(await this.voice.status(locale)).onDevice) {
        this.notify("Voice is off: on-device speech recognition isn't set up. Turn on Dictation once in System Settings → Keyboard.");
        return;
      }
      this.voiceReady = true;
    } catch (err) {
      console.log(`[ask] voice unavailable: ${(err as Error).message}`);
    }
  }

  endSession() {
    if (this.listening) void this.voice?.cancel().catch(() => {});
    this.listening = false;
    this.offVoice?.();
    this.voice?.close();
    this.voice = null;
    this.voiceReady = false;
    if (this.tracking) this.stopTracking();
    try {
      globalShortcut.unregister(this.settings.ask.shortcut);
    } catch {
      /* not registered */
    }
    this.session = null;
  }

  // ---------- circling ----------

  private onShortcut() {
    if (this.tracking) void this.finish();
    else void this.begin();
  }

  /** Called when the overlay is clicked: same as pressing the shortcut again. */
  overlayClicked() {
    if (this.tracking) void this.finish();
  }

  private notify(body: string) {
    new Notification({ title: "Study Buddy", body }).show();
  }

  private async begin() {
    const s = this.session;
    if (!s) return;
    if (s.isPaused()) return this.notify("The session is paused. Resume it to ask a question.");
    // Respect the never-record list: no asking about private windows.
    const front = pickFrontWindow(await s.helper.windows());
    const reason = front && front.pid !== process.pid ? blockedReason(front, s.neverRecord, s.projectName) : null;
    if (reason && !reason.includes("this project")) return this.notify(`Asking is off here: ${reason}.`);

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    this.overlayBounds = display.bounds;
    if (!this.overlay) this.overlay = this.makeOverlay();
    await this.overlayReady;
    if (!this.overlay) return;
    this.overlay.setBounds(display.bounds);
    this.overlay.setOpacity(1);
    this.tracking = true;
    this.path = [cursor];
    this.overlay.showInactive();
    this.send({ type: "start", shortcutLabel: shortcutLabel(this.settings.ask.shortcut) });
    // Microphone on, only until this question is sent or cancelled.
    if (this.voice && this.voiceReady) {
      this.voice
        .start(this.settings.ask.locale)
        .then(() => {
          if (!this.tracking) return void this.voice?.cancel().catch(() => {}); // cancelled meanwhile
          this.listening = true;
          this.send({ type: "voice", state: "listening" });
        })
        .catch((err) => this.send({ type: "voice", state: "unavailable", message: (err as Error).message }));
    } else {
      this.send({ type: "voice", state: "off" });
    }
    try {
      globalShortcut.register("Escape", () => this.cancel());
    } catch {
      /* Esc taken: the overlay still handles it */
    }
    // Track the cursor ~60 times a second and draw its path on the overlay.
    this.poll = setInterval(() => {
      const p = screen.getCursorScreenPoint();
      const last = this.path[this.path.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) this.path.push(p);
      this.send({
        type: "path",
        points: this.path.map((q) => ({ x: q.x - this.overlayBounds.x, y: q.y - this.overlayBounds.y })),
      });
    }, 16);
  }

  private makeOverlay(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      type: "panel", // doesn't take focus from the app you're studying in
      backgroundColor: "#00000000",
      webPreferences: { preload: this.deps.preload, sandbox: true, contextIsolation: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on("closed", () => (this.overlay = null));
    this.overlayReady = new Promise((resolve) => win.webContents.once("did-finish-load", () => resolve()));
    this.deps.load(win, "overlay");
    return win;
  }

  private send(e: OverlayEvent) {
    this.overlay?.webContents.send("overlay:event", e);
  }

  private stopTracking() {
    this.tracking = false;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    try {
      globalShortcut.unregister("Escape");
    } catch {
      /* not registered */
    }
    this.send({ type: "end" });
    this.overlay?.setOpacity(0); // vanish at once (hide() fades out, which can end up in the screenshot)
    this.overlay?.hide();
  }

  cancel() {
    if (!this.tracking) return;
    if (this.listening) void this.voice?.cancel().catch(() => {}); // microphone off, words thrown away
    this.listening = false;
    this.stopTracking();
  }

  /** Development check: circle along `path` (global points) as if the shortcut were pressed twice. */
  async smoke(path: Point[], dir: string, question = "how do I find the limit of this sequence"): Promise<string | null> {
    await this.begin();
    if (!this.tracking) return null;
    this.path = path;
    this.send({ type: "path", points: path.map((q) => ({ x: q.x - this.overlayBounds.x, y: q.y - this.overlayBounds.y })) });
    if (this.poll) clearInterval(this.poll); // keep the pretend path instead of the real cursor
    this.poll = null;
    // Pretend voice: show the listening panel as it would look mid-question.
    this.send({ type: "voice", state: "listening" });
    this.send({ type: "level", value: 0.7 });
    this.send({ type: "speech", text: question });
    await new Promise((r) => setTimeout(r, 800));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/overlay.png`, (await this.overlay!.webContents.capturePage()).toPNG());
    console.log(
      "SMOKE overlay drawn pixels:",
      await this.overlay!.webContents.executeJavaScript(`(() => {
        const c = document.querySelector("canvas"); if (!c) return "no canvas";
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n + " of " + (c.width * c.height) + "; hint: " + (document.body.innerText || "(none)");
      })()`),
    );
    const before = new Set(this.asks.keys());
    this.smokeSpoken = question;
    await this.finish();
    this.smokeSpoken = "";
    return [...this.asks.keys()].find((k) => !before.has(k)) ?? null;
  }

  windowFor(askId: string): BrowserWindow | null {
    return this.asks.get(askId)?.window ?? null;
  }

  isOverlay(win: BrowserWindow | null): boolean {
    return !!win && win === this.overlay;
  }

  private async finish() {
    const s = this.session;
    if (!s || !this.tracking) return;
    const cursor = this.poll ? screen.getCursorScreenPoint() : this.path[this.path.length - 1];
    const path = [...this.path];
    // Microphone off now; the last words finish recognizing while the screen is captured.
    const spoken = this.listening && this.voice ? this.voice.stop().catch(() => "") : Promise.resolve(this.smokeSpoken);
    this.listening = false;
    this.stopTracking();
    await new Promise((r) => setTimeout(r, 250)); // let the overlay leave the screen before capturing
    const display = screen.getDisplayNearestPoint(cursor);
    const { rect, circled } = cropFor(path, cursor, {
      x: display.bounds.x,
      y: display.bounds.y,
      w: display.bounds.width,
      h: display.bounds.height,
    }, this.settings.ask);
    try {
      // Leave out Study Buddy's own windows and any never-record window that's visible.
      const windows = await s.helper.windows();
      const blocked = windows
        .filter((w) => w.pid !== process.pid && blockedReason(w, s.neverRecord, s.projectName))
        .map((w) => w.windowId);
      // The screen sometimes captures as solid black just after the overlay closes: try again briefly.
      let shot = await s.helper.snap({ x: cursor.x, y: cursor.y, rect, excludePids: [process.pid], excludeWindowIds: blocked });
      for (let attempt = 0; shot.black && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 200));
        shot = await s.helper.snap({ x: cursor.x, y: cursor.y, rect, excludePids: [process.pid], excludeWindowIds: blocked });
      }
      if (shot.black) console.log("[ask] the capture is still black after retries");
      const front = pickFrontWindow(windows.filter((w) => w.pid !== process.pid));
      this.openAsk(s, shot.jpeg, circled, front?.title ?? "", cursor, await spoken);
    } catch (err) {
      this.notify(`Couldn't capture the screen: ${(err as Error).message}`);
    }
  }

  // ---------- the ask popup ----------

  private openAsk(s: AskSession, jpeg: string, circled: boolean, sourceTitle: string, near: Point, spoken = "") {
    const askId = randomUUID();
    const area = screen.getDisplayNearestPoint(near).workArea;
    const x = Math.min(Math.max(near.x + 16, area.x + 8), area.x + area.width - ASK_SIZE.width - 8);
    const y = Math.min(Math.max(near.y + 16, area.y + 8), area.y + area.height - ASK_SIZE.height - 8);
    const win = new BrowserWindow({
      ...ASK_SIZE,
      x,
      y,
      minWidth: 380,
      minHeight: 420,
      show: false,
      title: "Ask",
      titleBarStyle: "hiddenInset",
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      webPreferences: { preload: this.deps.preload, sandbox: true, contextIsolation: true },
    });
    this.asks.set(askId, {
      info: { askId, courseName: s.courseName, thumbnail: `data:image/jpeg;base64,${jpeg}`, circled, sourceTitle },
      sessionId: s.sessionId,
      courseId: s.courseId,
      imageBase64: jpeg,
      turns: [],
      busy: false,
      window: win,
    });
    // Closing the popup forgets the screenshot.
    win.on("closed", () => this.asks.delete(askId));
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
      // A spoken question is asked straight away (you can still edit it and ask again).
      if (spoken) setTimeout(() => void this.ask(askId, spoken, "auto"), 150);
    });
    this.deps.load(win, `ask/${askId}`);
  }

  info(askId: string): AskInfo | null {
    return this.asks.get(askId)?.info ?? null;
  }

  /** Answers at a hint level, streaming to the popup. The first question is saved to the session. */
  /**
   * Answers at a hint level, streaming to the popup. "auto" (a new question) lets the learner model
   * choose where to start: what has helped you with this concept before, or a different approach
   * if you already asked about it today.
   */
  async ask(askId: string, question: string, requested: HintLevel | "auto") {
    const a = this.asks.get(askId);
    if (!a || a.busy) return;
    const q = question.trim().slice(0, 2000);
    if (!q) return;
    a.busy = true;
    const turn = a.turns.length;
    const emit = (e: AskEvent) => {
      if (!a.window.isDestroyed()) a.window.webContents.send("ask:event", e);
    };
    const learner = this.deps.learner;
    try {
      // A new or edited question is saved as its own question; hint-ladder follow-ups add answers to it.
      const previous = a.turns[a.turns.length - 1]?.question;
      const isNew = !a.questionId || (previous !== undefined && previous !== q);
      if (isNew) {
        a.questionId = this.deps.db.addQuestion(a.sessionId, a.courseId, q, a.info.sourceTitle);
        a.concept = (await learner.conceptForQuestion(a.courseId, q).catch(() => null)) ?? undefined;
      }
      let level: HintLevel = requested === "auto" ? "nudge" : requested;
      let reason = "";
      if (requested === "auto") ({ level, reason } = learner.startLevel(a.sessionId, a.concept?.id ?? null));
      emit({ askId, type: "start", turn, level, question: q, reason, concept: a.concept?.name });

      // This session's notes plus related ones from earlier sessions of the course.
      const passages = await learner.passagesFor(a.courseId, a.sessionId, q);
      emit({
        askId,
        type: "sources",
        turn,
        sources: passages.map((p) => ({ title: p.sourceTitle || "unknown window", when: p.when })),
      });
      const note = learner.learnerNote(a.concept?.id ?? null, learner.connections(a.sessionId, a.courseId));
      const answer = await askAboutImage(
        { imageBase64: a.imageBase64, question: q, course: a.info.courseName, level, passages, earlier: a.turns, learner: note },
        (text) => emit({ askId, type: "text", turn, text }),
      );
      a.turns.push({ question: q, level, answer });
      this.deps.db.addAnswer(a.questionId!, HINT_LEVELS[level].label, answer);
      if (a.concept) learner.recordAsk(a.sessionId, a.questionId!, a.concept.id, level, isNew);
      emit({ askId, type: "done", turn });
    } catch (err) {
      emit({ askId, type: "error", turn, message: (err as Error).message });
    } finally {
      a.busy = false;
    }
  }
}

// Study Buddy in the app: watches what you read during a session (through the capture loop), and when
// you've finished a concept, shows the buddy's small window in the bottom corner with one question.
// Your answer (typed or spoken) is judged by the AI, which only picks the buddy's reaction and updates
// the learner model; the chat is saved to the session's review.
import { BrowserWindow, powerMonitor, screen } from "electron";
import { urgently, type AiConfig } from "../core/ai.ts";
import {
  BUDDY_CHARACTERS,
  BuddyTrigger,
  buddyQuestion,
  buddyReact,
  closingLine,
  focusFor,
  nextStep,
  type BuddyCharacter,
  type BuddyTurn,
  type Candidate,
  type Focus,
  type TriggerOptions,
} from "../core/buddy.ts";
import type { StudyDb } from "../core/db.ts";
import type { Settings } from "../core/settings.ts";
import type { TranscriptEntry } from "../core/transcript.ts";
import type { BuddyView } from "../shared/types.ts";
import type { AskController } from "./ask.ts";
import type { LearnerService } from "./learner.ts";

const SIZE = { width: 360, height: 330 };
/** The window leaves on its own if you don't touch it for this long. */
const IGNORED_MS = 3 * 60_000;

type Chat = {
  id: string;
  candidate: Candidate;
  concept: string; // the idea asked about (model's name for it)
  turns: BuddyTurn[];
  followUps: number;
  lastVerdict?: "solid" | "gap";
  finished: boolean;
};

type BuddySession = { sessionId: string; courseId: string; courseName: string; isPaused: () => boolean };

export class BuddyService {
  private deps: {
    db: StudyDb;
    learner: LearnerService;
    asker: AskController;
    preload: string;
    load: (win: BrowserWindow, route: string) => void;
    settings: () => Settings;
    model: () => AiConfig;
  };
  private session: BuddySession | null = null;
  private trigger = new BuddyTrigger();
  private textByTitle = new Map<string, string>(); // latest text read from each window
  private concepts: { id: string; name: string }[] = [];
  private conceptsAt = 0;
  private win: BrowserWindow | null = null;
  private view: BuddyView | null = null;
  private chat: Chat | null = null;
  private preparing = false;
  private ignoredTimer: NodeJS.Timeout | null = null;

  constructor(deps: BuddyService["deps"]) {
    this.deps = deps;
  }

  // ---------- session ----------

  /** `timing` overrides the trigger's timings (development checks use seconds instead of minutes). */
  startSession(s: BuddySession, timing: Partial<TriggerOptions> = {}) {
    this.session = s;
    this.trigger = new BuddyTrigger({ cooldownMs: this.deps.settings().buddy.minMinutes * 60_000, ...timing });
    this.textByTitle.clear();
    this.conceptsAt = 0;
  }

  endSession() {
    if (this.chat) this.leave("skipped");
    this.session = null;
  }

  /** Each capture's text (to know what you just read). */
  onEntry(e: TranscriptEntry) {
    if (!this.session) return;
    const prev = this.textByTitle.get(e.title) ?? "";
    // Keep the most recent ~3000 characters read on this page.
    this.textByTitle.set(e.title, (prev ? `${prev}\n\n${e.text}` : e.text).slice(-3000));
  }

  /** Each screen check: where you are now; maybe it's the moment to appear. */
  onObserve(o: { page: string; title: string }) {
    const s = this.session;
    if (!s) return;
    if (Date.now() - this.conceptsAt > 5 * 60_000) {
      this.concepts = this.deps.db.getConcepts(s.courseId).map((c) => ({ id: c.id, name: c.name }));
      this.conceptsAt = Date.now();
    }
    const now = Date.now();
    this.trigger.observe(now, focusFor(o.page, o.title, this.textByTitle.get(o.title) ?? "", this.concepts));
    if (this.chat || this.preparing) return;
    const settings = this.deps.settings().buddy;
    const decision = this.trigger.decide(now, {
      enabled: settings.enabled && !!settings.character,
      paused: s.isPaused(),
      asking: this.deps.asker.isBusy(),
      lastAskAt: this.deps.asker.lastAskTime(),
      idleMs: powerMonitor.getSystemIdleTime() * 1000, // keyboard/mouse idle time (no input monitoring needed)
      mastery: (id) => this.deps.learner.conceptState(id),
    });
    if (decision && "skip" in decision) console.log(`[buddy] not now: ${decision.skip}`);
    if (decision && "show" in decision) void this.appear(decision.show, settings.character as BuddyCharacter, settings.name);
  }

  // ---------- the chat ----------

  private async appear(c: Candidate, character: BuddyCharacter, name: string) {
    const s = this.session;
    if (!s) return;
    this.preparing = true;
    try {
      const known = this.concepts.map((x) => x.name);
      const q = await buddyQuestion(
        { character, name: displayName(character, name), course: s.courseName, focusLabel: c.focus.label, text: c.focus.text ?? "", knownConcepts: known },
        this.deps.model(),
      );
      // Things may have changed while the question was being written (the AI may have been busy with
      // math re-reads): if you've started circling, or are well into the next thing, let it go.
      const stale = Date.now() - c.finishedAt > this.trigger.opts.graceMs + 30_000;
      if (this.session !== s || this.deps.asker.isBusy() || stale) return void this.trigger.dropPending();
      this.trigger.shown(Date.now(), c);
      this.open(s, c, character, name, q);
    } catch (err) {
      console.log(`[buddy] couldn't think of a question: ${(err as Error).message}`);
      this.trigger.dropPending();
    } finally {
      this.preparing = false;
    }
  }

  /** Opens the window with a question. (Also used by development checks with a made-up candidate.) */
  open(s: BuddySession, c: Candidate, character: BuddyCharacter, name: string, q: { question: string; concept: string }) {
    const turns: BuddyTurn[] = [{ who: "buddy", text: q.question, at: new Date().toISOString() }];
    const id = this.deps.db.addBuddyChat({
      sessionId: s.sessionId,
      courseId: s.courseId,
      conceptId: c.focus.conceptId,
      topic: q.concept,
      character,
      buddyName: displayName(character, name),
      turns,
    });
    this.chat = { id, candidate: c, concept: q.concept, turns, followUps: 0, finished: false };
    this.view = {
      character,
      name: displayName(character, name),
      mood: "asking",
      line: q.question,
      canAnswer: true,
      voice: this.deps.asker.canDictate() ? "ready" : "off",
      done: false,
    };
    this.showWindow();
    this.resetIgnoredTimer();
  }

  private showWindow() {
    if (!this.win || this.win.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      this.win = new BrowserWindow({
        ...SIZE,
        x: area.x + area.width - SIZE.width - 16,
        y: area.y + area.height - SIZE.height - 16,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        type: "panel", // floats above your work without taking focus from it
        backgroundColor: "#00000000",
        webPreferences: { preload: this.deps.preload, sandbox: true, contextIsolation: true },
      });
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.win.on("closed", () => {
        this.win = null;
        if (this.chat) this.leave(this.chat.lastVerdict ?? "skipped", true);
      });
      this.win.once("ready-to-show", () => this.win?.showInactive()); // never steals focus
      this.deps.load(this.win, "buddy");
    } else {
      this.push();
      this.win.showInactive();
    }
  }

  private push() {
    if (this.view && this.win && !this.win.isDestroyed()) this.win.webContents.send("buddy:view", this.view);
  }

  private set(v: Partial<BuddyView>) {
    if (!this.view) return;
    this.view = { ...this.view, ...v };
    this.push();
  }

  getView(): BuddyView | null {
    return this.view;
  }

  private resetIgnoredTimer() {
    if (this.ignoredTimer) clearTimeout(this.ignoredTimer);
    this.ignoredTimer = setTimeout(() => {
      if (this.chat && this.view?.canAnswer && this.view.voice !== "listening") this.leave(this.chat.lastVerdict ?? "skipped");
    }, IGNORED_MS);
  }

  /** You answered (typed, or the words heard when the microphone went off). */
  async answer(text: string) {
    const chat = this.chat;
    const s = this.session ?? this.smokeSession;
    if (!chat || chat.finished || !s || !this.view?.canAnswer) return;
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!clean) return;
    this.resetIgnoredTimer();
    chat.turns.push({ who: "you", text: clean, at: new Date().toISOString() });
    this.deps.db.updateBuddyChat(chat.id, { turns: chat.turns });
    this.set({ mood: "thinking", line: "Hmm…", canAnswer: false, partial: undefined });
    try {
      const r = await urgently(() =>
        buddyReact(
          { character: this.view!.character, name: this.view!.name, course: s.courseName, text: chat.candidate.focus.text ?? "", turns: chat.turns },
          this.deps.model(),
        ),
      );
      if (this.chat !== chat) return; // closed meanwhile
      chat.lastVerdict = r.verdict;
      chat.turns[chat.turns.length - 1].verdict = r.verdict;
      const step = nextStep(r.verdict, chat.followUps, r.followUp);
      if (step.ask) {
        chat.followUps++;
        chat.turns.push({ who: "buddy", text: step.ask, at: new Date().toISOString() });
        this.deps.db.updateBuddyChat(chat.id, { turns: chat.turns });
        this.set({ mood: "confused", line: step.ask, canAnswer: true });
        return;
      }
      const line = closingLine(this.view!.character, step.mood === "happy" ? "happy" : "thanks");
      chat.turns.push({ who: "buddy", text: line, at: new Date().toISOString() });
      this.set({ mood: step.mood, line, canAnswer: false, done: true });
      this.finish(r.verdict === "solid" ? "understood" : "gap");
      setTimeout(() => this.closeWindow(), 4500);
    } catch (err) {
      console.log(`[buddy] couldn't react: ${(err as Error).message}`);
      const line = "Oh — my brain just froze. Thanks anyway, talk later!";
      chat.turns.push({ who: "buddy", text: line, at: new Date().toISOString() });
      this.set({ mood: "thanks", line, canAnswer: false, done: true });
      this.finish(chat.lastVerdict === "gap" ? "gap" : "skipped");
      setTimeout(() => this.closeWindow(), 4000);
    }
  }

  /** Saves the chat and, if you answered, what it showed about the concept (learner model). */
  private finish(outcome: "understood" | "gap" | "skipped") {
    const chat = this.chat;
    const s = this.session ?? this.smokeSession;
    if (!chat || chat.finished || !s) return;
    chat.finished = true;
    let conceptId = chat.candidate.focus.conceptId;
    if (outcome !== "skipped") {
      conceptId ??= this.deps.db.upsertConcept(s.courseId, chat.concept);
      this.deps.db.addEvidence(conceptId, { at: new Date().toISOString(), kind: "explain", correct: outcome === "understood", sessionId: s.sessionId, refId: chat.id });
    }
    this.deps.db.updateBuddyChat(chat.id, { turns: chat.turns, outcome, conceptId });
  }

  /** Ends the chat now (closing the window, "Not now", or ignored). */
  private leave(outcome: "understood" | "gap" | "skipped" | "solid", windowGone = false) {
    void this.deps.asker.cancelDictation();
    this.finish(outcome === "solid" ? "understood" : outcome);
    this.chat = null;
    this.view = null;
    if (this.ignoredTimer) clearTimeout(this.ignoredTimer);
    if (!windowGone) this.closeWindow();
  }

  private closeWindow() {
    if (this.chat?.finished) {
      this.chat = null;
      this.view = null;
    }
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }

  // ---------- buttons ----------

  /** "Not now": away for 20 minutes. */
  notNow() {
    this.trigger.snooze(Date.now());
    if (this.chat) this.leave(this.chat.lastVerdict ?? "skipped");
  }

  /** "Pause for this session". */
  pauseForSession() {
    this.trigger.pauseForSession();
    if (this.chat) this.leave(this.chat.lastVerdict ?? "skipped");
  }

  close() {
    if (this.chat) this.leave(this.chat.lastVerdict ?? "skipped");
    else this.closeWindow();
  }

  /** Microphone button: first press listens, second press stops and answers with what was heard. */
  async mic() {
    if (!this.view?.canAnswer) return;
    this.resetIgnoredTimer();
    if (this.view.voice === "listening") {
      this.set({ voice: "ready", level: 0 });
      const said = await this.deps.asker.stopDictation();
      if (said.trim()) await this.answer(said);
      return;
    }
    try {
      await this.deps.asker.startDictation((e) => {
        if (e.event === "partial") this.set({ partial: e.text });
        else this.set({ level: e.value });
      });
      this.set({ voice: "listening", partial: "" });
    } catch {
      this.set({ voice: "unavailable" });
    }
  }

  // ---------- development checks ----------

  private smokeSession: BuddySession | null = null;

  /** Shows the buddy with a made-up moment (no capture needed). */
  smokeOpen(s: BuddySession, character: BuddyCharacter, name: string, focus: Focus, q: { question: string; concept: string }) {
    this.smokeSession = s;
    this.open(s, { focus, dwellMs: 300_000, finishedAt: Date.now() }, character, name, q);
  }

  /** Is this the buddy's window? */
  isWindow(win: BrowserWindow | null): boolean {
    return !!win && win === this.win;
  }

  windowForSmoke(): BrowserWindow | null {
    return this.win;
  }
}

/** The name you gave the buddy, or its default. */
export function displayName(character: BuddyCharacter, name: string): string {
  return name.trim() || BUDDY_CHARACTERS.find((c) => c.id === character)!.defaultName;
}

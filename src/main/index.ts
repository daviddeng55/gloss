// Main process: the menu bar icon, the capture session, the database, and the windows.
// (Electron's "main process" is the hidden Node program; windows are separate "renderer" processes.)
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { checkAi, MATH_READER, readMathParagraphs } from "../core/ai.ts";
import { CaptureLoop, DEFAULT_SETTINGS } from "../core/capture.ts";
import { Chunker } from "../core/chunker.ts";
import { StudyDb } from "../core/db.ts";
import { VisionHelper } from "../core/helper.ts";
import { loadNeverRecord } from "../core/privacy.ts";
import type { AppState, Course, StartResult } from "../shared/types.ts";
import { loadSettings, sanitizeSettings, type Settings } from "../core/settings.ts";
import { writeFileSync } from "node:fs";
import { ConfusionDetector } from "../core/confusion.ts";
import { AskController } from "./ask.ts";
import { LearnerService } from "./learner.ts";
import { ReviewService } from "./review.ts";

const ROOT = app.getAppPath(); // the project folder while developing
const fromRoot = (...p: string[]) => join(ROOT, ...p);

type Current = {
  sessionId: string;
  course: Course;
  goal?: string;
  startedAt: string;
  loop: CaptureLoop;
  chunker: Chunker;
  helper: VisionHelper;
  done: Promise<void>;
  chunks: number;
  autoPaused: boolean; // paused because the screen locked or the Mac slept
};

let db: StudyDb;
let tray: Tray;
let popup: BrowserWindow | null = null;
let history: BrowserWindow | null = null;
let reviewWin: BrowserWindow | null = null;
let reviews: ReviewService;
let asker: AskController;
let learner: LearnerService;
let learnWin: BrowserWindow | null = null;
let warmupWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let current: Current | null = null;
let lastMenuKey = "";
let aiProblem = ""; // shown in the menu when the local AI isn't available

// ---------- helpers ----------

function loadCourses(): Course[] {
  return JSON.parse(readFileSync(fromRoot("courses.json"), "utf8"));
}

/** 754000 ms -> "12:34"; over an hour -> "1:02:34". */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getState(): AppState {
  if (!current) return { status: "idle" };
  return {
    status: current.loop.status === "paused" ? "paused" : "recording",
    sessionId: current.sessionId,
    courseId: current.course.id,
    courseName: current.course.name,
    goal: current.goal,
    startedAt: current.startedAt,
    activeMs: current.loop.activeMs,
  };
}

function broadcast() {
  const state = getState();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("state", state);
  updateTray();
}

// ---------- menu bar ----------

const icons = {
  idle: () => nativeImage.createFromPath(fromRoot("resources", "trayIdleTemplate.png")),
  paused: () => nativeImage.createFromPath(fromRoot("resources", "trayPausedTemplate.png")),
  recording: () => nativeImage.createFromPath(fromRoot("resources", "trayRecording.png")),
};

function updateTray() {
  const state = getState();
  tray.setTitle(state.status === "idle" ? "" : ` ${clock(state.activeMs)}`, { fontType: "monospacedDigit" });
  // Only rebuild the menu and icon when something other than the clock changed.
  const key = (state.status === "idle" ? "idle" : `${state.status}|${state.sessionId}`) + `|${aiProblem}`;
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  tray.setImage(icons[state.status]());
  tray.setToolTip(state.status === "idle" ? "Gloss" : `Gloss: ${state.status} ${state.courseName}`);

  const common: Electron.MenuItemConstructorOptions[] = [
    ...(aiProblem
      ? [
          { type: "separator" as const },
          { label: `⚠︎ ${aiProblem}`, enabled: false },
          { label: "Open Ollama", click: () => void shell.openPath("/Applications/Ollama.app") },
        ]
      : []),
    { type: "separator" },
    { label: "History…", click: showHistory },
    { label: "How You Learn…", click: openLearn },
    { label: "Settings…", accelerator: "Command+,", click: openSettings },
    { type: "separator" },
    { label: "Quit Gloss", accelerator: "Command+Q", click: () => app.quit() },
  ];
  const items: Electron.MenuItemConstructorOptions[] =
    state.status === "idle"
      ? [{ label: "Start Session…", click: showStartPopup }, ...common]
      : [
          { label: `${state.status === "paused" ? "Paused" : "Recording"}: ${state.courseName}`, enabled: false },
          ...(state.goal ? [{ label: `Goal: ${state.goal}`, enabled: false }] : []),
          { type: "separator" },
          state.status === "paused"
            ? { label: "Resume", click: resumeSession }
            : { label: "Pause", click: pauseSession },
          { label: "End Session", click: () => void endSession() },
          ...common,
        ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- sessions ----------

async function startSession(courseId: string, goal: string): Promise<StartResult> {
  if (current) return { ok: false, reason: "busy", message: "A session is already running." };
  const course = loadCourses().find((c) => c.id === courseId);
  if (!course) return { ok: false, reason: "error", message: `Unknown course "${courseId}".` };

  let helper: VisionHelper;
  try {
    helper = new VisionHelper({ lowPriority: true, helperPath: fromRoot("bin", "vision-helper") });
    if (!(await helper.hasPermission())) {
      await helper.requestPermission(); // adds this app to the list in System Settings
      helper.close();
      return {
        ok: false,
        reason: "permission",
        message: "Gloss needs Screen Recording permission to read your screen during sessions.",
      };
    }
  } catch (err) {
    return { ok: false, reason: "error", message: (err as Error).message };
  }

  const startedAt = new Date().toISOString();
  const cleanGoal = goal.trim().slice(0, 200) || undefined;
  const sessionId = db.createSession({ courseId, goal: cleanGoal, startedAt });
  const session: Partial<Current> = { sessionId, course, goal: cleanGoal, startedAt, helper, chunks: 0, autoPaused: false };
  session.chunker = new Chunker((chunk) => {
    db.addChunk(sessionId, courseId, chunk);
    session.chunks!++;
  });
  const settings = loadSettings(fromRoot("settings.json"));
  const confusion = settings.learn.offerHelpWhenStuck ? new ConfusionDetector() : null;
  const shortcutText = () => settings.ask.shortcut.replace(/Alt|Option/i, "⌥").replace(/\+/g, "");
  // Math courses: re-read new math with the AI model (only if Ollama is ready; otherwise skip quietly).
  const mathReady = course.math ? await checkAi(MATH_READER) : null;
  if (mathReady && !mathReady.ok) console.log(`[capture] math reading off: ${mathReady.error.message}`);
  session.loop = new CaptureLoop({
    helper,
    mathPass: mathReady?.ok ? (img, paragraphs, which) => readMathParagraphs(img, paragraphs, which) : undefined,
    neverRecord: loadNeverRecord(fromRoot("never-record.json")),
    projectName: basename(ROOT),
    ownPids: [process.pid], // never capture Gloss's own windows
    settings: {
      ...DEFAULT_SETTINGS,
      intervalMs: settings.capture.intervalSeconds * 1000,
      dwellMs: settings.capture.dwellSeconds * 1000,
    },
    onEntry: (entry) => session.chunker!.add(entry),
    onObserve: (o) => {
      // Noticing when you might be stuck: a quiet offer of help, never an interruption.
      const hint = confusion?.observe({ at: Date.now(), ...o });
      if (hint) new Notification({ title: "Gloss", body: `${hint} (${shortcutText()})`, silent: true }).show();
    },
    onLog: (line) => console.log(`[capture] ${line}`),
  });
  session.done = session.loop.run();
  current = session as Current;
  // Circle and ask (Stage 4): the shortcut only works while this session runs.
  const askProblem = asker.startSession(
    {
      sessionId,
      courseId,
      courseName: course.name,
      helper,
      neverRecord: loadNeverRecord(fromRoot("never-record.json")),
      projectName: basename(ROOT),
      isPaused: () => current?.loop.status === "paused",
    },
    // Development checks never trigger the real microphone/speech permission prompts.
    ((st) => (process.env.GLOSS_SMOKE_ASK ? { ...st, ask: { ...st.ask, voice: false } } : st))(loadSettings(fromRoot("settings.json"))),
  );
  if (askProblem) console.log(`[ask] ${askProblem}`);
  // Warm-up: questions you're due to review in this course (wrong ones first).
  if (!process.env.GLOSS_SMOKE_ASK && !process.env.GLOSS_SMOKE_SESSION && learner.warmup(sessionId, courseId)) openWarmup(sessionId);
  popup?.hide();
  broadcast();
  return { ok: true };
}

function pauseSession() {
  if (!current) return;
  current.loop.pause();
  current.autoPaused = false;
  db.updateActiveTime(current.sessionId, current.loop.activeMs);
  broadcast();
}

function resumeSession() {
  if (!current) return;
  current.loop.resume();
  current.autoPaused = false;
  broadcast();
}

/** Sessions that have ended but are still saving (finishing math re-reads). Quit waits for these. */
const finishing = new Set<Promise<void>>();

/**
 * Ends the session right away (the menu bar goes back to idle), then finishes in the background:
 * queued math re-reads complete (up to a few minutes), the text is saved, and the summary and quiz follow.
 */
function endSession(): Promise<void> {
  if (!current) return Promise.resolve();
  const c = current;
  const endedAt = new Date().toISOString();
  asker.endSession();
  c.loop.stop();
  current = null;
  broadcast();
  const saved = c.done.then(() => {
    c.chunker.flush();
    c.helper.close();
    db.endSession(c.sessionId, { endedAt, activeMs: c.loop.activeMs, stats: c.loop.stats });
  });
  finishing.add(saved);
  void saved.finally(() => finishing.delete(saved));
  if (!quitting) {
    reviews.ensure(c.sessionId, saved); // summary, then quiz, once the text is saved
    openReview(c.sessionId);
    // Afterwards, quietly give the new notes embeddings (course memory), if the model is there.
    void saved.then(() => reviews.whenIdle()).then(() => learner.backfillEmbeddings()).catch(() => {});
  }
  return saved;
}

// ---------- windows ----------

const preload = join(import.meta.dirname, "../preload/index.cjs");

function load(win: BrowserWindow, route: string) {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${route}`);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash: `/${route}` });
  }
}

const POPUP = { width: 340, height: 440 };

function showStartPopup() {
  if (!popup) {
    popup = new BrowserWindow({
      ...POPUP,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      vibrancy: "popover",
      visualEffectState: "active",
      backgroundColor: "#00000000",
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    popup.on("blur", () => popup?.hide());
    load(popup, "start");
  }
  // Drop down from the menu bar icon, kept on screen.
  const b = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const x = Math.min(Math.max(Math.round(b.x + b.width / 2 - POPUP.width / 2), area.x + 8), area.x + area.width - POPUP.width - 8);
  popup.setPosition(x, Math.round(area.y + 6));
  popup.webContents.send("state", getState()); // reset the form for a fresh start
  popup.show();
  app.focus({ steal: true });
}

function showHistory() {
  if (!history) {
    history = new BrowserWindow({
      width: 980,
      height: 660,
      minWidth: 640,
      minHeight: 420,
      show: false,
      title: "Gloss — History",
      titleBarStyle: "hiddenInset",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    history.on("closed", () => (history = null));
    history.once("ready-to-show", () => history?.show());
    load(history, "history");
  } else {
    history.webContents.send("state", getState()); // refresh the list
    history.show();
  }
  app.focus({ steal: true });
}

function openLearn() {
  if (!learnWin) {
    learnWin = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 600,
      minHeight: 420,
      show: false,
      title: "Gloss — How You Learn",
      titleBarStyle: "hiddenInset",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1a17" : "#f7f3ec",
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    learnWin.on("closed", () => (learnWin = null));
    learnWin.once("ready-to-show", () => learnWin?.show());
    load(learnWin, "learn");
  } else {
    learnWin.webContents.reload();
    learnWin.show();
  }
  app.focus({ steal: true });
}

function openSettings() {
  if (!settingsWin) {
    settingsWin = new BrowserWindow({
      width: 760,
      height: 780,
      minWidth: 560,
      minHeight: 480,
      show: false,
      title: "Gloss — Settings",
      titleBarStyle: "hiddenInset",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1a17" : "#f7f3ec",
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    settingsWin.on("closed", () => (settingsWin = null));
    settingsWin.once("ready-to-show", () => settingsWin?.show());
    load(settingsWin, "settings");
  } else settingsWin.show();
  app.focus({ steal: true });
}

/** Everything the Settings window edits (three files in the project folder). */
function readAllSettings(): SettingsBundle {
  const nr = JSON.parse(readFileSync(fromRoot("never-record.json"), "utf8")) as { apps?: string[]; titles?: string[] };
  return { settings: loadSettings(fromRoot("settings.json")), courses: loadCourses(), neverRecord: { apps: nr.apps ?? [], titles: nr.titles ?? [] } };
}

function saveAllSettings(b: SettingsBundle): { ok: boolean; message?: string } {
  // Courses: unique ids made from the name; at least one.
  const courses = b.courses
    .map((c) => ({ id: (c.id || c.name).toLowerCase().replace(/[^a-z0-9]/g, ""), name: c.name.trim().slice(0, 40), ...(c.math ? { math: true } : {}) }))
    .filter((c) => c.id && c.name);
  if (!courses.length) return { ok: false, message: "Add at least one course." };
  if (new Set(courses.map((c) => c.id)).size !== courses.length) return { ok: false, message: "Two courses have the same name." };
  // Never-record title rules are regular expressions: reject ones that don't compile.
  for (const t of b.neverRecord.titles) {
    try {
      new RegExp(t, "i");
    } catch {
      return { ok: false, message: `This never-record rule isn't valid: ${t}` };
    }
  }
  const nrPath = fromRoot("never-record.json");
  const comment = (JSON.parse(readFileSync(nrPath, "utf8")) as { _comment?: string })._comment;
  writeFileSync(fromRoot("settings.json"), JSON.stringify(sanitizeSettings(b.settings), null, 2) + "\n");
  writeFileSync(fromRoot("courses.json"), JSON.stringify(courses, null, 2) + "\n");
  writeFileSync(
    nrPath,
    JSON.stringify({ _comment: comment, apps: b.neverRecord.apps.map((a) => a.trim()).filter(Boolean), titles: b.neverRecord.titles.map((t) => t.trim()).filter(Boolean) }, null, 2) + "\n",
  );
  broadcast();
  return { ok: true, message: current ? "Saved. Changes apply from your next session." : "Saved." };
}

type SettingsBundle = { settings: Settings; courses: Course[]; neverRecord: { apps: string[]; titles: string[] } };

function openWarmup(sessionId: string) {
  warmupWin?.close();
  const area = screen.getPrimaryDisplay().workArea;
  warmupWin = new BrowserWindow({
    width: 520,
    height: 640,
    x: area.x + area.width - 540,
    y: area.y + 20,
    show: false,
    title: "Gloss — Warm-up",
    titleBarStyle: "hiddenInset",
    alwaysOnTop: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1a17" : "#f7f3ec",
    webPreferences: { preload, sandbox: true, contextIsolation: true },
  });
  warmupWin.on("closed", () => (warmupWin = null));
  warmupWin.once("ready-to-show", () => warmupWin?.show());
  load(warmupWin, `warmup/${sessionId}`);
}

function openReview(sessionId: string) {
  if (!reviewWin) {
    reviewWin = new BrowserWindow({
      width: 760,
      height: 820,
      minWidth: 520,
      minHeight: 480,
      show: false,
      title: "Gloss — Review",
      titleBarStyle: "hiddenInset",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    reviewWin.on("closed", () => (reviewWin = null));
    reviewWin.once("ready-to-show", () => reviewWin?.show());
  } else {
    reviewWin.show();
  }
  load(reviewWin, `review/${sessionId}`);
  app.focus({ steal: true });
}

// ---------- IPC (requests from the windows) ----------

function registerIpc() {
  ipcMain.handle("courses:list", () => loadCourses());
  ipcMain.handle("state:get", () => getState());
  ipcMain.handle("session:start", (_e, courseId: unknown, goal: unknown) =>
    startSession(String(courseId), typeof goal === "string" ? goal : ""),
  );
  ipcMain.handle("sessions:list", () => db.listSessions());
  ipcMain.handle("sessions:get", (_e, id: unknown) => db.getSession(String(id)));
  ipcMain.handle("settings:screen-recording", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
  );
  ipcMain.handle("review:get", (_e, id: unknown) => reviews.get(String(id)));
  ipcMain.handle("review:retry", (_e, id: unknown) => reviews.retry(String(id)));
  ipcMain.handle("review:open", (_e, id: unknown) => {
    reviews.ensure(String(id));
    openReview(String(id));
  });
  ipcMain.handle("settings:get", async () => {
    // Downloaded models that can tutor (not the math reader or the embedding model).
    let installed: string[] = [];
    try {
      const tags = (await (await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) })).json()) as { models?: { name: string }[] };
      installed = (tags.models ?? []).map((m) => m.name).filter((n) => !/glm-ocr|embed/i.test(n)).sort();
    } catch {
      /* Ollama not running */
    }
    return { ...readAllSettings(), models: { math: "glm-ocr:q8_0", memory: "embeddinggemma" }, installed, aiProblem };
  });
  ipcMain.handle("settings:save", (_e, b: unknown) => saveAllSettings(b as SettingsBundle));
  ipcMain.handle("settings:open", () => openSettings());
  ipcMain.handle("learn:profile", () => learner.profile());
  ipcMain.handle("learn:mark", (_e, id: unknown, known: unknown) => db.setManual(String(id), typeof known === "boolean" ? known : null));
  ipcMain.handle("learn:delete", (_e, id: unknown) => db.deleteConcept(String(id)));
  ipcMain.handle("learn:delete-course", (_e, courseId: unknown) => db.deleteLearnerModel(typeof courseId === "string" ? courseId : undefined));
  ipcMain.handle("learn:open", () => openLearn());
  ipcMain.handle("warmup:get", (_e, sessionId: unknown) => {
    const s = db.getSession(String(sessionId));
    return s ? learner.warmup(s.id, s.courseId) : null;
  });
  ipcMain.handle("ask:info", (_e, id: unknown) => asker.info(String(id)));
  ipcMain.handle("ask:send", (_e, id: unknown, question: unknown, level: unknown) => {
    const lvl = level === "explain" || level === "example" || level === "nudge" ? level : "auto";
    void asker.ask(String(id), typeof question === "string" ? question : "", lvl);
  });
  ipcMain.handle("overlay:click", () => asker.overlayClicked());
  ipcMain.handle("chunks:delete", (_e, id: unknown) => db.deleteChunk(String(id)));
  // Deleting is refused for the session that's recording right now.
  ipcMain.handle("sessions:delete", (_e, id: unknown) => {
    if (current?.sessionId === String(id)) return;
    db.deleteSession(String(id));
    broadcast();
  });
  ipcMain.handle("courses:delete-data", (_e, courseId: unknown) => {
    if (current?.course.id === String(courseId)) return;
    db.deleteCourseData(String(courseId));
    broadcast();
  });
  ipcMain.handle("review:redo", (_e, id: unknown) => {
    db.clearReview(String(id));
    reviews.forget(String(id));
    reviews.ensure(String(id));
    openReview(String(id));
  });
  ipcMain.handle("quiz:answer", (_e, itemId: unknown, response: unknown) =>
    reviews.answer(String(itemId), typeof response === "string" ? response.slice(0, 2000) : ""),
  );
  ipcMain.handle("window:close", (e) => {
    if (asker.isOverlay(BrowserWindow.fromWebContents(e.sender))) return asker.cancel(); // Esc while circling
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win === popup) win?.hide();
    else win?.close();
  });
}

// ---------- app lifecycle ----------

/**
 * The database in the app's data folder. The app used to be called Study Buddy: the first time Gloss
 * starts, it copies the old database over. The old folder is left untouched.
 */
function userDbPath(): string {
  const path = join(app.getPath("userData"), "gloss.db");
  const old = join(app.getPath("appData"), "Study Buddy", "study-buddy.db");
  if (!existsSync(path) && existsSync(old)) {
    mkdirSync(dirname(path), { recursive: true });
    const src = new DatabaseSync(old, { readOnly: true });
    src.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`); // a consistent copy, even mid-write
    src.close();
  }
  return path;
}

// One copy at a time, except development checks, which use a throwaway database and data folder.
if (process.env.GLOSS_DB) app.setPath("userData", join(dirname(process.env.GLOSS_DB), "userdata"));
else if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  app.dock?.hide(); // menu bar only, no Dock icon
  // GLOSS_DB lets development checks use a throwaway database.
  db = new StudyDb(process.env.GLOSS_DB ?? userDbPath());
  learner = new LearnerService(db, loadCourses);
  reviews = new ReviewService(
    db,
    loadCourses,
    learner,
    (sessionId) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("review", sessionId);
    },
    () => loadSettings(fromRoot("settings.json")).ai.reviewModel,
  );
  asker = new AskController(loadSettings(fromRoot("settings.json")), {
    db,
    preload,
    load,
    voicePaths: { visionHelper: fromRoot("bin", "vision-helper"), voice: fromRoot("bin", "Gloss Voice") },
    learner,
  });
  // Older notes get embeddings too, once the embedding model is there (quietly, in the background).
  setTimeout(() => void learner.backfillEmbeddings().catch(() => {}), 30_000);
  registerIpc();
  tray = new Tray(icons.idle());
  updateTray();

  // Check the local AI every 30 s so the menu can say clearly when it isn't available.
  const checkAiNow = async () => {
    const r = await checkAi();
    const msg = r.ok ? "" : r.error.code === "not-running" ? "Ollama isn't running — summaries and asking are off" : r.error.message;
    if (msg !== aiProblem) {
      aiProblem = msg;
      updateTray();
    }
  };
  void checkAiNow();
  setInterval(() => void checkAiNow(), 30_000);

  // Tick once a second: menu bar clock; every 5 s save study time and flush waiting text.
  let ticks = 0;
  setInterval(() => {
    if (!current) return;
    updateTray();
    if (++ticks % 5 === 0) {
      db.updateActiveTime(current.sessionId, current.loop.activeMs);
      current.chunker.flushIfStale();
    }
  }, 1000);

  // Pause automatically while the screen is locked or the Mac is asleep, and resume afterwards.
  const autoPause = () => {
    if (current?.loop.status !== "running") return;
    current.loop.pause();
    current.autoPaused = true;
    broadcast();
  };
  const autoResume = () => {
    if (current?.autoPaused) resumeSession();
  };
  powerMonitor.on("lock-screen", autoPause);
  powerMonitor.on("suspend", autoPause);
  powerMonitor.on("unlock-screen", autoResume);
  powerMonitor.on("resume", autoResume);

  if (process.env.GLOSS_SMOKE) void smokeTest(process.env.GLOSS_SMOKE);
  if (process.env.GLOSS_SMOKE_SETTINGS) void (async () => {
    openSettings();
    await new Promise((r) => setTimeout(r, 2500));
    const { writeFileSync: w } = await import("node:fs");
    w(join(process.env.GLOSS_SMOKE_SETTINGS!, "settings.png"), (await settingsWin!.webContents.capturePage()).toPNG());
    app.quit();
  })();
  if (process.env.GLOSS_SMOKE_SESSION) void smokeSession(Number(process.env.GLOSS_SMOKE_SESSION));
  if (process.env.GLOSS_SMOKE_REVIEW) void smokeReview(process.env.GLOSS_SMOKE_REVIEW);
  if (process.env.GLOSS_SMOKE_ASK) void smokeAsk(process.env.GLOSS_SMOKE_ASK);
  if (process.env.GLOSS_SMOKE_LEARN) void smokeLearn(process.env.GLOSS_SMOKE_LEARN);
  // Development checks: show errors from every window in the terminal.
  if (process.env.GLOSS_DB) {
    app.on("web-contents-created", (_e, wc) =>
      wc.on("console-message", (ev) => ev.level === "error" && console.log("SMOKE window error:", ev.message.slice(0, 120), "in", wc.getURL().split("#").pop())),
    );
  }
});

app.on("window-all-closed", () => {
  /* keep running in the menu bar */
});

let quitting = false;
app.on("before-quit", (e) => {
  if ((current || finishing.size) && !quitting) {
    e.preventDefault();
    quitting = true;
    // Save the session (and any still finishing) before quitting.
    void endSession()
      .then(() => Promise.all([...finishing]))
      .then(() => app.quit());
  }
});

/** Development check: opens both windows, saves screenshots of them to `dir`, then quits. */
async function smokeTest(dir: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  showStartPopup();
  showHistory();
  await wait(3000);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "popup.png"), (await popup!.webContents.capturePage()).toPNG());
  writeFileSync(join(dir, "history.png"), (await history!.webContents.capturePage()).toPNG());
  // The popup's frosted background doesn't show up in screenshots, so also report what it contains.
  const text = await popup!.webContents.executeJavaScript("document.body.innerText");
  console.log("SMOKE popup text:", JSON.stringify(text));
  console.log("SMOKE state", JSON.stringify(getState()), "sessions", db.listSessions().length);
  const h = new VisionHelper({ helperPath: fromRoot("bin", "vision-helper") });
  console.log("SMOKE screen recording permission:", await h.hasPermission());
  h.close();
  app.quit();
}

/** Development check: records a short real session with a pause in the middle, prints what was saved, quits. */
async function smokeSession(seconds: number) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const res = await startSession("math135", "smoke test");
  console.log("SMOKE start", JSON.stringify(res), "title", JSON.stringify(tray.getTitle()));
  if (!res.ok) return app.quit();
  const id = current!.sessionId;
  await wait((seconds / 2) * 1000);
  pauseSession();
  const pausedAt = current!.loop.activeMs;
  const ticksAtPause = current!.loop.stats.ticks;
  console.log("SMOKE paused", JSON.stringify(getState().status), "title", JSON.stringify(tray.getTitle()));
  await wait(4000);
  console.log("SMOKE while paused: active ms grew by", current!.loop.activeMs - pausedAt, "ticks grew by", current!.loop.stats.ticks - ticksAtPause);
  resumeSession();
  await wait((seconds / 2) * 1000);
  await endSession();
  const s = db.getSession(id)!;
  console.log("SMOKE ended", JSON.stringify({ status: getState().status, endedAt: !!s.endedAt, activeMs: s.activeMs, chunks: s.chunkCount }));
  for (const c of s.chunks) console.log("SMOKE chunk", c.sourceApp, "|", c.sourceTitle, "|", c.text.length, "chars");
  app.quit();
}

/** Development check: makes the summary and quiz for the newest session, answers two questions, saves a screenshot. */
async function smokeReview(dir: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const id = db.listSessions()[0].id;
  const t0 = Date.now();
  reviews.ensure(id);
  openReview(id);
  reviewWin!.webContents.on("console-message", (e) => console.log("SMOKE console", e.level, e.message.slice(0, 200)));
  let r = reviews.get(id)!;
  while (r.quiz.status !== "done" && r.quiz.status !== "error" && Date.now() - t0 < 600_000) {
    await wait(2000);
    r = reviews.get(id)!;
  }
  console.log("SMOKE review ready in", Math.round((Date.now() - t0) / 1000), "s");
  console.log("SMOKE summary", JSON.stringify(r.summary).slice(0, 1500));
  console.log("SMOKE quiz", r.quiz.status, r.quiz.error ?? "", r.quiz.note ?? "", r.quiz.items.length, "questions");
  for (const q of r.quiz.items) console.log("SMOKE   -", q.type, "|", q.question, q.options ? `| ${q.options.join(" / ")}` : "");
  const mc = r.quiz.items.find((q) => q.type === "multiple_choice");
  if (mc) console.log("SMOKE answer MC:", JSON.stringify(await reviews.answer(mc.id, mc.options![0])));
  const sa = r.quiz.items.find((q) => q.type === "short_answer");
  if (sa) {
    const t = Date.now();
    console.log("SMOKE answer SA (deliberately vague):", JSON.stringify(await reviews.answer(sa.id, "I'm not sure")), Math.round((Date.now() - t) / 1000), "s");
  }
  if (!reviewWin) openReview(id); // in case the window was closed meanwhile
  await wait(3000);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "review-top.png"), (await reviewWin!.webContents.capturePage()).toPNG());
  await reviewWin!.webContents.executeJavaScript("document.querySelector('.overflow-y-auto').scrollTop = 1e6");
  await wait(500);
  writeFileSync(join(dir, "review.png"), (await reviewWin!.webContents.capturePage()).toPNG());
  console.log("SMOKE score", JSON.stringify(db.getSession(id)!.quizScore));
  app.quit();
}

/** Development check: circle-and-ask with a pretend circle and a real model answer; saves screenshots. */
async function smokeAsk(dir: string) {
  const { writeFileSync } = await import("node:fs");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const course = process.env.GLOSS_SMOKE_COURSE ?? "cs135";
  const res = await startSession(course, "ask smoke test");
  if (!res.ok) {
    console.log("SMOKE start failed", res.message);
    return app.quit();
  }
  const c = screen.getCursorScreenPoint();
  const path = Array.from({ length: 40 }, (_, i) => {
    const t = (i / 39) * Math.PI * 2;
    return { x: Math.round(c.x + 220 * Math.cos(t)), y: Math.round(c.y + 130 * Math.sin(t)) };
  });
  if (learner.warmup(current!.sessionId, course)) {
    openWarmup(current!.sessionId);
    await wait(2500);
    writeFileSync(join(dir, "warmup.png"), (await warmupWin!.webContents.capturePage()).toPNG());
    warmupWin?.close();
  }
  const askId = await asker.smoke(path, dir, process.env.GLOSS_SMOKE_QUESTION);
  console.log("SMOKE ask window", askId ? "opened" : "NOT opened", JSON.stringify(askId ? { ...asker.info(askId), thumbnail: asker.info(askId)!.thumbnail.length + " chars" } : null));
  if (!askId) return app.quit();
  await wait(400); // right after the popup opens: the spoken question should already show
  writeFileSync(join(dir, "ask-early.png"), (await asker.windowFor(askId)!.webContents.capturePage()).toPNG());
  writeFileSync(join(dir, "sent.jpg"), Buffer.from(asker.info(askId)!.thumbnail.split(",")[1], "base64"));
  // The spoken question is asked automatically; wait for that answer.
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    await wait(500);
    const qs = db.getQuestions(current!.sessionId);
    if (qs[0]?.answers.length) break;
  }
  console.log("SMOKE spoken question answered in", Math.round((Date.now() - t0) / 1000), "s");
  const ps = (await (await fetch("http://localhost:11434/api/ps")).json()) as { models: { name: string }[] };
  console.log("SMOKE models loaded:", ps.models.map((m) => m.name).join(", "));
  await wait(800);
  writeFileSync(join(dir, "ask.png"), (await asker.windowFor(askId)!.webContents.capturePage()).toPNG());
  console.log("SMOKE ask text:", JSON.stringify((await asker.windowFor(askId)!.webContents.executeJavaScript("document.body.innerText")).slice(0, 600)));
  const id = current!.sessionId;
  await endSession();
  console.log("SMOKE saved questions:", JSON.stringify(db.getQuestions(id).map((q) => ({ q: q.question, answers: q.answers.length }))));
  app.quit();
}

/** Development check: the adaptive loop on real sessions — concepts, quiz targeting, evidence, warm-up. */
async function smokeLearn(dir: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { writeFileSync } = await import("node:fs");
  const sessions = db.listSessions().reverse(); // oldest first
  for (const [n, s] of sessions.entries()) {
    const t0 = Date.now();
    reviews.ensure(s.id);
    let r = reviews.get(s.id)!;
    while (r.quiz.status !== "done" && r.quiz.status !== "error" && Date.now() - t0 < 600_000) {
      await wait(2000);
      r = reviews.get(s.id)!;
    }
    const points = r.summary.data?.ok ? r.summary.data.points : [];
    console.log(`SMOKE session ${n + 1}: ready in ${Math.round((Date.now() - t0) / 1000)} s; concepts named: ${points.map((p) => p.concept).join(" | ")}`);
    console.log(`SMOKE   quiz: ${r.quiz.items.length} questions, ${r.quiz.error ?? r.quiz.note ?? ""}`);
    // Answer: multiple choice wrong on the first, right on the rest; short answers deliberately vague.
    for (const [i, q] of r.quiz.items.entries()) {
      if (q.type !== "multiple_choice") continue;
      const right = (await reviews.answer(q.id, q.options![0])).correct ? q.options![0] : null;
      if (i === 0 && right) continue;
      if (!right && i > 0) {
        // find the right option by asking the answer from the result of a wrong pick: already recorded; skip
      }
    }
    for (const q of r.quiz.items.filter((q) => q.type === "short_answer").slice(0, 1)) await reviews.answer(q.id, "not sure");
  }
  const profile = await learner.profile();
  for (const c of profile.courses) {
    console.log(`SMOKE profile ${c.courseName}: ${c.concepts.length} concepts`);
    for (const k of c.concepts) console.log(`SMOKE   ${Math.round(k.current * 100)}% (conf ${Math.round(k.confidence * 100)}%) ${k.name} — ${k.why.join(" ")}`);
  }
  const last = sessions.at(-1)!;
  console.log("SMOKE warm-up due now:", learner.warmup(last.id, "math135")?.items.length ?? 0, "(wrong answers come back next session)");
  console.log("SMOKE connections for latest session:", JSON.stringify(learner.connections(last.id, "math135")));
  const weakest = profile.courses[0]?.concepts[0];
  if (weakest) {
    console.log("SMOKE start level, asking about weakest concept:", JSON.stringify(learner.startLevel(last.id, weakest.id)));
    const match = await learner.conceptForQuestion("math135", `I don't understand ${weakest.name}`);
    console.log("SMOKE question matched to concept:", match?.name ?? "none");
  }
  openLearn();
  await wait(2500);
  writeFileSync(join(dir, "learn.png"), (await learnWin!.webContents.capturePage()).toPNG());
  app.quit();
}

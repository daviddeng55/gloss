// Main process: the menu bar icon, the capture session, the database, and the windows.
// (Electron's "main process" is the hidden Node program; windows are separate "renderer" processes.)
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell, Tray } from "electron";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CaptureLoop, DEFAULT_SETTINGS } from "../core/capture.ts";
import { Chunker } from "../core/chunker.ts";
import { StudyDb } from "../core/db.ts";
import { VisionHelper } from "../core/helper.ts";
import { loadNeverRecord } from "../core/privacy.ts";
import type { AppState, Course, StartResult } from "../shared/types.ts";

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
let current: Current | null = null;
let lastMenuKey = "";

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
  const key = state.status === "idle" ? "idle" : `${state.status}|${state.sessionId}`;
  if (key === lastMenuKey) return;
  lastMenuKey = key;
  tray.setImage(icons[state.status]());
  tray.setToolTip(state.status === "idle" ? "Study Buddy" : `Study Buddy: ${state.status} ${state.courseName}`);

  const common: Electron.MenuItemConstructorOptions[] = [
    { type: "separator" },
    { label: "History…", click: showHistory },
    { type: "separator" },
    { label: "Quit Study Buddy", accelerator: "Command+Q", click: () => app.quit() },
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
        message: "Study Buddy needs Screen Recording permission to read your screen during sessions.",
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
  session.loop = new CaptureLoop({
    helper,
    neverRecord: loadNeverRecord(fromRoot("never-record.json")),
    projectName: basename(ROOT),
    ownPids: [process.pid], // never capture Study Buddy's own windows
    settings: DEFAULT_SETTINGS,
    onEntry: (entry) => session.chunker!.add(entry),
    onLog: (line) => console.log(`[capture] ${line}`),
  });
  session.done = session.loop.run();
  current = session as Current;
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

async function endSession() {
  if (!current) return;
  const c = current;
  c.loop.stop();
  await c.done; // let the capture in progress finish
  c.chunker.flush();
  c.helper.close();
  db.endSession(c.sessionId, { endedAt: new Date().toISOString(), activeMs: c.loop.activeMs, stats: c.loop.stats });
  current = null;
  broadcast();
  new Notification({
    title: `${c.course.name} session saved`,
    body: `${clock(c.loop.activeMs)} studied · ${c.chunks} passage${c.chunks === 1 ? "" : "s"} of notes saved`,
  }).show();
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
      title: "Study Buddy — History",
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
  ipcMain.handle("window:close", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win === popup) win?.hide();
    else win?.close();
  });
}

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  app.dock?.hide(); // menu bar only, no Dock icon
  // STUDY_BUDDY_DB lets development checks use a throwaway database.
  db = new StudyDb(process.env.STUDY_BUDDY_DB ?? join(app.getPath("userData"), "study-buddy.db"));
  registerIpc();
  tray = new Tray(icons.idle());
  updateTray();

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

  if (process.env.STUDY_BUDDY_SMOKE) void smokeTest(process.env.STUDY_BUDDY_SMOKE);
  if (process.env.STUDY_BUDDY_SMOKE_SESSION) void smokeSession(Number(process.env.STUDY_BUDDY_SMOKE_SESSION));
});

app.on("window-all-closed", () => {
  /* keep running in the menu bar */
});

let quitting = false;
app.on("before-quit", (e) => {
  if (current && !quitting) {
    e.preventDefault();
    quitting = true;
    void endSession().then(() => app.quit()); // save the session before quitting
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

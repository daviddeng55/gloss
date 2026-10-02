// Types shared by the main process, the preload bridge and the windows.

export type Course = { id: string; name: string };

export type SessionRow = {
  id: string;
  courseId: string;
  goal?: string;
  startedAt: string;
  endedAt?: string;
  activeMs: number; // study time, not counting pauses
  chunkCount: number;
  charCount: number;
  summary?: string;
  quizScore?: { correct: number; total: number };
};

export type ChunkRow = {
  id: string;
  sessionId: string;
  courseId: string;
  text: string;
  sourceApp: string;
  sourceTitle: string;
  capturedAt: string;
};

export type SessionDetail = SessionRow & { chunks: ChunkRow[] };

export type AppState =
  | { status: "idle" }
  | {
      status: "recording" | "paused";
      sessionId: string;
      courseId: string;
      courseName: string;
      goal?: string;
      startedAt: string;
      activeMs: number;
    };

export type StartResult =
  | { ok: true }
  | { ok: false; reason: "permission" | "busy" | "error"; message: string };

/** What the windows can ask the main process to do (exposed as `window.api` by the preload script). */
export interface StudyApi {
  getCourses(): Promise<Course[]>;
  getState(): Promise<AppState>;
  startSession(courseId: string, goal: string): Promise<StartResult>;
  listSessions(): Promise<SessionRow[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  openScreenRecordingSettings(): Promise<void>;
  closeWindow(): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
}

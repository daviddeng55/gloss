// Types shared by the main process, the preload bridge and the windows.

export type Course = { id: string; name: string; math?: boolean };

/** What the Settings window edits. */
export type SettingsView = {
  settings: {
    ai: { reviewModel: string; askModel: string };
    capture: { intervalSeconds: number; dwellSeconds: number };
    learn: { offerHelpWhenStuck: boolean };
    ask: { shortcut: string; voice: boolean; locale: string; fallbackW: number; fallbackH: number; padding: number; minCircle: number };
  };
  courses: Course[];
  neverRecord: { apps: string[]; titles: string[] };
  models?: { math: string; memory: string };
  installed?: string[];
  aiProblem?: string;
};

export type SessionRow = {
  id: string;
  courseId: string;
  goal?: string;
  startedAt: string;
  endedAt?: string;
  activeMs: number; // study time, not counting pauses
  chunkCount: number;
  charCount: number;
  summary?: SummaryData;
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

/** A question asked about the screen during a session, with its answers (one per hint level asked). */
export type QuestionRow = {
  id: string;
  askedAt: string;
  question: string;
  sourceTitle: string;
  answers: { level: string; text: string; at: string }[];
};

export type SessionDetail = SessionRow & { chunks: ChunkRow[]; questions: QuestionRow[] };

/** What a session covered (or why it couldn't be summarized). */
export type SummaryData =
  | { ok: true; points: { text: string; passageIds: string[]; concept?: string }[] }
  | { ok: false; reason: string };

export type QuizItemView = {
  id: string;
  chunkId?: string;
  type: "multiple_choice" | "short_answer";
  question: string;
  options?: string[];
  answered?: { response: string; correct: boolean; answer: string; explanation: string };
};

export type TaskStatus = "waiting" | "working" | "done" | "error";

/** Everything the review window shows for one session. */
export type ReviewData = {
  sessionId: string;
  finishing: boolean; // the session's text is still being saved (math re-reads finishing)
  courseName: string;
  goal?: string;
  startedAt: string;
  activeMs: number;
  summary: { status: TaskStatus; data?: SummaryData; error?: string };
  quiz: { status: TaskStatus; items: QuizItemView[]; note?: string; error?: string };
  passages: Record<string, { text: string; sourceTitle: string; capturedAt: string }>;
  connections: Connection[];
};

export type AnswerResult = { correct: boolean; answer: string; explanation: string };

// ---------- Stage 5: the learner model ----------

export type HelpCounts = { nudge: number; explain: number; example: number };

export type LearnConcept = {
  id: string;
  courseId: string;
  name: string;
  current: number; // mastery now, 0–1 (after fading)
  confidence: number; // 0–1
  lastPracticedAt?: string;
  helps: HelpCounts;
  quizzes: { right: number; wrong: number };
  asks: number;
  why: string[];
  override: boolean | null; // you marked it known (true) / not known (false)
  sources: { sessionId: string; startedAt: string; sourceTitle: string }[];
};

export type LearnProfile = {
  courses: { courseId: string; courseName: string; concepts: LearnConcept[] }[];
  overall: HelpCounts;
  memoryByMeaning: boolean; // embedding model available
};

/** An earlier concept today's material builds on, that you've found hard. */
export type Connection = { conceptId: string; name: string; current: number; lastStudied: string };

export type WarmupData = {
  sessionId: string;
  courseName: string;
  items: QuizItemView[];
  passages: Record<string, { text: string; sourceTitle: string; capturedAt: string }>;
};

/** Stage 4: one "circle and ask" conversation about a screenshot crop. */
export type AskInfo = {
  askId: string;
  courseName: string;
  thumbnail: string; // data: URL of exactly what is sent
  circled: boolean; // false = area around the cursor
  sourceTitle: string;
};

/** Messages to the circling overlay: points are relative to the overlay window. */
export type OverlayEvent =
  | { type: "start"; shortcutLabel: string }
  | { type: "path"; points: { x: number; y: number }[] }
  | { type: "end" }
  | { type: "voice"; state: "listening" | "off" | "unavailable"; message?: string }
  | { type: "speech"; text: string }
  | { type: "level"; value: number };

export type HintLevelId = "nudge" | "explain" | "example";

export type AskEvent =
  | { askId: string; type: "start"; turn: number; level: HintLevelId; question: string; reason?: string; concept?: string }
  | { askId: string; type: "sources"; turn: number; sources: { title: string; when: string }[] }
  | { askId: string; type: "text"; turn: number; text: string }
  | { askId: string; type: "done"; turn: number }
  | { askId: string; type: "error"; turn: number; message: string };

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
  getReview(sessionId: string): Promise<ReviewData | null>;
  retryReview(sessionId: string): Promise<void>;
  answerQuestion(itemId: string, response: string): Promise<AnswerResult>;
  openReview(sessionId: string): Promise<void>;
  redoReview(sessionId: string): Promise<void>;
  deletePassage(chunkId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getSettings(): Promise<SettingsView>;
  saveSettings(s: SettingsView): Promise<{ ok: boolean; message?: string }>;
  openSettings(): Promise<void>;
  deleteCourseData(courseId: string): Promise<void>;
  onReview(callback: (sessionId: string) => void): () => void;
  closeWindow(): Promise<void>;
  askInfo(askId: string): Promise<AskInfo | null>;
  ask(askId: string, question: string, level: HintLevelId | "auto"): Promise<void>;
  getLearnProfile(): Promise<LearnProfile>;
  markConcept(conceptId: string, known: boolean | null): Promise<void>;
  deleteConcept(conceptId: string): Promise<void>;
  deleteLearnerModel(courseId: string | null): Promise<void>;
  openLearn(): Promise<void>;
  getWarmup(sessionId: string): Promise<WarmupData | null>;
  onAsk(callback: (e: AskEvent) => void): () => void;
  onOverlay(callback: (e: OverlayEvent) => void): () => void;
  overlayClick(): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
}

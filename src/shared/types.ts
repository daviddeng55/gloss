// Types shared by the main process, the preload bridge and the windows.

export type Course = { id: string; name: string; math?: boolean };

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
  | { ok: true; points: { text: string; passageIds: string[] }[] }
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
};

export type AnswerResult = { correct: boolean; answer: string; explanation: string };

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
  onReview(callback: (sessionId: string) => void): () => void;
  closeWindow(): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
}

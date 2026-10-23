// Types shared by the main process, the preload bridge and the windows.

export type Course = { id: string; name: string; math?: boolean };

/** Fast mode (Gemini in the cloud). The API key itself is in the Keychain, never here. */
export type CloudSettings = {
  enabled: boolean;
  model: string; // e.g. "gemini-3.5-flash-lite"
  studyApps: string[]; // only content read from these apps may be sent
};

/** What Settings shows about fast mode (never the key itself). */
export type CloudView = {
  hasKey: boolean;
  active: boolean; // key saved and fast mode on
  problem: string; // what last went wrong with a cloud call ("" if nothing)
  pausedForSeconds: number; // after a rate limit or error, the cloud is left alone this long
};

/** What the Settings window edits. */
export type SettingsView = {
  settings: {
    ai: { reviewModel: string; askModel: string };
    cloud: CloudSettings;
    capture: { intervalSeconds: number; dwellSeconds: number };
    learn: { offerHelpWhenStuck: boolean };
    buddy: BuddySettings;
    ask: { shortcut: string; voice: boolean; locale: string; fallbackW: number; fallbackH: number; padding: number; minCircle: number };
  };
  courses: Course[];
  neverRecord: { apps: string[]; titles: string[] };
  models?: { math: string; memory: string };
  installed?: string[];
  aiProblem?: string;
  cloud?: CloudView;
};

// ---------- Study Buddy ----------

export type BuddyCharacterId = "dog" | "cat" | "penguin" | "birdie";
export type BuddySettings = {
  enabled: boolean;
  character: BuddyCharacterId | ""; // "" = not chosen yet (the picker opens)
  name: string;
  minMinutes: number; // at most one appearance per this many minutes
};
export type BuddyMoodId = "idle" | "asking" | "thinking" | "happy" | "confused" | "thanks";

/** One chat with the buddy, as the review window shows it (no grades). */
export type BuddyChatView = {
  id: string;
  topic: string;
  character: string;
  buddyName: string;
  startedAt: string;
  turns: { who: "buddy" | "you"; text: string; at: string; cloud?: boolean }[];
  outcome: "understood" | "gap" | "skipped" | null;
};

/** What the buddy window shows. */
export type BuddyView = {
  character: BuddyCharacterId;
  name: string;
  mood: BuddyMoodId;
  line: string; // the speech bubble
  canAnswer: boolean; // waiting for your answer
  cloud?: boolean; // this line was written by the cloud model (fast mode)
  voice: "off" | "ready" | "listening" | "unavailable";
  partial?: string; // words heard so far
  level?: number; // microphone level 0–1
  done: boolean; // about to leave
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
  answers: { level: string; text: string; at: string; cloud?: boolean }[];
};

/**
 * A "Find it" result: a raw capture or a section of your notes that matches the search. Matching words
 * are marked (shared/search.ts). For notes, sourceTitle is the section title.
 */
export type FoundMoment = {
  kind: "capture" | "note";
  chunkId: string;
  sessionId: string;
  courseId: string;
  courseName: string;
  sourceApp: string;
  sourceTitle: string;
  capturedAt: string;
  snippet: string;
  topicId?: string;
  topicTitle?: string;
  sectionId?: string;
};

export type NoteKind = "definition" | "theorem" | "formula" | "example" | "mistake" | "point";

/** The Notes sidebar: courses with their topics, and whether notes are still being written. */
export type NoteTree = {
  courses: { courseId: string; courseName: string; topics: { id: string; title: string; sections: number; updatedAt: string }[] }[];
  pending: number; // sessions whose notes aren't written yet
  writing: boolean; // notes are being written right now
};

/** A key term in a topic's notes that's explained elsewhere: `text` as written, and where it leads. */
export type NoteXref = { text: string; topicId: string; sectionId?: string; label: string };

/** A course's notes page: units (general headings) with their topics. `id: null` = topics not in a unit. */
export type CourseNotes = {
  courseId: string;
  courseName: string;
  units: {
    id: string | null;
    title: string;
    topics: { id: string; title: string; summary: string; sections: number; updatedAt: string }[];
  }[];
  sorting: boolean; // the AI is sorting topics into units right now
  canSort: boolean; // some topics aren't in a unit and the AI may sort them
};

export type NoteTopic = {
  id: string;
  courseId: string;
  courseName: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  unit?: { id: string; title: string };
  /** Cross-references, by section id ("summary" for the summary). */
  xrefs?: Record<string, NoteXref[]>;
  /** Other topics whose notes link to this one, and the terms they link with. */
  related?: { topicId: string; title: string; courseName: string; terms: string[] }[];
  sections: {
    id: string;
    kind: NoteKind;
    title: string;
    body: string;
    chunkId?: string; // the raw capture it came from (gone if that passage was deleted)
    sessionId: string;
    capturedAt?: string;
    sourceTitle?: string;
    cloud?: boolean; // written by the cloud model (fast mode)
  }[];
};

export type SessionDetail = SessionRow & { chunks: ChunkRow[]; questions: QuestionRow[] };

/** What a session covered (or why it couldn't be summarized). */
export type SummaryData =
  | { ok: true; points: { text: string; passageIds: string[]; concept?: string }[]; cloud?: boolean }
  | { ok: false; reason: string; cloud?: boolean };

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
  /** `partial`: the points written so far, while the summary is still being written. */
  summary: { status: TaskStatus; data?: SummaryData; error?: string; partial?: string[] };
  quiz: { status: TaskStatus; items: QuizItemView[]; note?: string; error?: string; cloud?: boolean; step?: "writing" | "checking" };
  passages: Record<string, { text: string; sourceTitle: string; capturedAt: string }>;
  connections: Connection[];
  buddy: BuddyChatView[];
};

export type AnswerResult = { correct: boolean; answer: string; explanation: string; cloud?: boolean };

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
  spoken: string; // the question you said while circling (shown at once; asked automatically)
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
  /** Which model is answering; sent again (clear what was shown) if the cloud model failed partway. */
  | { askId: string; type: "where"; turn: number; cloud: boolean }
  | { askId: string; type: "done"; turn: number }
  | { askId: string; type: "error"; turn: number; message: string };

export type PopoverView = "home" | "start" | "find";

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
  openReview(sessionId: string, section?: "summary" | "quiz"): Promise<void>;
  redoReview(sessionId: string): Promise<void>;
  deletePassage(chunkId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getSettings(): Promise<SettingsView>;
  saveSettings(s: SettingsView): Promise<{ ok: boolean; message?: string }>;
  /** Fast mode: the key is checked, then stored in the macOS Keychain (never sent back to a window). */
  saveCloudKey(key: string): Promise<{ ok: boolean; message: string }>;
  removeCloudKey(): Promise<void>;
  testCloud(): Promise<{ ok: boolean; message: string }>;
  cloudView(): Promise<CloudView>;
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
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  endSession(): Promise<void>;
  openHistory(): Promise<void>;
  quit(): Promise<void>;
  /** The popover: which view to show, now and each time it opens. */
  popoverView(): Promise<PopoverView>;
  onPopoverOpen(callback: (view: PopoverView) => void): () => void;
  find(query: string): Promise<FoundMoment[]>;
  getNoteTree(): Promise<NoteTree>;
  getTopic(id: string): Promise<NoteTopic | null>;
  getCapture(chunkId: string): Promise<ChunkRow | null>;
  openNotes(topicId: string, sectionId?: string): Promise<void>;
  deleteTopic(id: string): Promise<void>;
  getCourseNotes(courseId: string): Promise<CourseNotes>;
  /** Moves a topic into a unit (null = "Other topics"), before another topic or at the end; the AI won't move it back. */
  moveTopic(topicId: string, unitId: string | null, beforeTopicId?: string): Promise<void>;
  renameUnit(unitId: string, title: string): Promise<void>;
  addUnit(courseId: string, title: string): Promise<string>;
  deleteUnit(unitId: string): Promise<void>;
  /** Has the AI sort the course's unsorted topics into units now. */
  sortTopics(courseId: string): Promise<void>;
  /** Notes changed (a topic was written or updated, or writing started/stopped). */
  onNotes(callback: () => void): () => void;
  foundText(chunkId: string, query: string): Promise<string | null>;
  // Study Buddy
  getBuddyView(): Promise<BuddyView | null>;
  onBuddyView(callback: (view: BuddyView) => void): () => void;
  buddyAnswer(text: string): Promise<void>;
  /** Microphone: first press listens, second press answers with what was heard. */
  buddyMic(): Promise<void>;
  buddyNotNow(): Promise<void>;
  buddyPauseSession(): Promise<void>;
  getBuddySettings(): Promise<BuddySettings>;
  /** From the first-launch picker: a character and name, "later" (ask again next launch) or "off". */
  chooseBuddy(choice: { character: BuddyCharacterId; name: string } | "later" | "off"): Promise<void>;
}

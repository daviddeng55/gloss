// The local SQLite database (Node's built-in node:sqlite, which Electron includes).
// Lives in the app's data folder: ~/Library/Application Support/Study Buddy/study-buddy.db
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChunkRow, QuestionRow, QuizItemView, SessionDetail, SessionRow, SummaryData } from "../shared/types.ts";
import type { Passage, QuizDraft } from "./ai.ts";
import type { NewChunk } from "./chunker.ts";

// Each entry upgrades the database by one version. Never edit a released entry; add a new one.
const MIGRATIONS = [
  `CREATE TABLE sessions (
     id          TEXT PRIMARY KEY,
     course_id   TEXT NOT NULL,
     goal        TEXT,
     started_at  TEXT NOT NULL,
     ended_at    TEXT,
     active_ms   INTEGER NOT NULL DEFAULT 0,   -- study time, not counting pauses
     stats       TEXT,                         -- JSON capture stats
     summary     TEXT,
     quiz_correct INTEGER,
     quiz_total   INTEGER
   );
   CREATE TABLE chunks (
     id           TEXT PRIMARY KEY,
     session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     course_id    TEXT NOT NULL,
     text         TEXT NOT NULL,
     source_app   TEXT NOT NULL,
     source_title TEXT NOT NULL,
     captured_at  TEXT NOT NULL,
     embedding    BLOB
   );
   CREATE INDEX chunks_session ON chunks(session_id, captured_at);
   CREATE INDEX chunks_course ON chunks(course_id, captured_at);
   CREATE INDEX sessions_course ON sessions(course_id, started_at);`,
  // 2: Stage 3 — quizzes. sessions.summary holds the summary as JSON.
  `CREATE TABLE quiz_items (
     id            TEXT PRIMARY KEY,
     course_id     TEXT NOT NULL,
     session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     chunk_id      TEXT REFERENCES chunks(id) ON DELETE SET NULL,
     position      INTEGER NOT NULL,
     type          TEXT NOT NULL,              -- multiple_choice | short_answer
     question      TEXT NOT NULL,
     options       TEXT,                       -- JSON array, multiple choice only
     answer        TEXT NOT NULL,
     created_at    TEXT NOT NULL,
     next_due_at   TEXT,                       -- spaced review (Stage 5)
     interval_days INTEGER,
     history       TEXT NOT NULL DEFAULT '[]', -- JSON [{at, correct, response}]
     explanation   TEXT                        -- feedback on the latest wrong answer
   );
   CREATE INDEX quiz_session ON quiz_items(session_id, position);
   CREATE INDEX quiz_due ON quiz_items(course_id, next_due_at);
   ALTER TABLE sessions ADD COLUMN quiz_note TEXT; -- why no quiz could be made`,
  // 3: Stage 4 — questions asked about the screen (the screenshot itself is never stored).
  `CREATE TABLE questions (
     id           TEXT PRIMARY KEY,
     session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     course_id    TEXT NOT NULL,
     asked_at     TEXT NOT NULL,
     question     TEXT NOT NULL,
     source_title TEXT,
     answers      TEXT NOT NULL DEFAULT '[]'  -- JSON [{level, text, at}]
   );
   CREATE INDEX questions_session ON questions(session_id, asked_at);`,
];

type Row = Record<string, any>;

export class StudyDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.closeAbandonedSessions();
  }

  private migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as Row).user_version as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      this.db.exec(MIGRATIONS[v]);
      this.db.exec(`PRAGMA user_version = ${v + 1}`);
      this.db.exec("COMMIT");
    }
  }

  /** If the app quit or crashed mid-session, mark that session ended at its last captured text. */
  private closeAbandonedSessions() {
    this.db.exec(`UPDATE sessions
      SET ended_at = COALESCE((SELECT MAX(captured_at) FROM chunks WHERE session_id = sessions.id), started_at)
      WHERE ended_at IS NULL`);
  }

  createSession(s: { courseId: string; goal?: string; startedAt: string }): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO sessions (id, course_id, goal, started_at) VALUES (?, ?, ?, ?)")
      .run(id, s.courseId, s.goal || null, s.startedAt);
    return id;
  }

  /** Saved every few seconds so a crash loses little. */
  updateActiveTime(id: string, activeMs: number) {
    this.db.prepare("UPDATE sessions SET active_ms = ? WHERE id = ?").run(Math.round(activeMs), id);
  }

  endSession(id: string, e: { endedAt: string; activeMs: number; stats: object }) {
    this.db
      .prepare("UPDATE sessions SET ended_at = ?, active_ms = ?, stats = ? WHERE id = ?")
      .run(e.endedAt, Math.round(e.activeMs), JSON.stringify(e.stats), id);
  }

  addChunk(sessionId: string, courseId: string, c: NewChunk): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO chunks (id, session_id, course_id, text, source_app, source_title, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, courseId, c.text, c.sourceApp, c.sourceTitle, c.capturedAt);
    return id;
  }

  /** All sessions, newest first, with how much text each one saved. */
  listSessions(): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(c.id) AS chunk_count, COALESCE(SUM(LENGTH(c.text)), 0) AS char_count
         FROM sessions s LEFT JOIN chunks c ON c.session_id = s.id
         GROUP BY s.id ORDER BY s.started_at DESC`,
      )
      .all() as Row[];
    return rows.map(toSession);
  }

  getSession(id: string): SessionDetail | null {
    const s = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM chunks WHERE session_id = s.id) AS chunk_count,
                (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM chunks WHERE session_id = s.id) AS char_count
         FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!s) return null;
    const chunks = this.db
      .prepare("SELECT * FROM chunks WHERE session_id = ? ORDER BY captured_at, rowid")
      .all(id) as Row[];
    return { ...toSession(s), chunks: chunks.map(toChunk), questions: this.getQuestions(id) };
  }

  // ---------- Stage 3: summary and quiz ----------

  /** The session's text passages, in order, for the AI. */
  getPassages(sessionId: string): Passage[] {
    return this.db
      .prepare("SELECT id, text, source_title AS sourceTitle FROM chunks WHERE session_id = ? ORDER BY captured_at, rowid")
      .all(sessionId) as Passage[];
  }

  saveSummary(sessionId: string, summary: SummaryData) {
    this.db.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(JSON.stringify(summary), sessionId);
  }

  getSummary(sessionId: string): SummaryData | null {
    const r = this.db.prepare("SELECT summary FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
    return r?.summary ? JSON.parse(r.summary) : null;
  }

  /** Saves a new quiz (replacing none: a session gets one quiz). */
  saveQuiz(sessionId: string, courseId: string, questions: QuizDraft[]) {
    const insert = this.db.prepare(
      `INSERT INTO quiz_items (id, course_id, session_id, chunk_id, position, type, question, options, answer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    questions.forEach((q, i) =>
      insert.run(randomUUID(), courseId, sessionId, q.passageId, i, q.type, q.question,
        q.options ? JSON.stringify(q.options) : null, q.answer, now),
    );
    this.db.prepare("UPDATE sessions SET quiz_total = ?, quiz_correct = 0, quiz_note = NULL WHERE id = ?").run(questions.length, sessionId);
    this.db.exec("COMMIT");
  }

  saveQuizNote(sessionId: string, note: string) {
    this.db.prepare("UPDATE sessions SET quiz_note = ? WHERE id = ?").run(note, sessionId);
  }

  getQuizNote(sessionId: string): string | null {
    return ((this.db.prepare("SELECT quiz_note FROM sessions WHERE id = ?").get(sessionId) as Row | undefined)?.quiz_note) ?? null;
  }

  hasQuiz(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM quiz_items WHERE session_id = ? LIMIT 1").get(sessionId);
  }

  /** Quiz questions for the window. The answer is only included once the question has been answered. */
  getQuiz(sessionId: string): QuizItemView[] {
    const rows = this.db.prepare("SELECT * FROM quiz_items WHERE session_id = ? ORDER BY position").all(sessionId) as Row[];
    return rows.map((r) => {
      const history = JSON.parse(r.history) as { at: string; correct: boolean; response: string }[];
      const first = history[0];
      return {
        id: r.id,
        chunkId: r.chunk_id ?? undefined,
        type: r.type,
        question: r.question,
        options: r.options ? JSON.parse(r.options) : undefined,
        answered: first ? { response: first.response, correct: first.correct, answer: r.answer, explanation: r.explanation ?? "" } : undefined,
      };
    });
  }

  getQuizItem(id: string): { id: string; sessionId: string; chunkId?: string; type: string; question: string; answer: string } | null {
    const r = this.db.prepare("SELECT * FROM quiz_items WHERE id = ?").get(id) as Row | undefined;
    return r ? { id: r.id, sessionId: r.session_id, chunkId: r.chunk_id ?? undefined, type: r.type, question: r.question, answer: r.answer } : null;
  }

  getChunkText(id: string): string {
    return ((this.db.prepare("SELECT text FROM chunks WHERE id = ?").get(id) as Row | undefined)?.text) ?? "";
  }

  /**
   * Records an answer. The session score counts each question's first answer. Spaced review (used in
   * Stage 5): wrong comes back next session; right comes back after 3 days, then 7, then 14.
   */
  recordAnswer(id: string, a: { correct: boolean; response: string; explanation: string; at: string }) {
    const r = this.db.prepare("SELECT session_id, history, interval_days FROM quiz_items WHERE id = ?").get(id) as Row;
    const history = [...JSON.parse(r.history), { at: a.at, correct: a.correct, response: a.response }];
    const steps = [3, 7, 14];
    const interval = a.correct ? (steps.find((d) => d > (r.interval_days ?? 0)) ?? 14) : 0;
    const due = new Date(Date.parse(a.at) + interval * 86_400_000).toISOString();
    this.db
      .prepare("UPDATE quiz_items SET history = ?, interval_days = ?, next_due_at = ?, explanation = ? WHERE id = ?")
      .run(JSON.stringify(history), interval, due, a.explanation || null, id);
    this.db
      .prepare(
        `UPDATE sessions SET quiz_correct = (SELECT COUNT(*) FROM quiz_items
           WHERE session_id = ? AND json_extract(history, '$[0].correct') = 1) WHERE id = ?`,
      )
      .run(r.session_id, r.session_id);
  }

  // ---------- Stage 4: questions ----------

  addQuestion(sessionId: string, courseId: string, question: string, sourceTitle: string): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO questions (id, session_id, course_id, asked_at, question, source_title) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, sessionId, courseId, new Date().toISOString(), question, sourceTitle);
    return id;
  }

  addAnswer(questionId: string, level: string, text: string) {
    const r = this.db.prepare("SELECT answers FROM questions WHERE id = ?").get(questionId) as Row | undefined;
    if (!r) return;
    const answers = [...JSON.parse(r.answers), { level, text, at: new Date().toISOString() }];
    this.db.prepare("UPDATE questions SET answers = ? WHERE id = ?").run(JSON.stringify(answers), questionId);
  }

  getQuestions(sessionId: string): QuestionRow[] {
    return (this.db.prepare("SELECT * FROM questions WHERE session_id = ? ORDER BY asked_at").all(sessionId) as Row[]).map((r) => ({
      id: r.id,
      askedAt: r.asked_at,
      question: r.question,
      sourceTitle: r.source_title ?? "",
      answers: JSON.parse(r.answers),
    }));
  }

  /** Removes one passage (the user chose to; e.g. a page they didn't mean to study). */
  deleteChunk(id: string) {
    this.db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
  }

  /** Clears a session's summary and quiz (including answers) so they can be made again. */
  clearReview(sessionId: string) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM quiz_items WHERE session_id = ?").run(sessionId);
    this.db
      .prepare("UPDATE sessions SET summary = NULL, quiz_note = NULL, quiz_correct = NULL, quiz_total = NULL WHERE id = ?")
      .run(sessionId);
    this.db.exec("COMMIT");
  }

  close() {
    this.db.close();
  }
}

function toSession(r: Row): SessionRow {
  return {
    id: r.id,
    courseId: r.course_id,
    goal: r.goal ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    activeMs: r.active_ms,
    chunkCount: r.chunk_count,
    charCount: r.char_count,
    summary: r.summary ? JSON.parse(r.summary) : undefined,
    quizScore: r.quiz_total != null ? { correct: r.quiz_correct, total: r.quiz_total } : undefined,
  };
}

function toChunk(r: Row): ChunkRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    courseId: r.course_id,
    text: r.text,
    sourceApp: r.source_app,
    sourceTitle: r.source_title,
    capturedAt: r.captured_at,
  };
}

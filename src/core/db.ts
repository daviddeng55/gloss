// The local SQLite database (Node's built-in node:sqlite, which Electron includes).
// Lives in the app's data folder: ~/Library/Application Support/Gloss/gloss.db
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChunkRow, QuestionRow, QuizItemView, SessionDetail, SessionRow, SummaryData } from "../shared/types.ts";
import type { Passage, QuizDraft } from "./ai.ts";
import { conceptKey, type Evidence, type HintLevelName } from "./learner.ts";
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
  // 4: Stage 5 — the learner model. Mastery isn't stored: it's worked out from the evidence (learner.ts).
  `CREATE TABLE concepts (
     id         TEXT PRIMARY KEY,
     course_id  TEXT NOT NULL,
     name       TEXT NOT NULL,
     key        TEXT NOT NULL,            -- normalized name, for matching
     created_at TEXT NOT NULL,
     embedding  BLOB,
     UNIQUE (course_id, key)
   );
   CREATE TABLE concept_chunks (
     concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
     chunk_id   TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     PRIMARY KEY (concept_id, chunk_id)
   );
   CREATE TABLE evidence (
     id         TEXT PRIMARY KEY,
     concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
     at         TEXT NOT NULL,
     kind       TEXT NOT NULL,            -- covered | quiz | ask | manual
     correct    INTEGER,
     hint_level TEXT,
     session_id TEXT,
     ref_id     TEXT                      -- quiz item or question it came from
   );
   CREATE INDEX evidence_concept ON evidence(concept_id, at);
   CREATE INDEX concept_chunks_session ON concept_chunks(session_id);
   ALTER TABLE quiz_items ADD COLUMN concept_id TEXT;
   ALTER TABLE questions ADD COLUMN concept_id TEXT;`,
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
      `INSERT INTO quiz_items (id, course_id, session_id, chunk_id, position, type, question, options, answer, created_at, concept_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    questions.forEach((q, i) =>
      insert.run(randomUUID(), courseId, sessionId, q.passageId, i, q.type, q.question,
        q.options ? JSON.stringify(q.options) : null, q.answer, now, q.conceptId ?? null),
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
  recordAnswer(id: string, a: { correct: boolean; response: string; explanation: string; at: string; intervalDays?: number }) {
    const r = this.db.prepare("SELECT session_id, history, interval_days FROM quiz_items WHERE id = ?").get(id) as Row;
    const history = [...JSON.parse(r.history), { at: a.at, correct: a.correct, response: a.response }];
    const steps = [3, 7, 14];
    const interval = a.intervalDays ?? (a.correct ? (steps.find((d) => d > (r.interval_days ?? 0)) ?? 14) : 0);
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

  // ---------- Stage 5: learner model ----------

  /** Finds or creates a concept for this course by (normalized) name. */
  upsertConcept(courseId: string, name: string): string {
    const key = conceptKey(name);
    const found = this.db.prepare("SELECT id FROM concepts WHERE course_id = ? AND key = ?").get(courseId, key) as Row | undefined;
    if (found) return found.id;
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO concepts (id, course_id, name, key, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, courseId, name.trim().slice(0, 120), key, new Date().toISOString());
    return id;
  }

  linkConcept(conceptId: string, chunkId: string, sessionId: string) {
    this.db.prepare("INSERT OR IGNORE INTO concept_chunks (concept_id, chunk_id, session_id) VALUES (?, ?, ?)").run(conceptId, chunkId, sessionId);
  }

  addEvidence(conceptId: string, e: Evidence & { sessionId?: string; refId?: string }): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO evidence (id, concept_id, at, kind, correct, hint_level, session_id, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, conceptId, e.at, e.kind, e.correct === undefined ? null : e.correct ? 1 : 0, e.hintLevel ?? null, e.sessionId ?? null, e.refId ?? null);
    return id;
  }

  /** Raises the hint level recorded for a question as you climb the hint ladder. */
  raiseAskLevel(questionId: string, level: HintLevelName) {
    const order = ["nudge", "explain", "example"];
    const r = this.db.prepare("SELECT id, hint_level FROM evidence WHERE kind = 'ask' AND ref_id = ?").get(questionId) as Row | undefined;
    if (r && order.indexOf(level) > order.indexOf(r.hint_level)) {
      this.db.prepare("UPDATE evidence SET hint_level = ? WHERE id = ?").run(level, r.id);
    }
  }

  hasCoveredEvidence(conceptId: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM evidence WHERE concept_id = ? AND session_id = ? AND kind = 'covered'").get(conceptId, sessionId);
  }

  /** Concepts with their evidence, for one course or all. */
  getConcepts(courseId?: string): { id: string; courseId: string; name: string; createdAt: string; evidence: (Evidence & { sessionId?: string })[] }[] {
    const rows = (courseId
      ? this.db.prepare("SELECT * FROM concepts WHERE course_id = ? ORDER BY created_at").all(courseId)
      : this.db.prepare("SELECT * FROM concepts ORDER BY created_at").all()) as Row[];
    const ev = this.db.prepare("SELECT * FROM evidence WHERE concept_id = ? ORDER BY at");
    return rows.map((r) => ({
      id: r.id,
      courseId: r.course_id,
      name: r.name,
      createdAt: r.created_at,
      evidence: (ev.all(r.id) as Row[]).map((e) => ({
        at: e.at,
        kind: e.kind,
        correct: e.correct === null ? undefined : !!e.correct,
        hintLevel: e.hint_level ?? undefined,
        sessionId: e.session_id ?? undefined,
      })),
    }));
  }

  /** Concept ids covered in a session, with the chunks that show each. */
  sessionConcepts(sessionId: string): { conceptId: string; chunkIds: string[] }[] {
    const rows = this.db.prepare("SELECT concept_id, chunk_id FROM concept_chunks WHERE session_id = ?").all(sessionId) as Row[];
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.concept_id, [...(map.get(r.concept_id) ?? []), r.chunk_id]);
    return [...map].map(([conceptId, chunkIds]) => ({ conceptId, chunkIds }));
  }

  /** Where a concept appears: its passages with session dates (newest first). */
  conceptSources(conceptId: string): { chunkId: string; sessionId: string; startedAt: string; sourceTitle: string; text: string }[] {
    return (this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.session_id, s.started_at, c.source_title, c.text
         FROM concept_chunks cc JOIN chunks c ON c.id = cc.chunk_id JOIN sessions s ON s.id = c.session_id
         WHERE cc.concept_id = ? ORDER BY s.started_at DESC, c.captured_at`,
      )
      .all(conceptId) as Row[]).map((r) => ({ chunkId: r.chunk_id, sessionId: r.session_id, startedAt: r.started_at, sourceTitle: r.source_title, text: r.text }));
  }

  /** Concepts linked to any of these passages. */
  conceptsForChunks(chunkIds: string[]): string[] {
    if (!chunkIds.length) return [];
    const q = this.db.prepare(`SELECT DISTINCT concept_id FROM concept_chunks WHERE chunk_id IN (${chunkIds.map(() => "?").join(",")})`);
    return (q.all(...chunkIds) as Row[]).map((r) => r.concept_id);
  }

  setManual(conceptId: string, known: boolean | null) {
    this.db.prepare("DELETE FROM evidence WHERE concept_id = ? AND kind = 'manual'").run(conceptId);
    if (known !== null) this.addEvidence(conceptId, { at: new Date().toISOString(), kind: "manual", correct: known });
  }

  deleteConcept(conceptId: string) {
    this.db.prepare("UPDATE quiz_items SET concept_id = NULL WHERE concept_id = ?").run(conceptId);
    this.db.prepare("UPDATE questions SET concept_id = NULL WHERE concept_id = ?").run(conceptId);
    this.db.prepare("DELETE FROM concepts WHERE id = ?").run(conceptId);
  }

  /** Deletes the learner model for one course (or everything). Your notes and sessions stay. */
  deleteLearnerModel(courseId?: string) {
    this.db.exec("BEGIN");
    if (courseId) {
      this.db.prepare("UPDATE quiz_items SET concept_id = NULL WHERE course_id = ?").run(courseId);
      this.db.prepare("UPDATE questions SET concept_id = NULL WHERE course_id = ?").run(courseId);
      this.db.prepare("DELETE FROM concepts WHERE course_id = ?").run(courseId);
    } else {
      this.db.exec("UPDATE quiz_items SET concept_id = NULL; UPDATE questions SET concept_id = NULL; DELETE FROM concepts;");
    }
    this.db.exec("COMMIT");
  }

  setQuestionConcept(questionId: string, conceptId: string) {
    this.db.prepare("UPDATE questions SET concept_id = ? WHERE id = ?").run(conceptId, questionId);
  }

  /** Concepts asked about in this session, with the highest hint level reached. */
  askedThisSession(sessionId: string): Map<string, HintLevelName> {
    const rows = this.db
      .prepare("SELECT concept_id, hint_level FROM evidence WHERE kind = 'ask' AND session_id = ? ORDER BY at")
      .all(sessionId) as Row[];
    return new Map(rows.map((r) => [r.concept_id, r.hint_level]));
  }

  /** Quiz questions due for review in a course: wrong ones first, then by due date. */
  dueQuizItems(courseId: string, now: string, limit: number): string[] {
    return (this.db
      .prepare(
        `SELECT id FROM quiz_items
         WHERE course_id = ? AND json_array_length(history) > 0 AND next_due_at IS NOT NULL AND next_due_at <= ?
         ORDER BY json_extract(history, '$[#-1].correct') ASC, next_due_at ASC LIMIT ?`,
      )
      .all(courseId, now, limit) as Row[]).map((r) => r.id);
  }

  getQuizItemsByIds(ids: string[]): QuizItemView[] {
    const one = this.db.prepare("SELECT * FROM quiz_items WHERE id = ?");
    return ids
      .map((id) => one.get(id) as Row | undefined)
      .filter((r): r is Row => !!r)
      .map((r) => ({ id: r.id, chunkId: r.chunk_id ?? undefined, type: r.type, question: r.question, options: r.options ? JSON.parse(r.options) : undefined }));
  }

  quizItemConcept(itemId: string): { conceptId?: string; intervalDays: number; sessionId: string; courseId: string } | null {
    const r = this.db.prepare("SELECT concept_id, interval_days, session_id, course_id FROM quiz_items WHERE id = ?").get(itemId) as Row | undefined;
    return r ? { conceptId: r.concept_id ?? undefined, intervalDays: r.interval_days ?? 0, sessionId: r.session_id, courseId: r.course_id } : null;
  }

  // ---------- Stage 5: course memory ----------

  /** Every passage of a course (optionally without one session), for searching. */
  coursePassages(courseId: string, excludeSessionId?: string): (Passage & { sessionId: string; startedAt: string; embedding?: Float32Array })[] {
    return (this.db
      .prepare(
        `SELECT c.id, c.text, c.source_title, c.session_id, c.embedding, s.started_at FROM chunks c JOIN sessions s ON s.id = c.session_id
         WHERE c.course_id = ? AND (? IS NULL OR c.session_id <> ?) ORDER BY c.captured_at`,
      )
      .all(courseId, excludeSessionId ?? null, excludeSessionId ?? null) as Row[]).map((r) => ({
      id: r.id,
      text: r.text,
      sourceTitle: r.source_title,
      sessionId: r.session_id,
      startedAt: r.started_at,
      embedding: r.embedding ? new Float32Array(new Uint8Array(r.embedding).buffer) : undefined,
    }));
  }

  chunksWithoutEmbedding(limit: number): { id: string; text: string }[] {
    return this.db.prepare("SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT ?").all(limit) as { id: string; text: string }[];
  }

  setChunkEmbedding(chunkId: string, vector: number[]) {
    this.db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?").run(new Uint8Array(new Float32Array(vector).buffer), chunkId);
  }

  setConceptEmbedding(conceptId: string, vector: number[]) {
    this.db.prepare("UPDATE concepts SET embedding = ? WHERE id = ?").run(new Uint8Array(new Float32Array(vector).buffer), conceptId);
  }

  conceptEmbeddings(courseId: string): { id: string; name: string; embedding?: Float32Array }[] {
    return (this.db.prepare("SELECT id, name, embedding FROM concepts WHERE course_id = ?").all(courseId) as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      embedding: r.embedding ? new Float32Array(new Uint8Array(r.embedding).buffer) : undefined,
    }));
  }

  /**
   * Deletes a session and everything from it: notes, quiz, questions, and the learner-model evidence
   * it produced. Concepts left with no notes and no evidence are removed too.
   */
  deleteSession(sessionId: string) {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM evidence WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId); // chunks, quiz, questions cascade
    this.removeOrphanConcepts();
    this.db.exec("COMMIT");
  }

  /** Deletes every session of a course and its learner model. */
  deleteCourseData(courseId: string) {
    this.db.exec("BEGIN");
    const ids = (this.db.prepare("SELECT id FROM sessions WHERE course_id = ?").all(courseId) as Row[]).map((r) => r.id);
    for (const id of ids) this.db.prepare("DELETE FROM evidence WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE course_id = ?").run(courseId);
    this.db.prepare("DELETE FROM concepts WHERE course_id = ?").run(courseId);
    this.db.exec("COMMIT");
  }

  private removeOrphanConcepts() {
    this.db.exec(`DELETE FROM concepts WHERE id NOT IN (SELECT concept_id FROM concept_chunks)
                  AND id NOT IN (SELECT concept_id FROM evidence)`);
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

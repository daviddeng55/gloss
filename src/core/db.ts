// The local SQLite database (Node's built-in node:sqlite, which Electron includes).
// Lives in the app's data folder: ~/Library/Application Support/Gloss/gloss.db
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BuddyChatView, ChunkRow, FoundMoment, NoteTopic, NoteTree, QuestionRow, QuizItemView, SessionDetail, SessionRow, SummaryData } from "../shared/types.ts";
import type { Passage, QuizDraft } from "./ai.ts";
import { conceptKey, type Evidence, type HintLevelName } from "./learner.ts";
import type { NoteSectionDraft } from "./notes.ts";
import type { NewChunk } from "./chunker.ts";
import type { BuddyTurn } from "./buddy.ts";
import { MATCH_END, MATCH_START, toFtsQuery } from "../shared/search.ts";

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
  // 5: "Find it" — a full-text index of every passage, filled from the existing ones and kept in step
  // by triggers (which also run when deleting a session or course removes its passages).
  // chunks.fts_rowid links each passage to its index row, so deletes find it at once.
  `CREATE VIRTUAL TABLE chunks_fts USING fts5(
     text, source_title, source_app, chunk_id UNINDEXED,
     tokenize = 'unicode61 remove_diacritics 2'
   );
   ALTER TABLE chunks ADD COLUMN fts_rowid INTEGER;
   INSERT INTO chunks_fts (rowid, text, source_title, source_app, chunk_id)
     SELECT rowid, text, source_title, source_app, id FROM chunks;
   UPDATE chunks SET fts_rowid = rowid;
   CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
     INSERT INTO chunks_fts (text, source_title, source_app, chunk_id) VALUES (new.text, new.source_title, new.source_app, new.id);
     UPDATE chunks SET fts_rowid = last_insert_rowid() WHERE id = new.id;
   END;
   CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
     DELETE FROM chunks_fts WHERE rowid = old.fts_rowid;
   END;
   CREATE TRIGGER chunks_fts_update AFTER UPDATE OF text, source_title, source_app ON chunks BEGIN
     UPDATE chunks_fts SET text = new.text, source_title = new.source_title, source_app = new.source_app WHERE rowid = new.fts_rowid;
   END;`,
  // 6: Notes — class notes per course and topic, written from the raw captures (which stay as they are).
  // Each section points to the capture it came from; deleting a session or passage removes its sections.
  `CREATE TABLE topics (
     id         TEXT PRIMARY KEY,
     course_id  TEXT NOT NULL,
     title      TEXT NOT NULL,
     key        TEXT NOT NULL,              -- normalized title, for merging
     summary    TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (course_id, key)
   );
   CREATE TABLE note_sections (
     seq        INTEGER PRIMARY KEY,        -- stable row number, used by the search index
     id         TEXT NOT NULL UNIQUE,
     topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     chunk_id   TEXT REFERENCES chunks(id) ON DELETE CASCADE,
     kind       TEXT NOT NULL,              -- definition | theorem | formula | example | mistake | point
     title      TEXT NOT NULL,
     body       TEXT NOT NULL,              -- Markdown with $LaTeX$
     created_at TEXT NOT NULL
   );
   CREATE INDEX note_sections_topic ON note_sections(topic_id, seq);
   CREATE INDEX note_sections_session ON note_sections(session_id);
   CREATE INDEX note_sections_chunk ON note_sections(chunk_id);
   ALTER TABLE sessions ADD COLUMN notes_status TEXT;  -- NULL = not written yet | done | skipped | error
   ALTER TABLE sessions ADD COLUMN notes_error TEXT;
   CREATE VIRTUAL TABLE notes_fts USING fts5(
     title, body, topic, section_id UNINDEXED,
     tokenize = 'unicode61 remove_diacritics 2'
   );
   CREATE TRIGGER note_sections_fts_insert AFTER INSERT ON note_sections BEGIN
     INSERT INTO notes_fts (rowid, title, body, topic, section_id)
       VALUES (new.seq, new.title, new.body, (SELECT title FROM topics WHERE id = new.topic_id), new.id);
   END;
   CREATE TRIGGER note_sections_fts_delete AFTER DELETE ON note_sections BEGIN
     DELETE FROM notes_fts WHERE rowid = old.seq;
   END;
   CREATE TRIGGER note_sections_fts_update AFTER UPDATE OF title, body ON note_sections BEGIN
     UPDATE notes_fts SET title = new.title, body = new.body WHERE rowid = new.seq;
   END;`,
  // 7: Study Buddy — each chat with the buddy (its question, your answers, its reactions), shown in the
  // session's review. The AI's verdict on each answer is kept for the learner model, never shown.
  `CREATE TABLE buddy_chats (
     id         TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     course_id  TEXT NOT NULL,
     concept_id TEXT,
     topic      TEXT NOT NULL,              -- what it asked about
     character  TEXT NOT NULL,              -- dog | cat | penguin | birdie
     buddy_name TEXT NOT NULL,
     started_at TEXT NOT NULL,
     turns      TEXT NOT NULL DEFAULT '[]', -- JSON [{who: buddy|you, text, at, verdict?}]
     outcome    TEXT                        -- NULL = open | understood | gap | skipped
   );
   CREATE INDEX buddy_chats_session ON buddy_chats(session_id, started_at);`,
  // 8: Fast mode — whether a quiz or a note section was written by the cloud model (for the "sent to cloud"
  // label). Summaries, answers and buddy chats keep this inside their JSON.
  `ALTER TABLE sessions ADD COLUMN quiz_cloud INTEGER;
   ALTER TABLE note_sections ADD COLUMN cloud INTEGER;`,
  // 9: Units — a course's topics grouped under general headings (sorted by the AI; you can rename units and
  // move topics, which locks them where you put them). And a cache of the cross-references between notes.
  `CREATE TABLE units (
     id         TEXT PRIMARY KEY,
     course_id  TEXT NOT NULL,
     title      TEXT NOT NULL,
     key        TEXT NOT NULL,              -- normalized title, for matching the AI's names
     position   INTEGER NOT NULL,
     renamed    INTEGER NOT NULL DEFAULT 0, -- you named it (the AI never renames units anyway)
     created_at TEXT NOT NULL
   );
   CREATE INDEX units_course ON units(course_id, position);
   ALTER TABLE topics ADD COLUMN unit_id TEXT REFERENCES units(id) ON DELETE SET NULL;
   ALTER TABLE topics ADD COLUMN unit_pos INTEGER;                     -- order inside the unit
   ALTER TABLE topics ADD COLUMN unit_locked INTEGER NOT NULL DEFAULT 0; -- you moved it: the AI leaves it there
   CREATE TABLE xref_cache (
     topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
     version  TEXT NOT NULL,                -- notesVersion() when computed; recomputed when notes change
     links    TEXT NOT NULL                 -- JSON { sectionId | "summary": [{text, topicId, sectionId?}] }
   );`,
];

type Row = Record<string, any>;

export class StudyDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate(path);
    this.closeAbandonedSessions();
  }

  private migrate(path: string) {
    const version = (this.db.prepare("PRAGMA user_version").get() as Row).user_version as number;
    // Before upgrading an existing database, save a full copy next to it (e.g. gloss.backup-v4.db).
    if (version > 0 && version < MIGRATIONS.length && path !== ":memory:") {
      const backup = path.replace(/(\.db)?$/, `.backup-v${version}.db`);
      if (!existsSync(backup)) this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK"); // leave the database exactly as it was
        throw e;
      }
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

  // ---------- Find it: full-text search over everything captured ----------

  /** Passages matching what you typed, best matches first, with the matching words marked. */
  search(input: string, limit = 50): Omit<FoundMoment, "courseName">[] {
    const query = toFtsQuery(input);
    if (!query) return [];
    return (this.db
      .prepare(
        `SELECT c.id, c.session_id, c.course_id, c.source_app, c.captured_at,
                highlight(chunks_fts, 1, ?, ?) AS title, snippet(chunks_fts, 0, ?, ?, '…', 24) AS snippet
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.chunk_id
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(MATCH_START, MATCH_END, MATCH_START, MATCH_END, query, limit) as Row[]).map((r) => ({
      kind: "capture" as const,
      chunkId: r.id,
      sessionId: r.session_id,
      courseId: r.course_id,
      sourceApp: r.source_app,
      sourceTitle: r.title,
      capturedAt: r.captured_at,
      snippet: r.snippet,
    }));
  }

  /** A passage's whole text, with the words matching what you typed marked. */
  foundText(chunkId: string, input: string): string | null {
    const query = toFtsQuery(input);
    const r = (query
      ? this.db
          .prepare("SELECT highlight(chunks_fts, 0, ?, ?) AS text FROM chunks_fts WHERE chunks_fts MATCH ? AND chunk_id = ?")
          .get(MATCH_START, MATCH_END, query, chunkId)
      : undefined) as Row | undefined;
    return r?.text ?? (this.getChunkText(chunkId) || null);
  }

  /** Note sections matching what you typed, best first, with the matching words marked. */
  searchNotes(input: string, limit = 10): Omit<FoundMoment, "courseName">[] {
    const query = toFtsQuery(input);
    if (!query) return [];
    return (this.db
      .prepare(
        `SELECT n.id, n.session_id, n.chunk_id, n.created_at, t.id AS topic_id, t.course_id, t.title AS topic_title,
                c.source_app, c.captured_at,
                highlight(notes_fts, 0, ?, ?) AS title, snippet(notes_fts, 1, ?, ?, '…', 24) AS snippet
         FROM notes_fts JOIN note_sections n ON n.seq = notes_fts.rowid JOIN topics t ON t.id = n.topic_id
         LEFT JOIN chunks c ON c.id = n.chunk_id
         WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(MATCH_START, MATCH_END, MATCH_START, MATCH_END, query, limit) as Row[]).map((r) => ({
      kind: "note" as const,
      chunkId: r.chunk_id ?? "",
      sessionId: r.session_id,
      courseId: r.course_id,
      sourceApp: r.source_app ?? "",
      sourceTitle: r.title,
      capturedAt: r.captured_at ?? r.created_at,
      snippet: r.snippet,
      topicId: r.topic_id,
      topicTitle: r.topic_title,
      sectionId: r.id,
    }));
  }

  // ---------- Notes: course → topic → sections ----------

  /** Sessions whose notes haven't been written yet (ended, with text), oldest first. */
  sessionsNeedingNotes(): { id: string; courseId: string }[] {
    return (this.db
      .prepare(
        `SELECT s.id, s.course_id FROM sessions s
         WHERE s.ended_at IS NOT NULL AND s.notes_status IS NULL AND EXISTS (SELECT 1 FROM chunks WHERE session_id = s.id)
         ORDER BY s.started_at`,
      )
      .all() as Row[]).map((r) => ({ id: r.id, courseId: r.course_id }));
  }

  setNotesStatus(sessionId: string, status: "done" | "skipped" | "error", error?: string) {
    this.db.prepare("UPDATE sessions SET notes_status = ?, notes_error = ? WHERE id = ?").run(status, error ?? null, sessionId);
  }

  /** Every topic, for matching new material to existing topics. */
  topicTitles(): { id: string; courseId: string; title: string }[] {
    return (this.db.prepare("SELECT id, course_id, title FROM topics ORDER BY created_at").all() as Row[]).map((r) => ({
      id: r.id,
      courseId: r.course_id,
      title: r.title,
    }));
  }

  /** A topic's summary and section titles (what the notes already say), or null if it doesn't exist. */
  topicForMerge(courseId: string, key: string): { id: string; summary: string; sectionTitles: string[] } | null {
    const t = this.db.prepare("SELECT id, summary FROM topics WHERE course_id = ? AND key = ?").get(courseId, key) as Row | undefined;
    if (!t) return null;
    const titles = (this.db.prepare("SELECT title FROM note_sections WHERE topic_id = ? ORDER BY seq").all(t.id) as Row[]).map((r) => r.title);
    return { id: t.id, summary: t.summary, sectionTitles: titles };
  }

  /** Every section title in a course's notes (to avoid writing the same thing under two topics). */
  courseSectionTitles(courseId: string): string[] {
    return (this.db
      .prepare("SELECT n.title FROM note_sections n JOIN topics t ON t.id = n.topic_id WHERE t.course_id = ?")
      .all(courseId) as Row[]).map((r) => r.title);
  }

  /** Adds new material to a topic (creating it if needed), all at once. */
  saveTopicNotes(n: { courseId: string; title: string; key: string; summary: string; sessionId: string; sections: NoteSectionDraft[]; cloud?: boolean }): string {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      let id = (this.db.prepare("SELECT id FROM topics WHERE course_id = ? AND key = ?").get(n.courseId, n.key) as Row | undefined)?.id as string | undefined;
      if (!id) {
        id = randomUUID();
        this.db
          .prepare("INSERT INTO topics (id, course_id, title, key, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, n.courseId, n.title, n.key, n.summary, now, now);
      } else {
        this.db.prepare("UPDATE topics SET summary = ?, updated_at = ? WHERE id = ?").run(n.summary, now, id);
      }
      const insert = this.db.prepare(
        "INSERT INTO note_sections (id, topic_id, session_id, chunk_id, kind, title, body, created_at, cloud) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const s of n.sections) insert.run(randomUUID(), id, n.sessionId, s.passageId, s.kind, s.title, s.body, now, n.cloud ? 1 : null);
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Courses' topics for the sidebar (oldest topic first, like a course outline), and what's still being written. */
  noteTree(): Omit<NoteTree, "courses" | "writing"> & { topics: { id: string; courseId: string; title: string; sections: number; updatedAt: string }[] } {
    const topics = (this.db
      .prepare(
        `SELECT t.id, t.course_id, t.title, t.updated_at, COUNT(n.seq) AS sections
         FROM topics t LEFT JOIN note_sections n ON n.topic_id = t.id GROUP BY t.id ORDER BY t.created_at`,
      )
      .all() as Row[]).map((r) => ({ id: r.id, courseId: r.course_id, title: r.title, sections: r.sections, updatedAt: r.updated_at }));
    const pending = (this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s WHERE s.ended_at IS NOT NULL AND s.notes_status IS NULL
         AND EXISTS (SELECT 1 FROM chunks WHERE session_id = s.id)`,
      )
      .get() as Row).n as number;
    return { topics, pending };
  }

  /** One topic with its sections and where each came from. */
  getTopic(id: string): Omit<NoteTopic, "courseName"> | null {
    const t = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Row | undefined;
    if (!t) return null;
    const sections = (this.db
      .prepare(
        `SELECT n.*, c.captured_at, c.source_title FROM note_sections n LEFT JOIN chunks c ON c.id = n.chunk_id
         WHERE n.topic_id = ? ORDER BY n.seq`,
      )
      .all(id) as Row[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      chunkId: r.chunk_id ?? undefined,
      sessionId: r.session_id,
      capturedAt: r.captured_at ?? undefined,
      sourceTitle: r.source_title ?? undefined,
      ...(r.cloud ? { cloud: true } : {}),
    }));
    const unit = t.unit_id ? (this.db.prepare("SELECT id, title FROM units WHERE id = ?").get(t.unit_id) as Row | undefined) : undefined;
    return {
      id: t.id,
      courseId: t.course_id,
      title: t.title,
      summary: t.summary,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      sections,
      ...(unit ? { unit: { id: unit.id as string, title: unit.title as string } } : {}),
    };
  }

  /** One raw capture, for the "from Oct 14, 2:14 PM" links in notes. */
  getChunk(id: string): ChunkRow | null {
    const r = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Row | undefined;
    return r ? toChunk(r) : null;
  }

  /** Deletes a topic's notes. The captures they were written from stay. */
  deleteTopic(id: string) {
    this.db.prepare("DELETE FROM topics WHERE id = ?").run(id); // its sections cascade
    this.removeEmptyTopics(); // and a unit the AI made, if it's now empty
  }

  /** Topics left without any sections (their sessions or passages were deleted) are removed. */
  private removeEmptyTopics() {
    this.db.exec("DELETE FROM topics WHERE id NOT IN (SELECT topic_id FROM note_sections)");
    // Units the AI made that have nothing left in them go too (ones you named stay).
    this.db.exec("DELETE FROM units WHERE renamed = 0 AND id NOT IN (SELECT unit_id FROM topics WHERE unit_id IS NOT NULL)");
  }

  // ---------- units (a course's topics under general headings) ----------

  /** A course's units in order, and its topics with the unit each is in (null = not sorted yet). */
  courseNotes(courseId: string): {
    units: { id: string; title: string; renamed: boolean }[];
    topics: { id: string; title: string; summary: string; sections: number; updatedAt: string; unitId: string | null; locked: boolean }[];
  } {
    const units = (this.db.prepare("SELECT id, title, renamed FROM units WHERE course_id = ? ORDER BY position").all(courseId) as Row[]).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      renamed: !!r.renamed,
    }));
    const topics = (this.db
      .prepare(
        `SELECT t.id, t.title, t.summary, t.updated_at, t.unit_id, t.unit_locked, COUNT(n.seq) AS sections
         FROM topics t LEFT JOIN note_sections n ON n.topic_id = t.id WHERE t.course_id = ?
         GROUP BY t.id ORDER BY COALESCE(t.unit_pos, 1e9), t.created_at`,
      )
      .all(courseId) as Row[]).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      summary: r.summary as string,
      sections: r.sections as number,
      updatedAt: r.updated_at as string,
      unitId: (r.unit_id as string | null) ?? null,
      locked: !!r.unit_locked,
    }));
    return { units, topics };
  }

  /** Courses with topics the AI may still sort into units (not in a unit, and not placed by you). */
  coursesWithUnsortedTopics(): string[] {
    return (this.db.prepare("SELECT DISTINCT course_id FROM topics WHERE unit_id IS NULL AND unit_locked = 0").all() as Row[]).map((r) => r.course_id);
  }

  /** A new unit at the end of the course's list. */
  createUnit(courseId: string, title: string, key: string, renamed = false): string {
    const id = randomUUID();
    const pos = ((this.db.prepare("SELECT MAX(position) AS p FROM units WHERE course_id = ?").get(courseId) as Row).p ?? -1) + 1;
    this.db
      .prepare("INSERT INTO units (id, course_id, title, key, position, renamed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, courseId, title, key, pos, renamed ? 1 : 0, new Date().toISOString());
    return id;
  }

  renameUnit(unitId: string, title: string, key: string) {
    this.db.prepare("UPDATE units SET title = ?, key = ?, renamed = 1 WHERE id = ?").run(title, key, unitId);
  }

  /** Removes a unit; its topics (if any) go back to "not sorted" without being re-sorted by the AI. */
  deleteUnit(unitId: string) {
    this.db.prepare("UPDATE topics SET unit_id = NULL, unit_pos = NULL, unit_locked = 1 WHERE unit_id = ?").run(unitId);
    this.db.prepare("DELETE FROM units WHERE id = ?").run(unitId);
  }

  /**
   * Puts a topic in a unit (null = "Other topics"), before `beforeTopicId` or at the end. `byYou` locks it
   * there, so the AI never moves it again. A topic only moves within its own course.
   */
  placeTopic(topicId: string, unitId: string | null, opts: { byYou: boolean; beforeTopicId?: string }) {
    const t = this.db.prepare("SELECT course_id, unit_id, unit_locked FROM topics WHERE id = ?").get(topicId) as Row | undefined;
    if (!t) return;
    // The AI only places topics that are still unsorted: never one you've placed, or moved meanwhile.
    if (!opts.byYou && (t.unit_locked || t.unit_id)) return;
    if (unitId && !(this.db.prepare("SELECT 1 FROM units WHERE id = ? AND course_id = ?").get(unitId, t.course_id))) return;
    const order = (this.db
      .prepare(
        `SELECT id FROM topics WHERE course_id = ? AND id <> ? AND unit_id IS ? ORDER BY COALESCE(unit_pos, 1e9), created_at`,
      )
      .all(t.course_id, topicId, unitId) as Row[]).map((r) => r.id as string);
    const at = opts.beforeTopicId ? order.indexOf(opts.beforeTopicId) : -1;
    order.splice(at < 0 ? order.length : at, 0, topicId);
    const setPos = this.db.prepare("UPDATE topics SET unit_pos = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE topics SET unit_id = ?, unit_locked = CASE WHEN ? THEN 1 ELSE unit_locked END WHERE id = ?").run(unitId, opts.byYou ? 1 : 0, topicId);
      order.forEach((id, i) => setPos.run(i, id));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The apps a course's notes were read from (fast mode only sends notes from study apps). */
  courseNoteApps(courseId: string): string[] {
    return (this.db
      .prepare(
        `SELECT DISTINCT c.source_app FROM note_sections n JOIN topics t ON t.id = n.topic_id JOIN chunks c ON c.id = n.chunk_id
         WHERE t.course_id = ?`,
      )
      .all(courseId) as Row[]).map((r) => r.source_app);
  }

  // ---------- cross-references between notes (cached) ----------

  /** Changes whenever any notes are added, changed or deleted (so cached cross-references are redone). */
  notesVersion(): string {
    const n = this.db.prepare("SELECT COUNT(*) AS c, MAX(seq) AS m FROM note_sections").get() as Row;
    const t = this.db.prepare("SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM topics").get() as Row;
    return `${n.c}:${n.m ?? 0}:${t.c}:${t.m ?? ""}`;
  }

  /** Every topic with its sections, for finding cross-references. */
  allNotes(): { id: string; courseId: string; title: string; summary: string; sections: { id: string; kind: string; title: string; body: string }[] }[] {
    const sections = new Map<string, { id: string; kind: string; title: string; body: string }[]>();
    for (const r of this.db.prepare("SELECT id, topic_id, kind, title, body FROM note_sections ORDER BY seq").all() as Row[]) {
      const list = sections.get(r.topic_id) ?? [];
      list.push({ id: r.id, kind: r.kind, title: r.title, body: r.body });
      sections.set(r.topic_id, list);
    }
    return (this.db.prepare("SELECT id, course_id, title, summary FROM topics ORDER BY created_at").all() as Row[]).map((r) => ({
      id: r.id,
      courseId: r.course_id,
      title: r.title,
      summary: r.summary,
      sections: sections.get(r.id) ?? [],
    }));
  }

  /** Cached cross-references, if they were worked out for this version of the notes. */
  cachedXrefs(version: string): Map<string, Record<string, { text: string; topicId: string; sectionId?: string }[]>> | null {
    const rows = this.db.prepare("SELECT topic_id, version, links FROM xref_cache").all() as Row[];
    const topics = (this.db.prepare("SELECT COUNT(*) AS c FROM topics").get() as Row).c as number;
    if (rows.length !== topics || rows.some((r) => r.version !== version)) return null;
    return new Map(rows.map((r) => [r.topic_id as string, JSON.parse(r.links)]));
  }

  saveXrefs(version: string, xrefs: Map<string, Record<string, { text: string; topicId: string; sectionId?: string }[]>>) {
    const insert = this.db.prepare("INSERT INTO xref_cache (topic_id, version, links) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM xref_cache");
      for (const [topicId, links] of xrefs) insert.run(topicId, version, JSON.stringify(links));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- Stage 3: summary and quiz ----------

  /** The session's text passages, in order, for the AI. */
  getPassages(sessionId: string): Passage[] {
    return this.db
      .prepare("SELECT id, text, source_title AS sourceTitle, source_app AS sourceApp FROM chunks WHERE session_id = ? ORDER BY captured_at, rowid")
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
  saveQuiz(sessionId: string, courseId: string, questions: QuizDraft[], cloud = false) {
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
    this.db.prepare("UPDATE sessions SET quiz_total = ?, quiz_correct = 0, quiz_note = NULL, quiz_cloud = ? WHERE id = ?").run(questions.length, cloud ? 1 : null, sessionId);
    this.db.exec("COMMIT");
  }

  saveQuizNote(sessionId: string, note: string) {
    this.db.prepare("UPDATE sessions SET quiz_note = ? WHERE id = ?").run(note, sessionId);
  }

  getQuizNote(sessionId: string): string | null {
    return ((this.db.prepare("SELECT quiz_note FROM sessions WHERE id = ?").get(sessionId) as Row | undefined)?.quiz_note) ?? null;
  }

  /** The quiz was written by the cloud model. */
  quizCloud(sessionId: string): boolean {
    return !!(this.db.prepare("SELECT quiz_cloud FROM sessions WHERE id = ?").get(sessionId) as Row | undefined)?.quiz_cloud;
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

  addAnswer(questionId: string, level: string, text: string, cloud = false) {
    const r = this.db.prepare("SELECT answers FROM questions WHERE id = ?").get(questionId) as Row | undefined;
    if (!r) return;
    const answers = [...JSON.parse(r.answers), { level, text, at: new Date().toISOString(), ...(cloud ? { cloud: true } : {}) }];
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
        `SELECT c.id, c.text, c.source_title, c.source_app, c.session_id, c.embedding, s.started_at FROM chunks c JOIN sessions s ON s.id = c.session_id
         WHERE c.course_id = ? AND (? IS NULL OR c.session_id <> ?) ORDER BY c.captured_at`,
      )
      .all(courseId, excludeSessionId ?? null, excludeSessionId ?? null) as Row[]).map((r) => ({
      id: r.id,
      text: r.text,
      sourceTitle: r.source_title,
      sourceApp: r.source_app,
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
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId); // chunks, quiz, questions, note sections cascade
    this.removeOrphanConcepts();
    this.removeEmptyTopics();
    this.db.exec("COMMIT");
  }

  /** Deletes every session of a course and its learner model. */
  deleteCourseData(courseId: string) {
    this.db.exec("BEGIN");
    const ids = (this.db.prepare("SELECT id FROM sessions WHERE course_id = ?").all(courseId) as Row[]).map((r) => r.id);
    for (const id of ids) this.db.prepare("DELETE FROM evidence WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE course_id = ?").run(courseId);
    this.db.prepare("DELETE FROM concepts WHERE course_id = ?").run(courseId);
    this.removeEmptyTopics();
    this.db.prepare("DELETE FROM units WHERE course_id = ? AND id NOT IN (SELECT unit_id FROM topics WHERE unit_id IS NOT NULL)").run(courseId);
    this.db.exec("COMMIT");
  }

  private removeOrphanConcepts() {
    this.db.exec(`DELETE FROM concepts WHERE id NOT IN (SELECT concept_id FROM concept_chunks)
                  AND id NOT IN (SELECT concept_id FROM evidence)`);
  }

  /** Removes one passage (the user chose to; e.g. a page they didn't mean to study). */
  deleteChunk(id: string) {
    this.db.prepare("DELETE FROM chunks WHERE id = ?").run(id); // its note sections go too
    this.removeEmptyTopics();
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

  // ---------- Study Buddy ----------

  addBuddyChat(c: { sessionId: string; courseId: string; conceptId?: string; topic: string; character: string; buddyName: string; turns: BuddyTurn[] }): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO buddy_chats (id, session_id, course_id, concept_id, topic, character, buddy_name, started_at, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, c.sessionId, c.courseId, c.conceptId ?? null, c.topic.slice(0, 200), c.character, c.buddyName.slice(0, 40), new Date().toISOString(), JSON.stringify(c.turns));
    return id;
  }

  updateBuddyChat(id: string, u: { turns: BuddyTurn[]; outcome?: BuddyChatView["outcome"]; conceptId?: string }) {
    this.db
      .prepare("UPDATE buddy_chats SET turns = ?, outcome = COALESCE(?, outcome), concept_id = COALESCE(?, concept_id) WHERE id = ?")
      .run(JSON.stringify(u.turns), u.outcome ?? null, u.conceptId ?? null, id);
  }

  /** A session's buddy chats, oldest first, without the AI's verdicts. */
  buddyChats(sessionId: string): BuddyChatView[] {
    return (this.db.prepare("SELECT * FROM buddy_chats WHERE session_id = ? ORDER BY started_at").all(sessionId) as Row[]).map((r) => ({
      id: r.id,
      topic: r.topic,
      character: r.character,
      buddyName: r.buddy_name,
      startedAt: r.started_at,
      turns: (JSON.parse(r.turns) as BuddyTurn[]).filter((t) => t.text).map(({ who, text, at, cloud }) => ({ who, text, at, ...(cloud ? { cloud } : {}) })),
      outcome: r.outcome ?? null,
    }));
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

// The local SQLite database (Node's built-in node:sqlite, which Electron includes).
// Lives in the app's data folder: ~/Library/Application Support/Study Buddy/study-buddy.db
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChunkRow, SessionDetail, SessionRow } from "../shared/types.ts";
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
    return { ...toSession(s), chunks: chunks.map(toChunk) };
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
    summary: r.summary ?? undefined,
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

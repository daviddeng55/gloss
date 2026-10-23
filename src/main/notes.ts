// Writes class notes in the background: after each session (once its summary and quiz are done), and
// for older sessions that don't have notes yet. One session at a time; waits while you're recording.
import { AiError, DEFAULT_AI, tooThin, tracked } from "../core/ai.ts";
import type { StudyDb } from "../core/db.ts";
import { planTopics, topicKey, writeNotes } from "../core/notes.ts";
import type { Course } from "../shared/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Deps = {
  db: StudyDb;
  courses: () => Course[];
  model: () => string;
  /** Fast mode is on and text from all these apps may go to the cloud. */
  cloudOk?: (apps: string[]) => boolean;
  changed: () => void; // tell the windows to refresh
  isRecording: () => boolean;
  reviewsIdle: () => Promise<void>;
};

export class NotesService {
  private running = false;
  private current: string | null = null; // session being written now
  private deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** True while notes are being written. */
  writing(): boolean {
    return this.current !== null;
  }

  /** Writes notes for every ended session that doesn't have them yet (no-op if already running). */
  start() {
    if (!this.running) void this.loop();
  }

  private async loop() {
    this.running = true;
    try {
      for (;;) {
        await this.deps.reviewsIdle(); // summaries and quizzes come first
        while (this.deps.isRecording()) await sleep(20_000); // don't compete with a live session
        const next = this.deps.db.sessionsNeedingNotes()[0];
        if (!next) break;
        this.current = next.id;
        this.deps.changed();
        try {
          await this.write(next.id, next.courseId);
        } catch (err) {
          // Ollama off or model missing: stop and try again next time (nothing is marked as failed).
          if (err instanceof AiError && (err.code === "not-running" || err.code === "model-missing")) {
            console.log(`[notes] paused: ${err.message}`);
            break;
          }
          console.log(`[notes] couldn't write notes for ${next.id}: ${(err as Error).message}`);
          this.deps.db.setNotesStatus(next.id, "error", (err as Error).message);
        } finally {
          this.current = null;
          this.deps.changed();
        }
      }
    } finally {
      this.running = false;
      this.current = null;
      this.deps.changed();
    }
  }

  /** Sorts a session's passages into topics and adds the notes for each (merging into existing topics). */
  async write(sessionId: string, courseId: string): Promise<{ topics: string[]; sections: number }> {
    const { db } = this.deps;
    const passages = db.getPassages(sessionId);
    const thin = tooThin(passages);
    if (thin) {
      db.setNotesStatus(sessionId, "skipped", thin);
      return { topics: [], sections: 0 };
    }
    const cfg = { ...DEFAULT_AI, model: this.deps.model(), cloud: this.deps.cloudOk?.(passages.map((p) => p.sourceApp ?? "")) ?? false };
    const courses = this.deps.courses();
    const plans = await planTopics(passages, courses, courseId, db.topicTitles(), cfg);
    const done = { topics: [] as string[], sections: 0 };
    for (const plan of plans) {
      const key = topicKey(plan.title);
      const existing = db.topicForMerge(plan.courseId, key);
      const subset = passages.filter((p) => plan.passageIds.includes(p.id));
      const courseName = courses.find((c) => c.id === plan.courseId)?.name ?? plan.courseId;
      const { value: notes, cloud } = await tracked(() =>
        writeNotes(plan.title, courseName, subset, existing ?? { summary: "", sectionTitles: [] }, cfg, {
          otherTopics: plans.map((p) => p.title),
          courseTitles: db.courseSectionTitles(plan.courseId),
        }),
      );
      if (!notes.sections.length) continue;
      db.saveTopicNotes({ courseId: plan.courseId, title: plan.title, key, summary: notes.summary, sessionId, sections: notes.sections, cloud });
      done.topics.push(plan.title);
      done.sections += notes.sections.length;
      this.deps.changed(); // the topic shows up while the rest is still being written
    }
    db.setNotesStatus(sessionId, done.sections ? "done" : "skipped", done.sections ? undefined : "No study material found for notes.");
    return done;
  }
}

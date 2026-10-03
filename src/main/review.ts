// End-of-session review: generates the summary and quiz in the background (one session at a time,
// so the laptop only runs one AI job at once), saves them, and marks answers.
import { AiError, checkAi, checkAnswer, makeQuiz, summarizeSession, verifyQuestions } from "../core/ai.ts";
import type { StudyDb } from "../core/db.ts";
import type { AnswerResult, Course, ReviewData, TaskStatus } from "../shared/types.ts";

type Progress = { summary: TaskStatus; summaryError?: string; quiz: TaskStatus; quizError?: string };

const errorText = (err: unknown) =>
  err instanceof AiError ? err.message : `Something went wrong: ${(err as Error).message}`;

export class ReviewService {
  private progress = new Map<string, Progress>();
  private queue: Promise<void> = Promise.resolve();
  private db: StudyDb;
  private courses: () => Course[];
  private changed: (sessionId: string) => void;

  constructor(db: StudyDb, courses: () => Course[], changed: (sessionId: string) => void) {
    this.db = db;
    this.courses = courses;
    this.changed = changed;
  }

  private courseName(courseId: string) {
    return this.courses().find((c) => c.id === courseId)?.name ?? courseId;
  }

  private status(sessionId: string): Progress {
    const p = this.progress.get(sessionId) ?? { summary: "waiting", quiz: "waiting" };
    // Anything already saved is done, whatever happened before.
    if (this.db.getSummary(sessionId)) p.summary = "done";
    if (this.db.hasQuiz(sessionId) || this.db.getQuizNote(sessionId)) p.quiz = "done";
    return p;
  }

  private set(sessionId: string, patch: Partial<Progress>) {
    this.progress.set(sessionId, { ...this.status(sessionId), ...patch });
    this.changed(sessionId);
  }

  /** Starts making whatever is missing for this session (summary, then quiz). */
  ensure(sessionId: string) {
    const p = this.status(sessionId);
    const busy = [p.summary, p.quiz].includes("working");
    const missing = p.summary === "waiting" || p.quiz === "waiting";
    if (busy || !missing) return;
    this.queue = this.queue.then(() => this.generate(sessionId)).catch(() => {});
  }

  /** "Try again" after an error. */
  retry(sessionId: string) {
    const p = this.status(sessionId);
    this.progress.set(sessionId, {
      summary: p.summary === "error" ? "waiting" : p.summary,
      quiz: p.quiz === "error" ? "waiting" : p.quiz,
    });
    this.ensure(sessionId);
    this.changed(sessionId);
  }

  private async generate(sessionId: string) {
    const session = this.db.getSession(sessionId);
    if (!session) return;
    const ai = await checkAi();
    if (!ai.ok) {
      const p = this.status(sessionId);
      this.set(sessionId, {
        ...(p.summary !== "done" && { summary: "error", summaryError: ai.error.message }),
        ...(p.quiz !== "done" && { quiz: "error", quizError: ai.error.message }),
      });
      return;
    }
    const passages = this.db.getPassages(sessionId);
    const course = this.courseName(session.courseId);

    if (this.status(sessionId).summary === "waiting") {
      this.set(sessionId, { summary: "working" });
      try {
        this.db.saveSummary(sessionId, await summarizeSession(passages, course, session.goal));
        this.set(sessionId, { summary: "done" });
      } catch (err) {
        this.set(sessionId, { summary: "error", summaryError: errorText(err) });
      }
    }

    if (this.status(sessionId).quiz === "waiting") {
      this.set(sessionId, { quiz: "working" });
      try {
        const quiz = await makeQuiz(passages, course);
        if (!quiz.ok) {
          this.db.saveQuizNote(sessionId, quiz.reason);
        } else {
          // Drop any question the model can't back up from its passage.
          const { kept, dropped } = await verifyQuestions(quiz.questions, passages);
          console.log(`[review] quiz: ${quiz.questions.length} written, ${dropped.length} dropped by checking`);
          if (kept.length < 3) {
            this.db.saveQuizNote(sessionId, "The AI couldn't write enough questions that it could check against your notes.");
          } else {
            this.db.saveQuiz(sessionId, session.courseId, kept);
          }
        }
        this.set(sessionId, { quiz: "done" });
      } catch (err) {
        this.set(sessionId, { quiz: "error", quizError: errorText(err) });
      }
    }
  }

  get(sessionId: string): ReviewData | null {
    const s = this.db.getSession(sessionId);
    if (!s) return null;
    const p = this.status(sessionId);
    return {
      sessionId,
      courseName: this.courseName(s.courseId),
      goal: s.goal,
      startedAt: s.startedAt,
      activeMs: s.activeMs,
      summary: { status: p.summary, data: this.db.getSummary(sessionId) ?? undefined, error: p.summaryError },
      quiz: {
        status: p.quiz,
        items: this.db.getQuiz(sessionId),
        note: this.db.getQuizNote(sessionId) ?? undefined,
        error: p.quizError,
      },
      passages: Object.fromEntries(
        s.chunks.map((c) => [c.id, { text: c.text, sourceTitle: c.sourceTitle, capturedAt: c.capturedAt }]),
      ),
    };
  }

  /** Multiple choice is checked directly; short answers are checked by the AI against the source passage. */
  async answer(itemId: string, response: string): Promise<AnswerResult> {
    const item = this.db.getQuizItem(itemId);
    if (!item) throw new Error("Question not found");
    let result: AnswerResult;
    if (item.type === "multiple_choice") {
      result = { correct: response === item.answer, answer: item.answer, explanation: "" };
    } else {
      const passage = item.chunkId ? this.db.getChunkText(item.chunkId) : "";
      const m = await checkAnswer(item, passage, response);
      result = { correct: m.correct, answer: item.answer, explanation: m.explanation };
    }
    this.db.recordAnswer(itemId, { ...result, response, at: new Date().toISOString() });
    this.changed(item.sessionId);
    return result;
  }
}

// End-of-session review: generates the summary and quiz in the background (one session at a time,
// so the laptop only runs one AI job at once), saves them, and marks answers.
import { AiError, checkAi, checkAnswer, DEFAULT_AI, makeQuiz, summarizeSession, verifyQuestions, type AiConfig, type QuizDraft } from "../core/ai.ts";
import type { StudyDb } from "../core/db.ts";
import { reviewIntervalDays } from "../core/learner.ts";
import type { AnswerResult, Course, ReviewData, TaskStatus } from "../shared/types.ts";
import type { LearnerService } from "./learner.ts";

type Progress = { summary: TaskStatus; summaryError?: string; quiz: TaskStatus; quizError?: string };

const errorText = (err: unknown) =>
  err instanceof AiError ? err.message : `Something went wrong: ${(err as Error).message}`;

export class ReviewService {
  private progress = new Map<string, Progress>();
  private saving = new Map<string, Promise<void>>(); // sessions whose text is still being saved
  private queue: Promise<void> = Promise.resolve();
  private db: StudyDb;
  private courses: () => Course[];
  private changed: (sessionId: string) => void;
  private learner: LearnerService;

  private reviewModel: () => string;

  constructor(
    db: StudyDb,
    courses: () => Course[],
    learner: LearnerService,
    changed: (sessionId: string) => void,
    reviewModel: () => string = () => DEFAULT_AI.model,
  ) {
    this.reviewModel = reviewModel;
    this.learner = learner;
    this.db = db;
    this.courses = courses;
    this.changed = changed;
  }

  /** The model chosen in Settings for summaries, quizzes and marking. */
  private model(): AiConfig {
    return { ...DEFAULT_AI, model: this.reviewModel() };
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

  /**
   * Starts making whatever is missing for this session (summary, then quiz). `saved`: the session is
   * still finishing (math re-reads); wait for it before reading its text.
   */
  ensure(sessionId: string, saved?: Promise<void>) {
    if (saved) {
      this.saving.set(sessionId, saved);
      void saved.finally(() => {
        this.saving.delete(sessionId);
        this.changed(sessionId);
      });
    }
    const p = this.status(sessionId);
    const busy = [p.summary, p.quiz].includes("working");
    const missing = p.summary === "waiting" || p.quiz === "waiting";
    if (busy || !missing) return;
    this.queue = this.queue.then(() => this.generate(sessionId)).catch(() => {});
  }

  /** Resolves when no summary or quiz is being made (so background work doesn't compete with it). */
  whenIdle(): Promise<void> {
    return this.queue;
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

  /** Forget progress after the summary and quiz were cleared (to make them again). */
  forget(sessionId: string) {
    this.progress.delete(sessionId);
  }

  private async generate(sessionId: string) {
    await this.saving.get(sessionId)?.catch(() => {});
    const session = this.db.getSession(sessionId);
    if (!session) return;
    const ai = await checkAi(this.model());
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
        // Reuse concept names from earlier sessions so the learner model adds up over time.
        const summary = await summarizeSession(passages, course, session.goal, this.model(), this.learner.knownConceptNames(session.courseId));
        this.db.saveSummary(sessionId, summary);
        this.learner.recordSessionConcepts(sessionId, session.courseId, summary);
        this.set(sessionId, { summary: "done" });
      } catch (err) {
        this.set(sessionId, { summary: "error", summaryError: errorText(err) });
      }
    }

    if (this.status(sessionId).quiz === "waiting") {
      this.set(sessionId, { quiz: "working" });
      try {
        // Topics the student asked about are more likely to be quizzed.
        const askedQuestions = this.db.getQuestions(sessionId).map((q) => q.question);
        // Aim at your weakest concepts in this session, pitched to how well you know each.
        const concepts = this.learner.quizConcepts(sessionId);
        // Write, then check: drop any question the model can't back up from your notes. If too few
        // survive, try once more and keep the good ones from both rounds.
        const kept: QuizDraft[] = [];
        let reason = "";
        for (let attempt = 0; attempt < 2 && kept.length < 5; attempt++) {
          const quiz = await makeQuiz(passages, course, this.model(), { askedQuestions, concepts });
          if (!quiz.ok) {
            reason = quiz.reason;
            break;
          }
          const fresh = quiz.questions.filter((q) => !kept.some((k) => k.question === q.question));
          const checked = await verifyQuestions(fresh, passages, this.model());
          kept.push(...checked.kept);
          console.log(`[review] quiz round ${attempt + 1}: ${fresh.length} written, ${checked.dropped.length} dropped by checking`);
        }
        this.learner.tagQuestions(sessionId, kept);
        if (kept.length < 3) {
          this.db.saveQuizNote(sessionId, reason || "The AI couldn't write enough questions that it could check against your notes.");
        } else {
          this.db.saveQuiz(sessionId, session.courseId, kept.slice(0, 8));
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
      finishing: this.saving.has(sessionId),
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
      connections: this.learner.connections(sessionId, s.courseId),
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
      const m = await checkAnswer(item, passage, response, this.model());
      result = { correct: m.correct, answer: item.answer, explanation: m.explanation };
    }
    // The answer is evidence for the learner model, and sets when the question comes back.
    const meta = this.db.quizItemConcept(itemId);
    let intervalDays: number | undefined;
    if (meta?.conceptId) {
      this.learner.recordQuizAnswer(meta.conceptId, result.correct, meta.sessionId, itemId);
      intervalDays = reviewIntervalDays(result.correct, meta.intervalDays, this.learner.conceptState(meta.conceptId)?.current);
    }
    this.db.recordAnswer(itemId, { ...result, response, at: new Date().toISOString(), intervalDays });
    this.changed(item.sessionId);
    return result;
  }
}

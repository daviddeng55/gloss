// Stage 5 — the learner model at work: turns what happens in sessions into evidence, and uses it to
// adapt answers, quizzes, warm-ups and connections. The rules themselves live in core/learner.ts.
import { embed, embeddingsAvailable, type Summary } from "../core/ai.ts";
import type { StudyDb } from "../core/db.ts";
import { chooseHintLevel, conceptState, type ConceptState, type HintLevelName } from "../core/learner.ts";
import { matchConcept, searchPassages, words, type MemoryPassage } from "../core/memory.ts";
import type { Connection, Course, HelpCounts, LearnProfile, WarmupData } from "../shared/types.ts";

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export class LearnerService {
  private db: StudyDb;
  private courses: () => Course[];
  private hasEmbeddings: boolean | null = null; // checked lazily

  constructor(db: StudyDb, courses: () => Course[]) {
    this.db = db;
    this.courses = courses;
  }

  private async embeddingsOn(): Promise<boolean> {
    if (this.hasEmbeddings === null) this.hasEmbeddings = await embeddingsAvailable();
    return this.hasEmbeddings;
  }

  /** Re-check (e.g. after the embedding model is downloaded). */
  refreshEmbeddings() {
    this.hasEmbeddings = null;
  }

  private states(courseId?: string) {
    return this.db.getConcepts(courseId).map((c) => ({ ...c, state: conceptState(c.evidence) }));
  }

  knownConceptNames(courseId: string): string[] {
    return this.db.getConcepts(courseId).map((c) => c.name);
  }

  /** After the summary: the concepts it named are recorded as covered and linked to their passages. */
  recordSessionConcepts(sessionId: string, courseId: string, summary: Summary) {
    if (!summary.ok) return;
    const at = new Date().toISOString();
    for (const point of summary.points) {
      if (!point.concept) continue;
      const conceptId = this.db.upsertConcept(courseId, point.concept);
      for (const chunkId of point.passageIds) this.db.linkConcept(conceptId, chunkId, sessionId);
      if (!this.db.hasCoveredEvidence(conceptId, sessionId)) this.db.addEvidence(conceptId, { at, kind: "covered", sessionId });
    }
  }

  /**
   * Makes sure every quiz question is tied to a concept (so answering it counts as evidence): if the
   * AI didn't say which, use the concept its source passage was linked to, breaking ties by wording.
   */
  tagQuestions(sessionId: string, questions: { question: string; passageId: string; conceptId?: string }[]) {
    const links = this.db.sessionConcepts(sessionId);
    const names = new Map(this.db.getConcepts().map((c) => [c.id, c.name]));
    for (const q of questions) {
      if (q.conceptId) continue;
      const candidates = links.filter((l) => l.chunkIds.includes(q.passageId)).map((l) => l.conceptId);
      const pool = candidates.length ? candidates : links.map((l) => l.conceptId);
      if (!pool.length) continue;
      const qWords = new Set(words(q.question));
      const score = (id: string) => words(names.get(id) ?? "").filter((w) => qWords.has(w)).length;
      const best = [...pool].sort((a, b) => score(b) - score(a))[0];
      if (candidates.length || score(best) > 0) q.conceptId = best;
    }
  }

  /** This session's concepts with current mastery, for aiming the quiz. */
  quizConcepts(sessionId: string): { id: string; name: string; mastery: number }[] {
    const ids = new Set(this.db.sessionConcepts(sessionId).map((c) => c.conceptId));
    return this.states()
      .filter((c) => ids.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, mastery: c.state.current }));
  }

  conceptState(conceptId: string): ConceptState | undefined {
    const c = this.db.getConcepts().find((x) => x.id === conceptId);
    return c ? conceptState(c.evidence) : undefined;
  }

  overallHelps(): HelpCounts {
    const total: HelpCounts = { nudge: 0, explain: 0, example: 0 };
    for (const c of this.states()) for (const k of ["nudge", "explain", "example"] as const) total[k] += c.state.helps[k];
    return total;
  }

  /** A quiz answer is evidence; returns how many days until the question comes back. */
  recordQuizAnswer(conceptId: string | undefined, correct: boolean, sessionId: string, itemId: string): number | undefined {
    if (!conceptId) return undefined;
    this.db.addEvidence(conceptId, { at: new Date().toISOString(), kind: "quiz", correct, sessionId, refId: itemId });
    return undefined;
  }

  /** Which known concept a question is about (by meaning if the embedding model is there). */
  async conceptForQuestion(courseId: string, question: string): Promise<{ id: string; name: string } | null> {
    const concepts = this.db.conceptEmbeddings(courseId);
    if (!concepts.length) return null;
    let qEmb: number[] | undefined;
    if (await this.embeddingsOn()) qEmb = (await embed([question], "query").catch(() => [undefined]))[0];
    // Notes that match the question vote for the concepts they're linked to.
    const top = searchPassages(question, this.db.coursePassages(courseId), { queryEmbedding: qEmb, limit: 2 });
    const boost = new Map(this.db.conceptsForChunks(top.map((p) => p.id)).map((id) => [id, 0.08]));
    const id = matchConcept(question, concepts, qEmb, boost);
    return id ? { id, name: concepts.find((c) => c.id === id)!.name } : null;
  }

  /** Where to start an answer: what's helped you before, or a different approach if you're asking again. */
  startLevel(sessionId: string, conceptId: string | null): { level: HintLevelName; reason: string } {
    const lastLevelThisSession = conceptId ? this.db.askedThisSession(sessionId).get(conceptId) : undefined;
    return chooseHintLevel({
      concept: conceptId ? this.conceptState(conceptId) : undefined,
      overall: this.overallHelps(),
      lastLevelThisSession,
    });
  }

  recordAsk(sessionId: string, questionId: string, conceptId: string, level: HintLevelName, isNewQuestion: boolean) {
    if (isNewQuestion) {
      this.db.setQuestionConcept(questionId, conceptId);
      this.db.addEvidence(conceptId, { at: new Date().toISOString(), kind: "ask", hintLevel: level, sessionId, refId: questionId });
    } else {
      this.db.raiseAskLevel(questionId, level);
    }
  }

  /** A short note for the AI about this student and concept (kept factual). */
  learnerNote(conceptId: string | null, connections: Connection[]): string {
    const parts: string[] = [];
    if (conceptId) {
      const st = this.conceptState(conceptId);
      const name = this.db.getConcepts().find((c) => c.id === conceptId)?.name;
      if (st && name) {
        parts.push(`This is about "${name}"; their current mastery is about ${Math.round(st.current * 100)}%${st.confidence < 0.3 ? " (little evidence yet)" : ""}.`);
        if (st.quizzes.wrong > st.quizzes.right) parts.push("They've got quiz questions on it wrong before, so check the basics.");
      }
    }
    const weak = connections.filter((c) => c.conceptId !== conceptId).slice(0, 2);
    if (weak.length) parts.push(`They find these related topics hard: ${weak.map((c) => `"${c.name}"`).join(", ")}; if the question depends on them, briefly recap.`);
    return parts.join(" ");
  }

  /** Passages for answering: this session's plus related ones from earlier sessions of the course. */
  async passagesFor(courseId: string, sessionId: string, question: string): Promise<(MemoryPassage & { when: string })[]> {
    const all = this.db.coursePassages(courseId);
    let qEmb: number[] | undefined;
    if ((await this.embeddingsOn()) && all.some((p) => p.embedding)) qEmb = (await embed([question], "query").catch(() => [undefined]))[0];
    const today = searchPassages(question, all.filter((p) => p.sessionId === sessionId), { queryEmbedding: qEmb, limit: 3 });
    const earlier = searchPassages(question, all.filter((p) => p.sessionId !== sessionId), { queryEmbedding: qEmb, limit: 2 });
    let chars = 0;
    return [...today, ...earlier]
      .filter((p) => (chars += p.text.length) <= 4500)
      .map((p) => ({ ...p, when: p.sessionId === sessionId ? "today" : dateFmt.format(new Date(p.startedAt)) }));
  }

  /**
   * Earlier concepts you've found hard that today's material builds on: their names appear in today's
   * text, they weren't studied today, and their mastery is low.
   */
  connections(sessionId: string, courseId: string): Connection[] {
    const todayIds = new Set(this.db.sessionConcepts(sessionId).map((c) => c.conceptId));
    const text = this.db.getPassages(sessionId).map((p) => p.text).join(" ").toLowerCase();
    const textWords = new Set(words(text));
    const out: Connection[] = [];
    for (const c of this.states(courseId)) {
      if (todayIds.has(c.id) || c.state.current >= 0.5 || c.state.confidence < 0.3) continue;
      const w = words(c.name);
      if (!w.length || !w.every((x) => textWords.has(x))) continue;
      const lastStudied = c.evidence.filter((e) => e.kind === "covered").at(-1)?.at ?? c.createdAt;
      out.push({ conceptId: c.id, name: c.name, current: c.state.current, lastStudied });
    }
    return out.sort((a, b) => a.current - b.current).slice(0, 3);
  }

  /** Up to 3 questions due for review in this course: ones you got wrong first. */
  warmup(sessionId: string, courseId: string): WarmupData | null {
    const ids = this.db.dueQuizItems(courseId, new Date().toISOString(), 3);
    if (!ids.length) return null;
    const items = this.db.getQuizItemsByIds(ids);
    const passages: WarmupData["passages"] = {};
    for (const it of items) {
      if (!it.chunkId) continue;
      const text = this.db.getChunkText(it.chunkId);
      if (text) passages[it.chunkId] = { text, sourceTitle: "", capturedAt: new Date().toISOString() };
    }
    return { sessionId, courseName: this.courses().find((c) => c.id === courseId)?.name ?? courseId, items, passages };
  }

  async profile(): Promise<LearnProfile> {
    const courses = this.courses();
    const all = this.states();
    return {
      overall: this.overallHelps(),
      memoryByMeaning: await this.embeddingsOn(),
      courses: courses
        .map((course) => ({
          courseId: course.id,
          courseName: course.name,
          concepts: all
            .filter((c) => c.courseId === course.id)
            .map((c) => {
              const manual = c.evidence.filter((e) => e.kind === "manual").at(-1);
              return {
                id: c.id,
                courseId: c.courseId,
                name: c.name,
                current: c.state.current,
                confidence: c.state.confidence,
                lastPracticedAt: c.state.lastPracticedAt,
                helps: c.state.helps,
                quizzes: c.state.quizzes,
                asks: c.state.asks,
                why: c.state.why,
                override: manual ? (manual.correct ?? null) : null,
                sources: this.db.conceptSources(c.id).map(({ sessionId, startedAt, sourceTitle }) => ({ sessionId, startedAt, sourceTitle })).slice(0, 3),
              };
            })
            .sort((a, b) => a.current - b.current),
        }))
        .filter((c) => c.concepts.length),
    };
  }

  /** Gives every passage and concept an embedding (when the model is there), a few at a time. */
  async backfillEmbeddings(): Promise<number> {
    if (!(await this.embeddingsOn())) return 0;
    let done = 0;
    for (;;) {
      const batch = this.db.chunksWithoutEmbedding(16);
      if (!batch.length) break;
      const vectors = await embed(batch.map((c) => c.text));
      batch.forEach((c, i) => this.db.setChunkEmbedding(c.id, vectors[i]));
      done += batch.length;
    }
    for (const course of this.courses()) {
      const missing = this.db.conceptEmbeddings(course.id).filter((c) => !c.embedding);
      if (!missing.length) continue;
      const vectors = await embed(missing.map((c) => c.name));
      missing.forEach((c, i) => this.db.setConceptEmbedding(c.id, vectors[i]));
    }
    return done;
  }
}

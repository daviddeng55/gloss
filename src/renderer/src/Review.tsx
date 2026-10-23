// End-of-session review: what you covered, then a short quiz on it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerResult, BuddyChatView, QuizItemView, ReviewData } from "../../shared/types.ts";
import { BuddyFigure } from "./Buddy.tsx";
import { plainMathToLatex } from "../../shared/mathText.ts";
import { dateFmt, duration, timeFmt } from "./format.ts";
import CloudTag from "./CloudTag.tsx";
import Rich from "./Rich.tsx";

export default function Review({ sessionId, section }: { sessionId: string; section?: "summary" | "quiz" }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const load = useCallback(() => void window.api.getReview(sessionId).then(setData), [sessionId]);
  const loaded = !!data;

  // Opened from the popover's "Summary" or "Quiz" button: start at that part.
  useEffect(() => {
    if (loaded && section) document.getElementById(`review-${section}`)?.scrollIntoView({ block: "start" });
  }, [loaded, section]);

  useEffect(() => {
    load();
    return window.api.onReview((id) => id === sessionId && load());
  }, [load, sessionId]);

  if (!data) return <div className="drag h-12" />;

  return (
    <div className="flex h-screen flex-col text-[14px] text-ink">
      <div className="drag h-12 shrink-0" />
      <div className="flex-1 overflow-y-auto px-8 pb-16">
        <article className="appear mx-auto max-w-[680px]">
          <header className="mb-8">
            <p className="eyebrow">
              {data.courseName} · {dateFmt.format(new Date(data.startedAt))}, {timeFmt.format(new Date(data.startedAt))}
            </p>
            <h1 className="mt-2 font-serif text-[34px] leading-[1.15] font-semibold tracking-tight">
              {data.goal || `${data.courseName} session`}
            </h1>
            <p className="mt-2 text-muted">{duration(data.activeMs)} studied</p>
          </header>

          <section id="review-summary" className="mb-12 scroll-mt-4">
            <h2 className="mb-4 flex items-center gap-3 font-serif text-[21px] font-semibold">
              What you covered {data.summary.status === "done" && data.summary.data?.cloud ? <CloudTag /> : null}
            </h2>
            <SummaryView data={data} onRetry={() => void window.api.retryReview(sessionId)} />
          </section>

          {data.connections.length ? (
            <section className="mb-12">
              <h2 className="mb-4 font-serif text-[21px] font-semibold">Builds on</h2>
              <div className="card p-6">
                <p className="mb-3 text-muted">Today's material uses ideas you've found hard before:</p>
                <ul className="divide-y divide-line">
                  {data.connections.map((c) => (
                    <li key={c.conceptId} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="font-serif text-[17px]">{c.name}</span>
                      <span className="text-[13px] text-muted tabular-nums">
                        {Math.round(c.current * 100)}% · last studied {dateFmt.format(new Date(c.lastStudied))}
                      </span>
                    </li>
                  ))}
                </ul>
                <button onClick={() => void window.api.openLearn()} className="btn-secondary mt-4">
                  See how you learn
                </button>
              </div>
            </section>
          ) : null}

          {data.buddy.length ? (
            <section id="buddy" className="mb-12 scroll-mt-4">
              <h2 className="mb-4 font-serif text-[21px] font-semibold">Chats with your Study Buddy</h2>
              <div className="space-y-4">
                {data.buddy.map((c) => (
                  <BuddyChat key={c.id} chat={c} />
                ))}
              </div>
            </section>
          ) : null}

          <section id="review-quiz" className="min-h-[calc(100vh-7rem)] scroll-mt-4">
            <h2 className="mb-4 flex items-center gap-3 font-serif text-[21px] font-semibold">
              Quiz {data.quiz.status === "done" && data.quiz.cloud && data.quiz.items.length ? <CloudTag /> : null}
            </h2>
            <QuizView data={data} onRetry={() => void window.api.retryReview(sessionId)} reload={load} />
          </section>
        </article>
      </div>
    </div>
  );
}

/** One chat with the buddy: its questions and your answers (no grades). */
function BuddyChat({ chat }: { chat: BuddyChatView }) {
  const character = (["dog", "cat", "penguin", "birdie"] as const).find((c) => c === chat.character) ?? "dog";
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center gap-2">
        <BuddyFigure character={character} size={36} />
        <p className="eyebrow">
          {chat.buddyName} · {chat.topic} · {timeFmt.format(new Date(chat.startedAt))}
        </p>
        {chat.turns.some((t) => t.cloud) ? <CloudTag className="ml-auto" /> : null}
      </div>
      <ul className="space-y-2">
        {chat.turns.map((t, i) => (
          <li key={i} className={`flex ${t.who === "you" ? "justify-end" : ""}`}>
            <p
              className={`selectable max-w-[85%] rounded-2xl px-3.5 py-2 font-serif text-[15px] leading-snug ${
                t.who === "you" ? "rounded-br-md bg-accent-soft" : "rounded-bl-md bg-hover"
              }`}
            >
              {t.text}
            </p>
          </li>
        ))}
      </ul>
      {chat.outcome === "skipped" && chat.turns.length === 1 ? <p className="mt-2 text-[12px] text-muted">You skipped this one.</p> : null}
    </div>
  );
}

function Working({ children }: { children: React.ReactNode }) {
  return (
    <div className="card appear flex items-center gap-3 px-6 py-4 text-muted">
      <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function Problem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="appear flex items-center justify-between gap-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
      <p className="selectable leading-relaxed">{message}</p>
      {onRetry ? (
        <button onClick={onRetry} className="btn-secondary shrink-0">
          Try again
        </button>
      ) : null}
    </div>
  );
}

type Passages = ReviewData["passages"];

/** A passage's text, shown when you click a source link. */
export function Source({ passages, chunkId }: { passages: Passages; chunkId: string }) {
  const p = passages[chunkId];
  if (!p) return <p className="text-sm text-muted">That passage was deleted.</p>;
  return (
    <div className="appear mt-3 rounded-xl border border-line bg-paper px-4 py-3 text-[14px]">
      <p className="mb-2 truncate text-[12px] text-muted">
        {timeFmt.format(new Date(p.capturedAt))} · {p.sourceTitle || "unknown window"}
      </p>
      <Rich text={p.text} keepLines className="font-serif text-[15px]" />
    </div>
  );
}

function SummaryView({ data, onRetry }: { data: ReviewData; onRetry: () => void }) {
  const [open, setOpen] = useState<string | null>(null); // "point:chunk" whose source is showing
  const { status, data: summary, error } = data.summary;
  if (status === "error") return <Problem message={error ?? "Couldn't make a summary."} onRetry={onRetry} />;
  if (data.finishing) return <Working>Finishing reading your notes (re-reading the math)… this can take a couple of minutes.</Working>;
  if (status !== "done" || !summary) {
    // Points appear one by one as they're written.
    const partial = data.summary.partial ?? [];
    if (!partial.length) return <Working>Summarizing your session…</Working>;
    return (
      <div className="space-y-6">
        <ul className="space-y-6">
          {partial.map((text, i) => (
            <li key={i} className="appear flex gap-4">
              <span className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
              <Rich text={plainMathToLatex(text)} className="min-w-0 flex-1 font-serif text-[18px]" />
            </li>
          ))}
        </ul>
        <Working>Writing the rest…</Working>
      </div>
    );
  }
  if (!summary.ok) return <Problem message={summary.reason} />;
  return (
    <ul className="appear space-y-6">
      {summary.points.map((pt, i) => (
        <li key={i} className="flex gap-4">
          <span className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <Rich text={plainMathToLatex(pt.text)} className="font-serif text-[18px]" />
            {pt.passageIds.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {pt.passageIds.map((id, j) => {
                  const key = `${i}:${id}`;
                  return (
                    <button
                      key={id}
                      onClick={() => setOpen(open === key ? null : key)}
                      className={`chip ${open === key ? "bg-accent-soft! text-ink" : "text-muted hover:text-ink"}`}
                    >
                      Source{pt.passageIds.length > 1 ? ` ${j + 1}` : ""}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {open?.startsWith(`${i}:`) ? <Source passages={data.passages} chunkId={open.slice(open.indexOf(":") + 1)} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function QuizView({ data, onRetry, reload }: { data: ReviewData; onRetry: () => void; reload: () => void }) {
  const { status, items, note, error } = data.quiz;
  const firstUnanswered = items.findIndex((q) => !q.answered);
  const [index, setIndex] = useState<number | null>(null); // null = follow the first unanswered question
  const current = index ?? (firstUnanswered === -1 ? items.length : firstUnanswered);

  if (status === "error") return <Problem message={error ?? "Couldn't make a quiz."} onRetry={onRetry} />;
  if (status !== "done") {
    return (
      <Working>
        {data.summary.status !== "done"
          ? "Your quiz comes after the summary."
          : data.quiz.step === "checking"
            ? "Checking each question against your notes…"
            : "Writing your quiz…"}
      </Working>
    );
  }
  if (items.length === 0) return <Problem message={note ?? "No quiz for this session."} />;
  if (current >= items.length) return <Results items={items} />;

  return (
    <Question
      key={items[current].id}
      passages={data.passages}
      item={items[current]}
      number={current + 1}
      total={items.length}
      onAnswered={() => {
        setIndex(current); // stay on this question (showing right/wrong) until "Next"
        reload();
      }}
      onNext={() => setIndex(current + 1)}
    />
  );
}

export function Question(props: {
  passages: Passages;
  item: QuizItemView;
  number: number;
  total: number;
  onAnswered: () => void;
  onNext: () => void;
}) {
  const { passages, item, number, total } = props;
  const [response, setResponse] = useState(item.answered?.response ?? "");
  const [result, setResult] = useState<AnswerResult | null>(item.answered ?? null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  async function submit(answer: string) {
    if (checking || result || !answer.trim()) return;
    setResponse(answer);
    setChecking(true);
    setFailed(null);
    try {
      setResult(await window.api.answerQuestion(item.id, answer));
      props.onAnswered();
    } catch (err) {
      setFailed((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setChecking(false);
    }
  }

  const progress = ((number - 1 + (result ? 1 : 0)) / total) * 100;
  return (
    <div className="card appear p-6">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">
          Question {number} of {total}
        </p>
        <p className="text-[12px] text-muted">{item.type === "multiple_choice" ? "Multiple choice" : "Short answer"}</p>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={Math.round(progress)}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${progress}%` }} />
      </div>
      <Rich text={item.question} className="mt-6 mb-6 font-serif text-[23px] leading-snug" />

      {item.type === "multiple_choice" ? (
        <div className="flex flex-col gap-2">
          {item.options?.map((opt, i) => {
            const chosen = response === opt;
            const right = result && opt === result.answer;
            const wrong = result && chosen && !result.correct;
            return (
              <button
                key={opt}
                data-option
                disabled={!!result || checking}
                onClick={() => void submit(opt)}
                className={`group flex w-full items-center gap-4 rounded-xl border px-4 py-3 text-left transition-colors duration-150 ${
                  right
                    ? "border-good/60 bg-good/10"
                    : wrong
                      ? "border-bad/60 bg-bad/10"
                      : result
                        ? "border-line opacity-55"
                        : "border-line bg-card enabled:hover:border-accent/40 enabled:hover:bg-accent-soft/50"
                }`}
              >
                <span
                  className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold transition-colors duration-150 ${
                    right ? "bg-good text-white" : wrong ? "bg-bad text-white" : "border border-line text-muted group-enabled:group-hover:border-accent/40 group-enabled:group-hover:text-ink"
                  }`}
                  aria-hidden
                >
                  {right ? "✓" : wrong ? "✕" : String.fromCharCode(65 + i)}
                </span>
                <Rich text={opt} className="min-w-0 flex-1 font-serif text-[17px]" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <SymbolBar
            disabled={!!result || checking}
            onInsert={(sym) => {
              const el = answerRef.current;
              const start = el?.selectionStart ?? response.length;
              const end = el?.selectionEnd ?? response.length;
              setResponse(response.slice(0, start) + sym + response.slice(end));
              requestAnimationFrame(() => {
                el?.focus();
                el?.setSelectionRange(start + sym.length, start + sym.length);
              });
            }}
          />
          <textarea
            ref={answerRef}
            value={response}
            disabled={!!result || checking}
            onChange={(e) => setResponse(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit(response)}
            rows={3}
            placeholder="Your answer (typing sqrt(x), x^2 or sum works too)"
            autoFocus
            className="field selectable rounded-xl px-4 py-3 font-serif text-[17px] leading-relaxed placeholder:font-sans placeholder:text-[14px] disabled:opacity-70"
          />
          {!result ? (
            <button onClick={() => void submit(response)} disabled={checking || !response.trim()} className="btn-primary self-start">
              {checking ? "Checking…" : "Check answer"}
            </button>
          ) : null}
        </div>
      )}

      {failed ? <div className="mt-4"><Problem message={failed} onRetry={() => void submit(response)} /></div> : null}

      {result ? (
        <div className={`appear mt-6 rounded-xl border px-4 py-3 ${result.correct ? "border-good/30 bg-good/10" : "border-bad/30 bg-bad/10"}`}>
          <p className={`flex items-center gap-2 font-semibold ${result.correct ? "text-good" : "text-bad"}`}>
            {result.correct ? "Correct" : "Not quite"}
            {result.cloud ? <CloudTag className="ml-auto" /> : null}
          </p>
          {!result.correct ? (
            <div className="mt-2 flex items-baseline gap-2">
              <span className="shrink-0 text-muted">Answer:</span>
              <Rich text={result.answer} className="font-serif text-[16px]" />
            </div>
          ) : null}
          {result.explanation ? <Rich text={result.explanation} className="mt-2 font-serif text-[16px]" /> : null}
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-3">
        {item.chunkId ? (
          <button onClick={() => setShowSource(!showSource)} className="btn-ghost -ml-3">
            {showSource ? "Hide source" : "Show source"}
          </button>
        ) : <span />}
        {result ? (
          <button onClick={props.onNext} className="btn-primary">
            {number === total ? "See results" : "Next question"}
          </button>
        ) : null}
      </div>
      {showSource && item.chunkId ? <Source passages={passages} chunkId={item.chunkId} /> : null}
    </div>
  );
}

// Symbols you can't type on a keyboard, for short answers.
const SYMBOLS = ["∑", "∏", "√", "²", "³", "ⁿ", "≤", "≥", "≠", "≡", "∈", "∉", "ℕ", "ℤ", "ℚ", "ℝ", "∀", "∃", "⇒", "⇔", "¬", "∧", "∨", "π", "θ", "α", "β", "λ", "∞", "·", "÷", "±", "|"];

function SymbolBar({ onInsert, disabled }: { onInsert: (s: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Insert a symbol">
      {SYMBOLS.map((sym) => (
        <button
          key={sym}
          type="button"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()} // keep the cursor in the answer box
          onClick={() => onInsert(sym)}
          className="chip min-w-8 justify-center px-2 font-serif text-[15px]"
          title={`Insert ${sym}`}
        >
          {sym}
        </button>
      ))}
    </div>
  );
}

function Results({ items }: { items: QuizItemView[] }) {
  const correct = items.filter((q) => q.answered?.correct).length;
  return (
    <div className="card appear p-6">
      <p className="eyebrow">Quiz complete</p>
      <p className="mt-2 font-serif text-[28px] font-semibold tracking-tight">
        You got {correct} of {items.length}
      </p>
      <p className="mt-1 text-muted">
        {correct === items.length ? "Nice work." : "Go back through the sources for the ones you missed."}
      </p>
      <div className="mt-4 flex h-1.5 gap-1" aria-hidden>
        {items.map((q) => (
          <span key={q.id} className={`flex-1 rounded-full ${q.answered?.correct ? "bg-good" : "bg-bad"}`} />
        ))}
      </div>
      <ol className="mt-6 divide-y divide-line">
        {items.map((q) => (
          <li key={q.id} className="flex items-start gap-3 py-3">
            <span
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${q.answered?.correct ? "bg-good" : "bg-bad"}`}
            >
              {q.answered?.correct ? "✓" : "✕"}
            </span>
            <Rich text={q.question} className="min-w-0 flex-1 font-serif text-[16px]" />
          </li>
        ))}
      </ol>
      <button onClick={() => void window.api.closeWindow()} className="btn-primary mt-6">
        Done
      </button>
    </div>
  );
}

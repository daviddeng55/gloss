// End-of-session review: what you covered, then a short quiz on it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerResult, QuizItemView, ReviewData } from "../../shared/types.ts";
import { plainMathToLatex } from "../../shared/mathText.ts";
import { dateFmt, duration, timeFmt } from "./format.ts";
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
      <div className="flex-1 overflow-y-auto px-8 pb-12">
        <div className="mx-auto max-w-2xl">
          <header className="mb-8">
            <p className="text-sm text-muted">
              {dateFmt.format(new Date(data.startedAt))} · {timeFmt.format(new Date(data.startedAt))}
            </p>
            <h1 className="text-[28px] leading-tight font-bold tracking-tight">
              {data.courseName} · {duration(data.activeMs)} studied
            </h1>
            {data.goal ? <p className="mt-1 text-muted">Goal: {data.goal}</p> : null}
          </header>

          <section id="review-summary" className="mb-10 scroll-mt-4">
            <h2 className="mb-4 text-xs font-bold tracking-widest text-accent uppercase">What you covered</h2>
            <SummaryView data={data} onRetry={() => void window.api.retryReview(sessionId)} />
          </section>

          {data.connections.length ? (
            <section className="mb-10">
              <h2 className="mb-3 text-xs font-bold tracking-widest text-accent uppercase">Builds on</h2>
              <div className="rounded-2xl border border-line bg-card p-4 shadow-sm">
                <p className="mb-2 text-muted">Today's material uses ideas you've found hard before:</p>
                <ul className="space-y-1.5">
                  {data.connections.map((c) => (
                    <li key={c.conceptId} className="flex items-baseline justify-between gap-3">
                      <span className="font-serif text-[16px]">{c.name}</span>
                      <span className="text-sm text-muted tabular-nums">
                        {Math.round(c.current * 100)}% · last studied {dateFmt.format(new Date(c.lastStudied))}
                      </span>
                    </li>
                  ))}
                </ul>
                <button onClick={() => void window.api.openLearn()} className="mt-3 text-sm text-accent hover:underline">
                  See how you learn →
                </button>
              </div>
            </section>
          ) : null}

          <section id="review-quiz" className="scroll-mt-4">
            <h2 className="mb-4 text-xs font-bold tracking-widest text-accent uppercase">Quiz</h2>
            <QuizView data={data} onRetry={() => void window.api.retryReview(sessionId)} reload={load} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Working({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3 text-muted shadow-sm">
      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function Problem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl bg-amber-500/15 px-4 py-3">
      <p className="selectable">{message}</p>
      {onRetry ? (
        <button onClick={onRetry} className="shrink-0 rounded-lg bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-700">
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
    <div className="mt-2 rounded-xl border border-line bg-paper px-3 py-2 text-[14px]">
      <p className="mb-1 truncate text-xs text-muted">
        {timeFmt.format(new Date(p.capturedAt))} · {p.sourceTitle || "unknown window"}
      </p>
      <Rich text={p.text} keepLines className="font-serif" />
    </div>
  );
}

function SummaryView({ data, onRetry }: { data: ReviewData; onRetry: () => void }) {
  const [open, setOpen] = useState<string | null>(null); // "point:chunk" whose source is showing
  const { status, data: summary, error } = data.summary;
  if (status === "error") return <Problem message={error ?? "Couldn't make a summary."} onRetry={onRetry} />;
  if (data.finishing) return <Working>Finishing reading your notes (re-reading the math)… this can take a couple of minutes.</Working>;
  if (status !== "done" || !summary) return <Working>Summarizing your session… this takes about a minute.</Working>;
  if (!summary.ok) return <Problem message={summary.reason} />;
  return (
    <ol className="space-y-3">
      {summary.points.map((pt, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-strong tabular-nums">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <Rich text={plainMathToLatex(pt.text)} className="font-serif text-[17px]" />
            {pt.passageIds.length ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {pt.passageIds.map((id, j) => {
                  const key = `${i}:${id}`;
                  return (
                    <button
                      key={id}
                      onClick={() => setOpen(open === key ? null : key)}
                      className={`rounded-md px-2 py-0.5 text-xs ${open === key ? "bg-accent text-white" : "bg-accent-soft text-accent-strong hover:brightness-95"}`}
                    >
                      Source {pt.passageIds.length > 1 ? j + 1 : ""}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {open?.startsWith(`${i}:`) ? <Source passages={data.passages} chunkId={open.slice(open.indexOf(":") + 1)} /> : null}
          </div>
        </li>
      ))}
    </ol>
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
        {data.summary.status === "done" ? "Writing and checking your quiz… about 2 minutes." : "Your quiz comes after the summary."}
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
      onAnswered={reload}
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

  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-sm">
      <p className="mb-2 text-xs font-medium text-muted">
        Question {number} of {total} · {item.type === "multiple_choice" ? "Multiple choice" : "Short answer"}
      </p>
      <Rich text={item.question} className="mb-4 font-serif text-[18px] leading-snug" />

      {item.type === "multiple_choice" ? (
        <div className="flex flex-col gap-2">
          {item.options?.map((opt) => {
            const chosen = response === opt;
            const right = result && opt === result.answer;
            const wrong = result && chosen && !result.correct;
            return (
              <button
                key={opt}
                disabled={!!result || checking}
                onClick={() => void submit(opt)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  right
                    ? "border-good bg-good/15"
                    : wrong
                      ? "border-bad bg-bad/15"
                      : "border-line bg-paper enabled:hover:bg-accent-soft"
                }`}
              >
                <Rich text={opt} className="font-serif text-[16px]" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
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
            className="selectable rounded-xl border border-line bg-paper px-3 py-2 outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-70"
          />
          {!result ? (
            <button
              onClick={() => void submit(response)}
              disabled={checking || !response.trim()}
              className="self-start rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-strong disabled:opacity-40"
            >
              {checking ? "Checking…" : "Check answer"}
            </button>
          ) : null}
        </div>
      )}

      {failed ? <div className="mt-3"><Problem message={failed} onRetry={() => void submit(response)} /></div> : null}

      {result ? (
        <div className={`mt-4 rounded-lg px-4 py-3 ${result.correct ? "bg-good/15" : "bg-bad/15"}`}>
          <p className="font-semibold">{result.correct ? "✓ Correct" : "✗ Not quite"}</p>
          {!result.correct ? (
            <div className="mt-1">
              <span className="text-muted">Answer: </span>
              <Rich text={result.answer} className="inline-block align-top font-serif" />
            </div>
          ) : null}
          {result.explanation ? <Rich text={result.explanation} className="mt-2 font-serif" /> : null}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        {item.chunkId ? (
          <button onClick={() => setShowSource(!showSource)} className="text-sm text-accent hover:underline">
            {showSource ? "Hide source" : "Show source"}
          </button>
        ) : <span />}
        {result ? (
          <button onClick={props.onNext} className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-strong">
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
    <div className="flex flex-wrap gap-1" aria-label="Insert a symbol">
      {SYMBOLS.map((sym) => (
        <button
          key={sym}
          type="button"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()} // keep the cursor in the answer box
          onClick={() => onInsert(sym)}
          className="min-w-7 rounded-md bg-accent-soft px-1.5 py-0.5 font-serif text-[15px] hover:brightness-95 disabled:opacity-40"
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
    <div className="rounded-2xl border border-line bg-card p-5 shadow-sm">
      <p className="text-xl font-semibold">
        You got {correct} of {items.length}
      </p>
      <p className="mb-4 text-muted">
        {correct === items.length ? "Nice work." : "Go back through the sources for the ones you missed."}
      </p>
      <ol className="space-y-2">
        {items.map((q) => (
          <li key={q.id} className="flex gap-2">
            <span className={q.answered?.correct ? "text-good" : "text-bad"}>{q.answered?.correct ? "✓" : "✗"}</span>
            <Rich text={q.question} className="min-w-0 flex-1 font-serif" />
          </li>
        ))}
      </ol>
      <button
        onClick={() => void window.api.closeWindow()}
        className="mt-5 rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-strong"
      >
        Done
      </button>
    </div>
  );
}

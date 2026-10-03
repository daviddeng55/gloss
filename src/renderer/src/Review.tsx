// End-of-session review: what you covered, then a short quiz on it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerResult, QuizItemView, ReviewData } from "../../shared/types.ts";
import { dateFmt, duration, timeFmt } from "./format.ts";
import Rich from "./Rich.tsx";

export default function Review({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const load = useCallback(() => void window.api.getReview(sessionId).then(setData), [sessionId]);

  useEffect(() => {
    load();
    return window.api.onReview((id) => id === sessionId && load());
  }, [load, sessionId]);

  if (!data) return <div className="drag h-12" />;

  return (
    <div className="flex h-screen flex-col text-[14px] text-neutral-900 dark:text-neutral-100">
      <div className="drag h-12 shrink-0" />
      <div className="flex-1 overflow-y-auto px-8 pb-12">
        <div className="mx-auto max-w-2xl">
          <header className="mb-8">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {dateFmt.format(new Date(data.startedAt))} · {timeFmt.format(new Date(data.startedAt))}
            </p>
            <h1 className="text-2xl font-semibold">
              {data.courseName} · {duration(data.activeMs)} studied
            </h1>
            {data.goal ? <p className="mt-1 text-neutral-600 dark:text-neutral-300">Goal: {data.goal}</p> : null}
          </header>

          <section className="mb-10">
            <h2 className="mb-3 text-lg font-semibold">What you covered</h2>
            <SummaryView data={data} onRetry={() => void window.api.retryReview(sessionId)} />
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">Quiz</h2>
            <QuizView data={data} onRetry={() => void window.api.retryReview(sessionId)} reload={load} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Working({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-black/5 px-4 py-3 text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
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

/** A passage's text, shown when you click a source link. */
function Source({ data, chunkId }: { data: ReviewData; chunkId: string }) {
  const p = data.passages[chunkId];
  if (!p) return <p className="text-sm text-neutral-500">That passage was deleted.</p>;
  return (
    <div className="mt-2 rounded-lg border border-black/10 px-3 py-2 text-[13px] dark:border-white/15">
      <p className="mb-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
        {timeFmt.format(new Date(p.capturedAt))} · {p.sourceTitle || "unknown window"}
      </p>
      <Rich text={p.text} keepLines />
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
          <span className="mt-0.5 text-sm font-semibold text-neutral-400 tabular-nums">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <Rich text={pt.text} />
            {pt.passageIds.length ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {pt.passageIds.map((id, j) => {
                  const key = `${i}:${id}`;
                  return (
                    <button
                      key={id}
                      onClick={() => setOpen(open === key ? null : key)}
                      className={`rounded-md px-2 py-0.5 text-xs ${open === key ? "bg-blue-600 text-white" : "bg-black/5 text-neutral-600 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-300"}`}
                    >
                      Source {pt.passageIds.length > 1 ? j + 1 : ""}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {open?.startsWith(`${i}:`) ? <Source data={data} chunkId={open.slice(open.indexOf(":") + 1)} /> : null}
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
      data={data}
      item={items[current]}
      number={current + 1}
      total={items.length}
      onAnswered={reload}
      onNext={() => setIndex(current + 1)}
    />
  );
}

function Question(props: {
  data: ReviewData;
  item: QuizItemView;
  number: number;
  total: number;
  onAnswered: () => void;
  onNext: () => void;
}) {
  const { data, item, number, total } = props;
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
    <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
      <p className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
        Question {number} of {total} · {item.type === "multiple_choice" ? "Multiple choice" : "Short answer"}
      </p>
      <Rich text={item.question} className="mb-4 text-[15px] font-medium" />

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
                    ? "border-green-600 bg-green-600/15"
                    : wrong
                      ? "border-red-600 bg-red-600/15"
                      : "border-black/10 enabled:hover:bg-black/5 dark:border-white/15 dark:enabled:hover:bg-white/10"
                }`}
              >
                <Rich text={opt} />
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
            className="selectable rounded-lg border border-black/10 bg-transparent px-3 py-2 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:opacity-70 dark:border-white/15"
          />
          {!result ? (
            <button
              onClick={() => void submit(response)}
              disabled={checking || !response.trim()}
              className="self-start rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {checking ? "Checking…" : "Check answer"}
            </button>
          ) : null}
        </div>
      )}

      {failed ? <div className="mt-3"><Problem message={failed} onRetry={() => void submit(response)} /></div> : null}

      {result ? (
        <div className={`mt-4 rounded-lg px-4 py-3 ${result.correct ? "bg-green-600/15" : "bg-red-600/15"}`}>
          <p className="font-semibold">{result.correct ? "✓ Correct" : "✗ Not quite"}</p>
          {!result.correct ? (
            <div className="mt-1">
              <span className="text-neutral-600 dark:text-neutral-300">Answer: </span>
              <Rich text={result.answer} className="inline-block align-top" />
            </div>
          ) : null}
          {result.explanation ? <Rich text={result.explanation} className="mt-2" /> : null}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3">
        {item.chunkId ? (
          <button onClick={() => setShowSource(!showSource)} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            {showSource ? "Hide source" : "Show source"}
          </button>
        ) : <span />}
        {result ? (
          <button onClick={props.onNext} className="rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700">
            {number === total ? "See results" : "Next question"}
          </button>
        ) : null}
      </div>
      {showSource && item.chunkId ? <Source data={data} chunkId={item.chunkId} /> : null}
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
          className="min-w-7 rounded-md bg-black/5 px-1.5 py-0.5 text-[14px] hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:hover:bg-white/20"
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
    <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
      <p className="text-xl font-semibold">
        You got {correct} of {items.length}
      </p>
      <p className="mb-4 text-neutral-500 dark:text-neutral-400">
        {correct === items.length ? "Nice work." : "Go back through the sources for the ones you missed."}
      </p>
      <ol className="space-y-2">
        {items.map((q) => (
          <li key={q.id} className="flex gap-2">
            <span className={q.answered?.correct ? "text-green-600" : "text-red-600"}>{q.answered?.correct ? "✓" : "✗"}</span>
            <Rich text={q.question} className="min-w-0 flex-1" />
          </li>
        ))}
      </ol>
      <button
        onClick={() => void window.api.closeWindow()}
        className="mt-5 rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700"
      >
        Done
      </button>
    </div>
  );
}

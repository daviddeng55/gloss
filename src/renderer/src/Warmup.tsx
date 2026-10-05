// Warm-up at the start of a session: a few questions you're due to review (ones you got wrong first).
import { useEffect, useState } from "react";
import type { WarmupData } from "../../shared/types.ts";
import { Question } from "./Review.tsx";

export default function Warmup({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<WarmupData | null>(null);
  const [index, setIndex] = useState(0);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void window.api.getWarmup(sessionId).then((d) => (d ? setData(d) : setMissing(true)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void window.api.closeWindow();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionId]);

  if (missing) {
    void window.api.closeWindow();
    return null;
  }
  if (!data) return <div className="drag h-12" />;

  const done = index >= data.items.length;
  return (
    <div className="flex h-screen flex-col text-[14px] text-ink">
      <div className="drag h-12 shrink-0" />
      <div className="flex-1 overflow-y-auto px-6 pb-8">
        <p className="text-xs font-bold tracking-widest text-accent uppercase">Warm-up · {data.courseName}</p>
        <h1 className="mt-1 mb-1 text-[22px] font-bold tracking-tight">
          {done ? "Warmed up" : `${data.items.length} question${data.items.length === 1 ? "" : "s"} to start`}
        </h1>
        <p className="mb-4 text-muted">
          {done ? "Nice — on to today's material." : "From earlier sessions, picked because they're due for review."}
        </p>
        {done ? (
          <button
            onClick={() => void window.api.closeWindow()}
            className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-strong"
          >
            Start studying
          </button>
        ) : (
          <>
            <Question
              key={data.items[index].id}
              passages={data.passages}
              item={data.items[index]}
              number={index + 1}
              total={data.items.length}
              onAnswered={() => {}}
              onNext={() => setIndex(index + 1)}
            />
            <button onClick={() => void window.api.closeWindow()} className="mt-3 text-sm text-muted hover:underline">
              Skip the warm-up
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// The popup after circling: what was sent, your question, and the answer with the hint ladder.
import { useEffect, useRef, useState } from "react";
import type { AskInfo, HintLevelId } from "../../shared/types.ts";
import Rich from "./Rich.tsx";

const LEVELS: { id: HintLevelId; label: string }[] = [
  { id: "nudge", label: "Nudge" },
  { id: "explain", label: "Explain the concept" },
  { id: "example", label: "Worked example of a similar problem" },
];

type Turn = { level: HintLevelId; question: string; text: string; status: "streaming" | "done" | "error" };

export default function Ask({ askId }: { askId: string }) {
  const [info, setInfo] = useState<AskInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [bigImage, setBigImage] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.status === "streaming");

  useEffect(() => {
    void window.api.askInfo(askId).then(setInfo);
    const off = window.api.onAsk((e) => {
      if (e.askId !== askId) return;
      setTurns((ts) => {
        const next = [...ts];
        if (e.type === "start") {
          next[e.turn] = { level: e.level, question: e.question, text: "", status: "streaming" };
          setAsked((a) => a || e.question); // also when the question didn't come from the box (e.g. voice)
        }
        else if (next[e.turn]) {
          const t = { ...next[e.turn] };
          if (e.type === "text") t.text += e.text;
          if (e.type === "done") t.status = "done";
          if (e.type === "error") Object.assign(t, { status: "error", text: e.message });
          next[e.turn] = t;
        }
        return next;
      });
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void window.api.closeWindow();
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, [askId]);

  // Keep the newest answer in view. (Braces matter: scrollIntoView now returns a Promise, and React
  // would treat a returned value as a clean-up function.)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  function send(level: HintLevelId, q = asked || question) {
    if (busy || !q.trim()) return;
    if (!asked) setAsked(q.trim());
    void window.api.ask(askId, q.trim(), level);
  }

  if (!info) return <div className="drag h-10" />;

  return (
    <div className="flex h-screen flex-col bg-paper/95 text-[14px] text-ink">
      <div className="drag h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <p className="mb-2 text-xs font-bold tracking-widest text-accent uppercase">
          Ask · {info.courseName}
        </p>
        <button
          onClick={() => setBigImage(!bigImage)}
          className="group mb-1 block w-full overflow-hidden rounded-xl border border-line bg-card"
          title={bigImage ? "Show smaller" : "Show bigger"}
        >
          <img src={info.thumbnail} alt="What was sent" className={`w-full object-contain ${bigImage ? "" : "max-h-36"}`} />
        </button>
        <p className="mb-4 text-xs text-muted">
          {info.circled ? "What you circled" : "Around your cursor"} — exactly what's sent to the AI on your Mac.
        </p>

        {!asked ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send("nudge", question);
            }}
            className="flex flex-col gap-2"
          >
            <textarea
              ref={input}
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send("nudge", question);
                }
              }}
              rows={3}
              placeholder="What do you want to know about this?"
              className="selectable rounded-xl border border-line bg-card px-3 py-2 font-serif text-[16px] outline-none placeholder:font-sans placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Enter to ask · Shift+Enter for a new line · Esc to close</span>
              <button
                type="submit"
                disabled={!question.trim()}
                className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-strong disabled:opacity-40"
              >
                Ask
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="selectable rounded-xl bg-accent-soft/60 px-3 py-2 font-serif text-[16px]">{asked}</p>
            {turns.map((t, i) => (
              <div key={i} className="rounded-2xl border border-line bg-card p-4 shadow-sm">
                <p className="mb-2 text-xs font-bold tracking-wide text-accent">{LEVELS.find((l) => l.id === t.level)?.label}</p>
                {t.status === "error" ? (
                  <p className="text-bad">{t.text}</p>
                ) : t.text ? (
                  <Rich text={t.text} className="font-serif text-[16px]" />
                ) : (
                  <p className="flex items-center gap-2 text-muted">
                    <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Thinking… (the first answer can take ~15 s while the model loads)
                  </p>
                )}
              </div>
            ))}
            <div ref={bottom} />
          </div>
        )}
      </div>

      {asked ? (
        <div className="shrink-0 border-t border-line bg-card/80 px-5 py-3">
          <p className="mb-2 text-xs text-muted">Need more help?</p>
          <div className="flex flex-wrap gap-2">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                disabled={busy}
                onClick={() => send(l.id)}
                className="rounded-full border border-line bg-paper px-3 py-1 text-[13px] font-medium hover:bg-accent-soft disabled:opacity-40"
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The popup after circling: what was sent, your question, and the answer with the hint ladder.
import { useEffect, useRef, useState } from "react";
import type { AskInfo, HintLevelId } from "../../shared/types.ts";
import Rich from "./Rich.tsx";

const LEVELS: { id: HintLevelId; label: string }[] = [
  { id: "nudge", label: "Nudge" },
  { id: "explain", label: "Explain the concept" },
  { id: "example", label: "Worked example of a similar problem" },
];

type Turn = {
  level: HintLevelId;
  question: string;
  text: string;
  status: "streaming" | "done" | "error";
  reason?: string;
  concept?: string;
  sources?: { title: string; when: string }[];
};

export default function Ask({ askId }: { askId: string }) {
  const [info, setInfo] = useState<AskInfo | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [bigImage, setBigImage] = useState(false);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // Asked, but the AI hasn't started on it yet (it may be finishing something else first).
  const waiting = asked !== "" && turns.length === 0;
  const busy = waiting || turns.some((t) => t.status === "streaming");

  useEffect(() => {
    void window.api.askInfo(askId).then((i) => {
      setInfo(i);
      if (i?.spoken) setAsked((a) => a || i.spoken); // the question you said, before the answer starts
    });
    const off = window.api.onAsk((e) => {
      if (e.askId !== askId) return;
      setTurns((ts) => {
        const next = [...ts];
        if (e.type === "start") {
          next[e.turn] = { level: e.level, question: e.question, text: "", status: "streaming", reason: e.reason, concept: e.concept };
          setAsked((a) => a || e.question); // also when the question didn't come from the box (e.g. voice)
        }
        else if (next[e.turn]) {
          const t = { ...next[e.turn] };
          if (e.type === "sources") t.sources = e.sources;
          if (e.type === "text") t.text += e.text;
          if (e.type === "done") t.status = "done";
          if (e.type === "error") Object.assign(t, { status: "error", text: e.message });
          next[e.turn] = t;
        } else if (e.type === "error") {
          next[e.turn] = { level: "nudge", question: "", text: e.message, status: "error" }; // failed before starting
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

  function send(level: HintLevelId | "auto", q = asked || question) {
    if (busy || !q.trim()) return;
    setAsked(q.trim());
    void window.api.ask(askId, q.trim(), level);
  }

  if (!info) return <div className="drag h-10" />;

  return (
    <div className="flex h-screen flex-col bg-paper/95 text-[14px] text-ink">
      <div className="drag h-10 shrink-0" />
      <div className="appear flex-1 overflow-y-auto px-6 pb-4">
        <p className="eyebrow mb-3">
          Ask · {info.courseName}
        </p>
        <button
          onClick={() => setBigImage(!bigImage)}
          className="group mb-2 block w-full overflow-hidden rounded-xl border border-line bg-card transition-shadow duration-150 hover:shadow-card"
          title={bigImage ? "Show smaller" : "Show bigger"}
        >
          <img src={info.thumbnail} alt="What was sent" className={`w-full object-contain ${bigImage ? "" : "max-h-36"}`} />
        </button>
        <p className="mb-6 text-[12px] text-muted">
          {info.circled ? "What you circled" : "Around your cursor"} — exactly what's sent to the AI on your Mac.
        </p>

        {!asked ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send("auto", question);
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
                  send("auto", question);
                }
              }}
              rows={3}
              placeholder="What do you want to know about this?"
              className="field selectable rounded-xl px-4 py-3 font-serif text-[17px] leading-relaxed placeholder:font-sans placeholder:text-[14px]"
            />
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-muted">Enter to ask · Shift+Enter for a new line · Esc to close</span>
              <button type="submit" disabled={!question.trim()} className="btn-primary">
                Ask
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            {editing ? (
              <textarea
                autoFocus
                defaultValue={asked}
                rows={3}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    setEditing(false);
                    send("auto", e.currentTarget.value);
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                className="field selectable rounded-xl px-4 py-3 font-serif text-[17px]"
              />
            ) : (
              <button
                onClick={() => !busy && setEditing(true)}
                className="group rounded-xl bg-hover px-4 py-3 text-left font-serif text-[17px] transition-colors duration-150 hover:bg-ink/10"
                title="Edit your question and ask again"
              >
                {asked}
                <span className="ml-2 font-sans text-[12px] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100">Edit</span>
              </button>
            )}
            {waiting ? (
              <p className="card appear flex items-center gap-3 px-6 py-4 text-muted">
                <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Waiting for the AI to finish what it's doing…
              </p>
            ) : null}
            {turns.map((t, i) => (
              <div key={i} className="card appear p-6">
                <p className="eyebrow">
                  {LEVELS.find((l) => l.id === t.level)?.label}
                  {t.concept ? <span className="font-medium text-muted"> · {t.concept}</span> : null}
                </p>
                {t.reason ? <p className="mt-1 text-[12px] text-muted italic">{t.reason}</p> : null}
                <div className="mb-3" />
                {t.status === "error" ? (
                  <p className="text-bad">{t.text}</p>
                ) : t.text ? (
                  <Rich text={t.text} className="font-serif text-[17px]" />
                ) : (
                  <p className="flex items-center gap-2 text-muted">
                    <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Thinking… (the first answer can take ~15 s while the model loads)
                  </p>
                )}
                {t.sources?.length && t.status !== "error" ? (
                  <p className="mt-4 border-t border-line pt-3 text-[12px] text-muted">
                    Sources: {t.sources.map((s) => `${s.when} — ${s.title}`).join(" · ")}
                  </p>
                ) : null}
              </div>
            ))}
            <div ref={bottom} />
          </div>
        )}
      </div>

      {asked ? (
        <div className="shrink-0 border-t border-line bg-paper/85 px-6 py-3 backdrop-blur-xl">
          <p className="eyebrow mb-2">Need more help?</p>
          <div className="flex flex-wrap gap-2">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                disabled={busy}
                onClick={() => send(l.id)}
                className="btn-secondary h-7 rounded-full px-3"
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

// The Study Buddy window (route #/buddy): a small card in the bottom corner with the character, its
// question in a speech bubble, and a place to answer by typing or speaking. It never takes focus by
// itself; click into the box to type.
import { useEffect, useRef, useState } from "react";
import type { BuddyView } from "../../shared/types.ts";
import { BuddyFigure } from "./Buddy.tsx";
import CloudTag from "./CloudTag.tsx";

export default function BuddyWindow() {
  const [view, setView] = useState<BuddyView | null>(null);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.api.getBuddyView().then((v) => v && setView(v));
    return window.api.onBuddyView((v) => {
      setView((old) => {
        // A new question (follow-up): clear the box for the next answer.
        if (old && v.line !== old.line && v.canAnswer) setText("");
        return v;
      });
    });
  }, []);

  if (!view) return null;
  const listening = view.voice === "listening";
  const send = () => {
    if (!text.trim()) return;
    void window.api.buddyAnswer(text);
  };

  return (
    <div className="flex h-screen items-end p-2 text-[13px] text-ink">
      <div className="appear w-full rounded-[22px] border border-line bg-card p-4 shadow-pop">
        <div className="drag flex items-start gap-3">
          <BuddyFigure character={view.character} mood={view.mood} size={92} className="shrink-0 -ml-1 -mt-1" />
          <div className="min-w-0 flex-1 pt-1">
            <p className="eyebrow flex items-center gap-2">
              {view.name}
              {view.cloud ? <CloudTag className="ml-auto" /> : null}
            </p>
            {/* the speech bubble */}
            <div key={view.line} className="appear relative mt-1.5 rounded-2xl rounded-tl-md bg-hover px-3.5 py-2.5">
              <p className="selectable font-serif text-[15px] leading-snug">{view.line}</p>
            </div>
          </div>
        </div>

        {view.canAnswer ? (
          <div className="mt-3">
            <textarea
              ref={box}
              rows={2}
              value={listening ? view.partial || "" : text}
              readOnly={listening}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") void window.api.closeWindow();
              }}
              placeholder={listening ? "Listening…" : "Explain it in your own words…"}
              className="field selectable w-full resize-none text-[13px] leading-snug"
            />
            <div className="mt-2 flex items-center gap-2">
              {view.voice !== "off" ? (
                <button
                  onClick={() => void window.api.buddyMic()}
                  disabled={view.voice === "unavailable"}
                  title={view.voice === "unavailable" ? "Voice isn't available right now" : listening ? "Stop and send" : "Answer by voice"}
                  className={`btn h-8 px-3 ${listening ? "bg-bad text-white hover:bg-bad/90" : "btn-secondary"}`}
                >
                  <MicIcon />
                  {listening ? (
                    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
                      {[0.5, 1, 0.7].map((k, i) => (
                        <span key={i} className="w-[3px] rounded-full bg-white transition-all duration-100" style={{ height: `${Math.max(3, Math.min(12, (view.level ?? 0) * 14 * k + 3))}px` }} />
                      ))}
                    </span>
                  ) : null}
                </button>
              ) : null}
              <button onClick={send} disabled={!text.trim() || listening} className="btn-primary h-8 flex-1">
                Tell {view.name}
              </button>
            </div>
          </div>
        ) : null}

        {!view.done ? (
          <div className="mt-2.5 flex items-center justify-between">
            <span className="flex gap-1">
              <button onClick={() => void window.api.buddyNotNow()} className="btn-ghost h-7 px-2 text-[12px]">
                Not now
              </button>
              <button onClick={() => void window.api.buddyPauseSession()} className="btn-ghost h-7 px-2 text-[12px]">
                Pause for this session
              </button>
            </span>
            <button onClick={() => void window.api.closeWindow()} className="btn-ghost h-7 px-2 text-[12px]" title="Close">
              ✕
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <rect x="3.5" y="1" width="5" height="8" rx="2.5" />
      <path d="M1.5 7a4.5 4.5 0 0 0 9 0M6 11.5V13" />
    </svg>
  );
}

// The popover under the menu bar icon (left click): quick actions only. Start or stop a session,
// search what you've seen ("Find it"), and jump to your last few sessions. Bigger things open in
// their own windows. Esc or clicking outside closes it.
import { useEffect, useRef, useState } from "react";
import type { AppState, Course, PopoverView, SessionRow } from "../../shared/types.ts";
import { FindDetail, FindResults, openFound, type Found } from "./Find.tsx";
import StartView from "./StartView.tsx";
import { dateFmt, duration } from "./format.ts";

/** 754000 ms -> "12:34"; over an hour -> "1:02:34". */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const Icon = {
  search: (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="2.6" />
      <path
        strokeLinejoin="round"
        d="M8.6 2.5h2.8l.4 2 1.5.9 1.9-.7 1.4 2.4-1.5 1.4v1.8l1.5 1.4-1.4 2.4-1.9-.7-1.5.9-.4 2H8.6l-.4-2-1.5-.9-1.9.7-1.4-2.4 1.5-1.4V9.1L3.4 7.7l1.4-2.4 1.9.7 1.5-.9z"
      />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
      <rect x="4" y="3" width="2.6" height="10" rx="0.8" />
      <rect x="9.4" y="3" width="2.6" height="10" rx="0.8" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
      <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
      <rect x="3" y="3" width="10" height="10" rx="2" />
    </svg>
  ),
};

export default function Popover() {
  const [view, setView] = useState<PopoverView>("home");
  const [opened, setOpened] = useState(0); // counts openings, to reset the start form
  const [state, setState] = useState<{ s: AppState; at: number }>({ s: { status: "idle" }, at: Date.now() });
  const [now, setNow] = useState(Date.now());
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  function refresh() {
    void window.api.listSessions().then((all) => setSessions(all.slice(0, 3)));
    void window.api.getCourses().then(setCourses);
  }

  function focusSearch() {
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }

  useEffect(() => {
    const open = (v: PopoverView) => {
      setView(v === "find" ? "home" : v);
      setOpened((n) => n + 1);
      setFound(null);
      refresh();
      if (v !== "start") focusSearch();
    };
    void window.api.popoverView().then(open);
    void window.api.getState().then((s) => setState({ s, at: Date.now() }));
    const offOpen = window.api.onPopoverOpen(open);
    const offState = window.api.onState((s) => {
      setState({ s, at: Date.now() });
      refresh();
    });
    const offReview = window.api.onReview(() => refresh()); // a summary or score changed
    return () => {
      offOpen();
      offState();
      offReview();
    };
  }, []);

  // The timer: count up from the last known study time while recording.
  const s = state.s;
  useEffect(() => {
    if (s.status !== "recording") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s.status]);
  const activeMs = s.status === "idle" ? 0 : s.activeMs + (s.status === "recording" ? Math.max(0, now - state.at) : 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (found) {
        setFound(null);
        focusSearch();
      } else void window.api.closeWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [found]);

  const courseName = (id: string) => courses.find((c) => c.id === id)?.name ?? id;

  if (found)
    return (
      <div>
        <FindDetail
          found={found}
          onBack={() => {
            setFound(null);
            focusSearch();
          }}
        />
      </div>
    );

  if (view === "start")
    return (
      <div>
        <StartView
          key={opened}
          onBack={() => {
            setView("home");
            focusSearch();
          }}
        />
      </div>
    );

  return (
    <div className="appear flex h-screen flex-col text-[13px] text-ink">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            {s.status === "recording" ? <span className="absolute inset-0 animate-ping rounded-full bg-accent/50" /> : null}
            <span
              className={`relative size-2.5 rounded-full transition-colors duration-200 ${
                s.status === "recording" ? "bg-accent" : s.status === "paused" ? "bg-amber-500" : "bg-muted/35"
              }`}
            />
          </span>
          <span className="font-serif text-[17px] font-semibold tracking-tight">Gloss</span>
        </div>
        <span className="truncate pl-4 text-[11px] text-muted">
          {s.status === "idle" ? "Not recording" : `${s.status === "paused" ? "Paused" : "Recording"} · ${s.courseName}`}
        </span>
      </header>

      {/* Start / stop */}
      <div className="px-4">
        {s.status === "idle" ? (
          <button
            type="button"
            onClick={() => setView("start")}
            className="btn-primary h-11 w-full rounded-xl text-[14px] font-semibold"
          >
            Start session
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void window.api.endSession()}
              className="flex h-11 flex-1 items-center justify-between rounded-xl bg-ink px-4 text-paper shadow-sm transition-opacity duration-150 hover:opacity-90"
            >
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                {Icon.stop} End session
              </span>
              <span className="text-[15px] font-medium tabular-nums">{clock(activeMs)}</span>
            </button>
            <button
              type="button"
              title={s.status === "paused" ? "Resume" : "Pause"}
              aria-label={s.status === "paused" ? "Resume" : "Pause"}
              onClick={() => void (s.status === "paused" ? window.api.resumeSession() : window.api.pauseSession())}
              className="flex size-11 items-center justify-center rounded-xl bg-hover transition-colors duration-150 hover:bg-ink/10"
            >
              {s.status === "paused" ? Icon.play : Icon.pause}
            </button>
          </div>
        )}
      </div>

      {/* Find it */}
      <div className="px-4 pt-3">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-card/60 px-3 text-muted transition-shadow duration-150 focus-within:border-accent/50 focus-within:ring-3 focus-within:ring-accent/20">
          {Icon.search}
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find it: what do you remember seeing?"
            aria-label="Search everything Gloss has read"
            className="selectable w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
          />
        </label>
      </div>

      {/* Search results, or the last few sessions */}
      {query.trim() ? (
        <FindResults query={query} onOpen={(m) => void openFound(m, query).then(setFound)} />
      ) : (
        <section className="flex-1 overflow-y-auto px-2 pt-3">
          <h2 className="eyebrow px-2 pb-2">Recent sessions</h2>
          {sessions.length === 0 ? (
            <div className="appear mx-2 mt-2 rounded-xl border border-dashed border-line px-4 py-6 text-center">
              <p className="font-serif text-[15px]">No sessions yet</p>
              <p className="mt-1 text-[12px] text-muted">Press Start session when you sit down to study.</p>
            </div>
          ) : (
            <ul>
              {sessions.map((x) => {
                const live = s.status !== "idle" && s.sessionId === x.id;
                return (
                  <li key={x.id} className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-hover">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {courseName(x.courseId)}
                        {x.goal ? <span className="font-normal text-muted"> · {x.goal}</span> : null}
                      </p>
                      <p className="text-[11px] text-muted tabular-nums">
                        {dateFmt.format(new Date(x.startedAt))} · {live ? "now" : duration(x.activeMs)}
                      </p>
                    </div>
                    {live ? null : (
                      <div className="flex shrink-0 gap-1">
                        {(["summary", "quiz"] as const).map((section) => (
                          <button
                            key={section}
                            type="button"
                            disabled={x.chunkCount === 0}
                            title={x.chunkCount === 0 ? "Nothing was captured in this session" : undefined}
                            onClick={() => void window.api.openReview(x.id, section)}
                            className="rounded-md border border-line bg-card/70 px-2 py-1 text-[11px] font-medium transition-colors duration-150 hover:bg-hover disabled:opacity-40"
                          >
                            {section === "summary" ? "Summary" : "Quiz"}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Footer */}
      <footer className="flex items-center justify-between border-t border-line px-2 py-2">
        <button type="button" onClick={() => void window.api.openHistory()} className="btn-ghost h-7 px-2 font-medium text-ink">
          See all sessions →
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={() => void window.api.openSettings()}
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            {Icon.gear}
          </button>
          <button
            type="button"
            onClick={() => void window.api.quit()}
            className="btn-ghost h-7 px-2"
          >
            Quit
          </button>
        </div>
      </footer>
    </div>
  );
}

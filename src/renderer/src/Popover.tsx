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
      <div className="font-system">
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
      <div className="font-system">
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
    <div className="font-system flex h-screen flex-col text-[13px] text-ink">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            {s.status === "recording" ? <span className="absolute inset-0 animate-ping rounded-full bg-red-500/60" /> : null}
            <span
              className={`relative size-2.5 rounded-full ${
                s.status === "recording" ? "bg-red-500" : s.status === "paused" ? "bg-amber-500" : "bg-muted/40"
              }`}
            />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Gloss</span>
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
            className="h-12 w-full rounded-xl bg-accent text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong"
          >
            Start session
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void window.api.endSession()}
              className="flex h-12 flex-1 items-center justify-between rounded-xl bg-ink px-4 text-paper shadow-sm transition-opacity hover:opacity-90"
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
              className="flex size-12 items-center justify-center rounded-xl bg-ink/[0.07] transition-colors hover:bg-ink/[0.12]"
            >
              {s.status === "paused" ? Icon.play : Icon.pause}
            </button>
          </div>
        )}
      </div>

      {/* Find it */}
      <div className="px-4 pt-3">
        <label className="flex items-center gap-2 rounded-lg bg-ink/[0.06] px-2.5 py-1.5 text-muted transition-shadow focus-within:ring-2 focus-within:ring-accent/30">
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
          <h2 className="px-2 pb-1 text-[11px] font-medium text-muted">Recent sessions</h2>
          {sessions.length === 0 ? (
            <p className="px-2 pt-1 text-muted">No sessions yet. Start one above.</p>
          ) : (
            <ul>
              {sessions.map((x) => {
                const live = s.status !== "idle" && s.sessionId === x.id;
                return (
                  <li key={x.id} className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-ink/[0.05]">
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
                            className="rounded-md bg-ink/[0.06] px-2 py-1 text-[11px] font-medium transition-colors hover:bg-ink/[0.12] disabled:opacity-40 disabled:hover:bg-ink/[0.06]"
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
      <footer className="flex items-center justify-between border-t border-ink/[0.08] px-4 py-2.5">
        <button type="button" onClick={() => void window.api.openHistory()} className="font-medium text-accent hover:text-accent-strong">
          See all sessions
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={() => void window.api.openSettings()}
            className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-ink/[0.07] hover:text-ink"
          >
            {Icon.gear}
          </button>
          <button
            type="button"
            onClick={() => void window.api.quit()}
            className="rounded-md px-2 py-1 text-muted transition-colors hover:bg-ink/[0.07] hover:text-ink"
          >
            Quit
          </button>
        </div>
      </footer>
    </div>
  );
}

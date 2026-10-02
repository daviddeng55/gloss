// History window: sessions grouped by course on the left, the selected session's notes on the right.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, Course, SessionDetail, SessionRow } from "../../shared/types.ts";

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export default function History() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [state, setState] = useState<AppState>({ status: "idle" });

  const refresh = useCallback(async () => {
    const [c, s, st] = await Promise.all([window.api.getCourses(), window.api.listSessions(), window.api.getState()]);
    setCourses(c);
    setSessions(s);
    setState(st);
    setSelectedId((id) => id ?? s[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    return window.api.onState(() => void refresh());
  }, [refresh]);

  const liveId = state.status === "idle" ? null : state.sessionId;

  useEffect(() => {
    if (!selectedId) return setDetail(null);
    const load = () => void window.api.getSession(selectedId).then(setDetail);
    load();
    // While this session is still recording, show new text as it's saved.
    if (selectedId !== liveId) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [selectedId, sessions, liveId]);

  const courseName = useCallback((id: string) => courses.find((c) => c.id === id)?.name ?? id, [courses]);

  // Group by course, in courses.json order; unknown course ids go last.
  const groups = useMemo(() => {
    const order = new Map(courses.map((c, i) => [c.id, i]));
    const byCourse = new Map<string, SessionRow[]>();
    for (const s of sessions ?? []) byCourse.set(s.courseId, [...(byCourse.get(s.courseId) ?? []), s]);
    return [...byCourse.entries()].sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  }, [sessions, courses]);

  return (
    <div className="flex h-screen text-[13px] text-neutral-900 dark:text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col border-r border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-950/40">
        <div className="drag h-12 shrink-0" />
        <h1 className="px-4 pb-2 text-lg font-semibold">History</h1>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions === null ? null : sessions.length === 0 ? (
            <p className="px-2 py-6 text-neutral-500">
              No sessions yet. Start one from the menu bar icon.
            </p>
          ) : (
            groups.map(([courseId, list]) => (
              <section key={courseId} className="mt-3">
                <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
                  {courseName(courseId)}
                </h2>
                {list.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left ${
                      s.id === selectedId ? "bg-blue-600 text-white" : "hover:bg-black/5 dark:hover:bg-white/10"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{dateFmt.format(new Date(s.startedAt))}</span>
                      <span className={`text-xs tabular-nums ${s.id === selectedId ? "text-white/80" : "text-neutral-500"}`}>
                        {s.id === liveId ? (state.status === "paused" ? "Paused" : "● Recording") : duration(s.activeMs)}
                      </span>
                    </span>
                    <span className={`truncate text-xs ${s.id === selectedId ? "text-white/80" : "text-neutral-500"}`}>
                      {timeFmt.format(new Date(s.startedAt))}
                      {s.goal ? ` · ${s.goal}` : ""}
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag h-12 shrink-0" />
        {detail ? <SessionView s={detail} courseName={courseName(detail.courseId)} live={detail.id === liveId} /> : null}
      </main>
    </div>
  );
}

function SessionView({ s, courseName, live }: { s: SessionDetail; courseName: string; live: boolean }) {
  const started = new Date(s.startedAt);
  return (
    <div className="flex-1 overflow-y-auto px-8 pb-10">
      <div className="max-w-3xl">
      <header className="mb-6">
        <h2 className="text-xl font-semibold">
          {courseName} · {dateFmt.format(started)}
        </h2>
        <p className="mt-1 text-neutral-500 tabular-nums dark:text-neutral-400">
          {timeFmt.format(started)}
          {s.endedAt ? `–${timeFmt.format(new Date(s.endedAt))}` : live ? " · recording now" : ""}
          {" · "}
          {duration(s.activeMs)} studied · {s.chunkCount} passage{s.chunkCount === 1 ? "" : "s"}
        </p>
        {s.goal ? (
          <p className="selectable mt-3 rounded-lg bg-black/5 px-3 py-2 dark:bg-white/10">
            <span className="font-medium">Goal:</span> {s.goal}
          </p>
        ) : null}
      </header>

      {s.chunks.length === 0 ? (
        <p className="text-neutral-500">
          {live ? "Nothing saved yet — text appears here as you study." : "No text was saved in this session."}
        </p>
      ) : (
        <ol className="divide-y divide-black/10 dark:divide-white/10">
          {s.chunks.map((c) => (
            <li key={c.id} className="py-4 first:pt-0">
              <p className="mb-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
                <span className="tabular-nums">{timeFmt.format(new Date(c.capturedAt))}</span> · {c.sourceApp}
                {c.sourceTitle ? ` — ${c.sourceTitle}` : ""}
              </p>
              <p className="selectable leading-relaxed whitespace-pre-wrap">{c.text}</p>
            </li>
          ))}
        </ol>
      )}
      </div>
    </div>
  );
}

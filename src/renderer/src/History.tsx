// History window: sessions grouped by course on the left, the selected session's notes on the right.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, Course, SessionDetail, SessionRow } from "../../shared/types.ts";
import { plainMathToLatex } from "../../shared/mathText.ts";
import { dateFmt, duration, timeFmt } from "./format.ts";
import Rich from "./Rich.tsx";

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
    const offState = window.api.onState(() => void refresh());
    const offReview = window.api.onReview(() => void refresh()); // a summary or score changed
    return () => {
      offState();
      offReview();
    };
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
    <div className="flex h-screen text-[13px] text-ink">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-card">
        <div className="drag h-12 shrink-0" />
        <h1 className="px-4 pb-2 text-2xl font-bold tracking-tight">History</h1>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions === null ? null : sessions.length === 0 ? (
            <p className="px-2 py-6 text-muted">
              No sessions yet. Start one from the menu bar icon.
            </p>
          ) : (
            groups.map(([courseId, list]) => (
              <section key={courseId} className="mt-3">
                <h2 className="px-2 pb-1 text-[11px] font-bold tracking-widest text-accent uppercase">
                  {courseName(courseId)}
                </h2>
                {list.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left ${
                      s.id === selectedId ? "bg-accent text-white" : "hover:bg-accent-soft"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{dateFmt.format(new Date(s.startedAt))}</span>
                      <span className={`text-xs tabular-nums ${s.id === selectedId ? "text-white/80" : "text-muted"}`}>
                        {s.id === liveId ? (state.status === "paused" ? "Paused" : "● Recording") : duration(s.activeMs)}
                      </span>
                    </span>
                    <span className={`truncate text-xs ${s.id === selectedId ? "text-white/80" : "text-muted"}`}>
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
        {detail ? (
          <SessionView s={detail} courseName={courseName(detail.courseId)} live={detail.id === liveId} onChanged={() => void refresh()} />
        ) : null}
      </main>
    </div>
  );
}

function SessionView({ s, courseName, live, onChanged }: { s: SessionDetail; courseName: string; live: boolean; onChanged: () => void }) {
  const started = new Date(s.startedAt);
  return (
    <div className="flex-1 overflow-y-auto px-8 pb-10">
      <div className="max-w-3xl">
      <header className="mb-6">
        <h2 className="text-[26px] leading-tight font-bold tracking-tight">
          {courseName} · {dateFmt.format(started)}
        </h2>
        <p className="mt-1 text-muted tabular-nums">
          {timeFmt.format(started)}
          {s.endedAt ? `–${timeFmt.format(new Date(s.endedAt))}` : live ? " · recording now" : ""}
          {" · "}
          {duration(s.activeMs)} studied · {s.chunkCount} passage{s.chunkCount === 1 ? "" : "s"}
        </p>
        {s.goal ? (
          <p className="selectable mt-3 rounded-lg bg-accent-soft/60 px-3 py-2">
            <span className="font-medium">Goal:</span> {s.goal}
          </p>
        ) : null}
        {!live && s.chunkCount > 0 ? (
          <div className="mt-4 rounded-2xl border border-line bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">Summary &amp; quiz</h3>
              <div className="flex items-center gap-3">
                {s.quizScore ? (
                  <span className="text-muted tabular-nums">
                    Quiz: {s.quizScore.correct}/{s.quizScore.total}
                  </span>
                ) : null}
                {s.summary ? (
                  <button
                    onClick={() => {
                      if (confirm("Make a new summary and quiz for this session? The current ones and your quiz answers will be replaced.")) {
                        void window.api.redoReview(s.id);
                      }
                    }}
                    className="rounded-lg px-3 py-1 font-medium text-accent hover:bg-accent-soft"
                    title="After removing passages, make the summary and quiz again"
                  >
                    Redo
                  </button>
                ) : null}
                <button
                  onClick={() => void window.api.openReview(s.id)}
                  className="rounded-lg bg-accent px-3 py-1 font-medium text-white hover:bg-accent-strong"
                >
                  {s.summary ? "Open" : "Make summary & quiz"}
                </button>
              </div>
            </div>
            {s.summary?.ok ? (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {s.summary.points.map((p, i) => (
                  <li key={i}>
                    <Rich text={plainMathToLatex(p.text)} className="font-serif" />
                  </li>
                ))}
              </ul>
            ) : s.summary ? (
              <p className="mt-2 text-muted">{s.summary.reason}</p>
            ) : null}
          </div>
        ) : null}
      </header>

      {s.questions.length ? (
        <section className="mb-6">
          <h3 className="mb-2 text-[11px] font-bold tracking-widest text-accent uppercase">
            Questions you asked ({s.questions.length})
          </h3>
          <ul className="space-y-2">
            {s.questions.map((q) => (
              <li key={q.id}>
                <details className="rounded-xl border border-line bg-card px-3 py-2">
                  <summary className="cursor-pointer font-serif text-[15px]">
                    <span className="mr-2 text-xs text-muted tabular-nums">{timeFmt.format(new Date(q.askedAt))}</span>
                    {q.question}
                  </summary>
                  <div className="mt-2 space-y-3">
                    {q.answers.map((a, i) => (
                      <div key={i}>
                        <p className="text-xs font-bold text-accent">{a.level}</p>
                        <Rich text={a.text} className="font-serif text-[15px]" />
                      </div>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {s.chunks.length === 0 ? (
        <p className="text-muted">
          {live ? "Nothing saved yet — text appears here as you study." : "No text was saved in this session."}
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {s.chunks.map((c) => (
            <li key={c.id} className="group py-4 first:pt-0">
              <div className="mb-1 flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-xs text-muted">
                  <span className="tabular-nums">{timeFmt.format(new Date(c.capturedAt))}</span> · {c.sourceApp}
                  {c.sourceTitle ? ` — ${c.sourceTitle}` : ""}
                </p>
                <button
                  onClick={() => {
                    if (confirm("Remove this passage? It won't be used in summaries or quizzes. This can't be undone.")) {
                      void window.api.deletePassage(c.id).then(onChanged);
                    }
                  }}
                  className="rounded px-1.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-red-500/15 hover:text-bad focus:opacity-100"
                  title="Remove this passage"
                  aria-label="Remove this passage"
                >
                  ✕
                </button>
              </div>
              <Rich text={c.text} keepLines className="font-serif text-[15px]" />
            </li>
          ))}
        </ol>
      )}
      </div>
    </div>
  );
}

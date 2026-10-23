// "All captures": every raw capture, by session (grouped by course), with delete controls. Reached from
// the Notes sidebar; `highlightChunkId` scrolls to the capture a note's source link came from.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, Course, SessionDetail, SessionRow } from "../../shared/types.ts";
import { plainMathToLatex } from "../../shared/mathText.ts";
import { dateFmt, duration, timeFmt } from "./format.ts";
import CloudTag from "./CloudTag.tsx";
import Rich from "./Rich.tsx";

export default function History(props: { onBack: () => void; initialSessionId?: string; highlightChunkId?: string }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialSessionId ?? null);
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
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-ink/[0.025]">
        <div className="drag h-12 shrink-0" />
        <button onClick={props.onBack} className="btn-ghost mx-2 mb-1 h-7 justify-start px-2">
          ← Notes
        </button>
        <h1 className="px-4 pb-3 font-serif text-[26px] font-semibold tracking-tight">All captures</h1>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions === null ? null : sessions.length === 0 ? (
            <p className="px-2 py-4 text-muted">Your sessions will appear here.</p>
          ) : (
            groups.map(([courseId, list]) => (
              <section key={courseId} className="mt-4">
                <h2 className="eyebrow group flex h-6 items-center justify-between px-2">
                  {courseName(courseId)}
                  {state.status === "idle" || state.courseId !== courseId ? (
                    <button
                      onClick={() => {
                        if (confirm(`Delete ALL ${courseName(courseId)} sessions, notes, quizzes, questions and learner model? This can't be undone.`)) {
                          void window.api.deleteCourseData(courseId).then(() => {
                            setSelectedId(null);
                            void refresh();
                          });
                        }
                      }}
                      className="rounded px-1 text-[11px] font-medium tracking-normal normal-case text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-bad"
                    >
                      Delete all
                    </button>
                  ) : null}
                </h2>
                {list.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 ${
                      s.id === selectedId ? "bg-accent-soft" : "hover:bg-hover"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{dateFmt.format(new Date(s.startedAt))}</span>
                      <span className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums">
                        {s.id === liveId && state.status !== "paused" ? <span className="size-1.5 rounded-full bg-accent" /> : null}
                        {s.id === liveId ? (state.status === "paused" ? "Paused" : "Recording") : duration(s.activeMs)}
                      </span>
                    </span>
                    <span className="truncate text-[12px] text-muted">
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
        {sessions?.length === 0 ? (
          <div className="appear flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
            <p className="font-serif text-[24px] font-semibold tracking-tight">No sessions yet</p>
            <p className="mt-2 max-w-sm leading-relaxed text-muted">
              Start one from the menu bar: click the Gloss icon, then Start session. Your notes, summaries and quizzes
              will collect here.
            </p>
          </div>
        ) : detail ? (
          <SessionView
            highlightChunkId={detail.id === props.initialSessionId ? props.highlightChunkId : undefined}
            s={detail}
            courseName={courseName(detail.courseId)}
            live={detail.id === liveId}
            onChanged={() => void refresh()}
            onDeleted={() => {
              setSelectedId(null);
              void refresh();
            }}
          />
        ) : null}
      </main>
    </div>
  );
}

function SessionView(props: { s: SessionDetail; courseName: string; live: boolean; highlightChunkId?: string; onChanged: () => void; onDeleted: () => void }) {
  const { s, courseName, live, onChanged } = props;
  const started = new Date(s.startedAt);
  // Came from a note's source link: show that capture.
  useEffect(() => {
    if (props.highlightChunkId) document.querySelector(`[data-chunk="${props.highlightChunkId}"]`)?.scrollIntoView({ block: "center" });
  }, [props.highlightChunkId]);
  return (
    <div className="flex-1 overflow-y-auto px-8 pb-12">
      <div key={s.id} className="appear max-w-3xl">
      <header className="mb-8">
        {!live ? (
          <button
            onClick={() => {
              if (confirm("Delete this session — its notes, summary, quiz and questions? This can't be undone.")) {
                void window.api.deleteSession(s.id).then(props.onDeleted);
              }
            }}
            className="btn-danger float-right mt-1"
          >
            Delete session
          </button>
        ) : null}
        <p className="eyebrow">{courseName}</p>
        <h2 className="mt-1 font-serif text-[30px] leading-tight font-semibold tracking-tight">
          {dateFmt.format(started)}
        </h2>
        <p className="mt-2 text-muted tabular-nums">
          {timeFmt.format(started)}
          {s.endedAt ? `–${timeFmt.format(new Date(s.endedAt))}` : live ? " · recording now" : ""}
          {" · "}
          {duration(s.activeMs)} studied · {s.chunkCount} passage{s.chunkCount === 1 ? "" : "s"}
        </p>
        {s.goal ? (
          <p className="selectable mt-4 rounded-xl bg-hover px-4 py-3">
            <span className="text-muted">Goal</span> <span className="ml-2 font-serif text-[15px]">{s.goal}</span>
          </p>
        ) : null}
        {!live && s.chunkCount > 0 ? (
          <div className="card mt-6 p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-serif text-[18px] font-semibold">Summary &amp; quiz</h3>
              <div className="flex items-center gap-2">
                {s.quizScore ? (
                  <span className="mr-2 text-[13px] text-muted tabular-nums">
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
                    className="btn-ghost"
                    title="After removing passages, make the summary and quiz again"
                  >
                    Redo
                  </button>
                ) : null}
                <button
                  onClick={() => void window.api.openReview(s.id)}
                  className="btn-primary"
                >
                  {s.summary ? "Open" : "Make summary & quiz"}
                </button>
              </div>
            </div>
            {s.summary?.ok ? (
              <ul className="mt-4 space-y-3">
                {s.summary.points.map((p, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                    <Rich text={plainMathToLatex(p.text)} className="min-w-0 flex-1 font-serif text-[15px]" />
                  </li>
                ))}
              </ul>
            ) : s.summary ? (
              <p className="mt-3 text-muted">{s.summary.reason}</p>
            ) : null}
          </div>
        ) : null}
      </header>

      {s.questions.length ? (
        <section className="mb-8">
          <h3 className="eyebrow mb-3">
            Questions you asked ({s.questions.length})
          </h3>
          <ul className="space-y-2">
            {s.questions.map((q) => (
              <li key={q.id}>
                <details className="card rounded-xl px-4 py-3 shadow-none">
                  <summary className="cursor-pointer font-serif text-[16px] transition-colors duration-150 hover:text-muted">
                    <span className="mr-2 font-sans text-[12px] text-muted tabular-nums">{timeFmt.format(new Date(q.askedAt))}</span>
                    {q.question}
                  </summary>
                  <div className="mt-3 space-y-3 border-t border-line pt-3">
                    {q.answers.map((a, i) => (
                      <div key={i}>
                        <p className="eyebrow mb-1 flex items-center gap-2">
                          {a.level}
                          {a.cloud ? <CloudTag /> : null}
                        </p>
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

      <h3 className="eyebrow mb-3">Captured text</h3>
      {s.chunks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-muted">
          {live ? "Nothing saved yet — text appears here as you study." : "No text was saved in this session."}
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {s.chunks.map((c) => (
            <li key={c.id} data-chunk={c.id} className={`group py-4 first:pt-0 ${c.id === props.highlightChunkId ? "-mx-4 rounded-xl bg-accent-soft/50 px-4 first:pt-4" : ""}`}>
              <div className="mb-1 flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  <span className="tabular-nums">{timeFmt.format(new Date(c.capturedAt))}</span> · {c.sourceApp}
                  {c.sourceTitle ? ` — ${c.sourceTitle}` : ""}
                </p>
                <button
                  onClick={() => {
                    if (confirm("Remove this passage? It won't be used in summaries or quizzes. This can't be undone.")) {
                      void window.api.deletePassage(c.id).then(onChanged);
                    }
                  }}
                  className="rounded-md px-1.5 text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-bad/10 hover:text-bad focus:opacity-100"
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

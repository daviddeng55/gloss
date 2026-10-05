// "How you learn": what the learner model believes about you, per course and concept — with the
// reasons, and controls to correct or delete any of it.
import { useCallback, useEffect, useState } from "react";
import type { HelpCounts, LearnConcept, LearnProfile } from "../../shared/types.ts";
import { dateFmt } from "./format.ts";

const HELP_LABEL: Record<keyof HelpCounts, string> = {
  nudge: "a nudge",
  explain: "explaining the concept",
  example: "a worked example",
};

function topHelp(h: HelpCounts): keyof HelpCounts | null {
  const total = h.nudge + h.explain + h.example;
  if (total < 2) return null;
  return (Object.keys(h) as (keyof HelpCounts)[]).reduce((a, b) => (h[b] > h[a] ? b : a));
}

function band(m: number): { label: string; color: string } {
  if (m >= 0.75) return { label: "Strong", color: "bg-good" };
  if (m >= 0.45) return { label: "Getting there", color: "bg-accent" };
  return { label: "Needs work", color: "bg-bad" };
}

export default function Learn() {
  const [profile, setProfile] = useState<LearnProfile | null>(null);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.api.getLearnProfile().then((p) => {
      setProfile(p);
      setCourseId((id) => (id && p.courses.some((c) => c.courseId === id) ? id : (p.courses[0]?.courseId ?? null)));
    });
  }, []);
  useEffect(load, [load]);

  if (!profile) return <div className="drag h-12" />;
  const course = profile.courses.find((c) => c.courseId === courseId);
  const overall = topHelp(profile.overall);

  return (
    <div className="flex h-screen flex-col text-[14px] text-ink">
      <div className="drag h-12 shrink-0" />
      <div className="flex-1 overflow-y-auto px-8 pb-12">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">How you learn</h1>
          <p className="mt-1 text-muted">
            Built from your quiz answers, the questions you ask and what you study. It stays on your Mac, and you can
            correct or delete any of it.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-4 shadow-sm">
              <p className="text-xs font-bold tracking-widest text-accent uppercase">What helps you</p>
              <p className="mt-1 font-serif text-[17px]">
                {overall ? `You tend to get things after ${HELP_LABEL[overall]}.` : "Not enough answers yet to tell."}
              </p>
              <p className="mt-1 text-xs text-muted">
                Nudge {profile.overall.nudge} · Concept {profile.overall.explain} · Worked example {profile.overall.example}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-card p-4 shadow-sm">
              <p className="text-xs font-bold tracking-widest text-accent uppercase">Course memory</p>
              <p className="mt-1 font-serif text-[17px]">
                {profile.memoryByMeaning ? "Searching your past sessions by meaning." : "Searching your past sessions by matching words."}
              </p>
              {!profile.memoryByMeaning ? (
                <p className="mt-1 text-xs text-muted">Matching by meaning turns on once the embedding model is downloaded.</p>
              ) : null}
            </div>
          </div>

          {profile.courses.length === 0 ? (
            <p className="mt-8 rounded-2xl border border-line bg-card p-5 text-muted shadow-sm">
              Nothing yet. After your next session's summary, the concepts you studied show up here — and they get more
              accurate as you answer quiz questions and ask about things.
            </p>
          ) : (
            <>
              <div className="mt-8 flex flex-wrap items-center gap-2">
                {profile.courses.map((c) => (
                  <button
                    key={c.courseId}
                    onClick={() => setCourseId(c.courseId)}
                    className={`rounded-full px-3 py-1 font-medium ${c.courseId === courseId ? "bg-accent text-white" : "bg-accent-soft/70 hover:bg-accent-soft"}`}
                  >
                    {c.courseName} <span className="opacity-70">({c.concepts.length})</span>
                  </button>
                ))}
                {course ? (
                  <button
                    onClick={() => {
                      if (confirm(`Delete everything the learner model knows about ${course.courseName}? Your notes and sessions stay.`)) {
                        void window.api.deleteLearnerModel(course.courseId).then(load);
                      }
                    }}
                    className="ml-auto text-sm text-muted hover:text-bad"
                  >
                    Delete for {course.courseName}
                  </button>
                ) : null}
              </div>

              <ul className="mt-4 space-y-2">
                {course?.concepts.map((c) => (
                  <ConceptRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChange={load} />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ConceptRow({ c, open, onToggle, onChange }: { c: LearnConcept; open: boolean; onToggle: () => void; onChange: () => void }) {
  const b = band(c.current);
  const help = topHelp(c.helps);
  return (
    <li className="rounded-2xl border border-line bg-card shadow-sm">
      <button onClick={onToggle} className="flex w-full items-center gap-4 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-[17px]">{c.name}</p>
          <p className="text-xs text-muted">
            {b.label}
            {c.confidence < 0.4 ? " · early guess" : ""}
            {c.lastPracticedAt ? ` · last practised ${dateFmt.format(new Date(c.lastPracticedAt))}` : ""}
            {c.override !== null ? " · marked by you" : ""}
          </p>
        </div>
        <div className="w-36 shrink-0">
          <div className="h-2 overflow-hidden rounded-full bg-line">
            <div className={`h-full rounded-full ${b.color}`} style={{ width: `${Math.max(4, Math.round(c.current * 100))}%`, opacity: 0.45 + c.confidence * 0.55 }} />
          </div>
          <p className="mt-1 text-right text-xs text-muted tabular-nums">{Math.round(c.current * 100)}%</p>
        </div>
      </button>
      {open ? (
        <div className="border-t border-line px-4 py-3">
          <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
            {c.why.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {help ? <li>What helps you here: {HELP_LABEL[help]}.</li> : null}
          </ul>
          {c.sources.length ? (
            <p className="mt-2 text-xs text-muted">
              Studied in:{" "}
              {c.sources.map((s) => `${dateFmt.format(new Date(s.startedAt))} — ${s.sourceTitle || "unknown window"}`).join(" · ")}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => void window.api.markConcept(c.id, c.override === true ? null : true).then(onChange)}
              className={`rounded-full border border-line px-3 py-1 text-[13px] ${c.override === true ? "bg-good/20" : "hover:bg-accent-soft"}`}
            >
              {c.override === true ? "✓ Marked as known (undo)" : "I know this"}
            </button>
            <button
              onClick={() => void window.api.markConcept(c.id, c.override === false ? null : false).then(onChange)}
              className={`rounded-full border border-line px-3 py-1 text-[13px] ${c.override === false ? "bg-bad/20" : "hover:bg-accent-soft"}`}
            >
              {c.override === false ? "✓ Marked as not yet (undo)" : "I don't know this yet"}
            </button>
            <button
              onClick={() => {
                if (confirm(`Forget "${c.name}" and its evidence?`)) void window.api.deleteConcept(c.id).then(onChange);
              }}
              className="ml-auto rounded-full px-3 py-1 text-[13px] text-muted hover:text-bad"
            >
              Forget this concept
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

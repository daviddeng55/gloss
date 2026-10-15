// The popover's start view: pick a course, optionally type a goal, Start.
// (The popover remounts it each time it opens, so it starts from a clean form.)
import { useEffect, useRef, useState } from "react";
import type { Course, StartResult } from "../../shared/types.ts";

const LAST_COURSE = "lastCourse";

function readLastCourse(): string | null {
  try {
    return localStorage.getItem(LAST_COURSE);
  } catch {
    return null;
  }
}

export default function StartView({ onBack }: { onBack: () => void }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string | null>(readLastCourse());
  const [goal, setGoal] = useState("");
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<Extract<StartResult, { ok: false }> | null>(null);
  const goalRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.api.getCourses().then(setCourses);
  }, []);

  const selected = courses.find((c) => c.id === courseId);

  async function start() {
    if (!selected || starting) return;
    setStarting(true);
    setProblem(null);
    try {
      localStorage.setItem(LAST_COURSE, selected.id);
    } catch {
      /* not essential */
    }
    const res = await window.api.startSession(selected.id, goal);
    setStarting(false);
    if (!res.ok) setProblem(res);
  }

  return (
    <form
      className="flex h-screen flex-col gap-4 p-4 text-[13px] text-ink"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div className="flex flex-col gap-1">
        <button type="button" onClick={onBack} className="self-start font-medium text-accent hover:text-accent-strong">
          ← Back
        </button>
        <h1 className="text-[15px] font-semibold">Start a study session</h1>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-xs font-medium text-muted">Course</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {courses.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setCourseId(c.id);
                goalRef.current?.focus();
              }}
              className={`rounded-lg px-3 py-2 text-left font-medium transition-colors ${
                c.id === courseId
                  ? "bg-accent text-white"
                  : "bg-accent-soft/70 hover:bg-accent-soft"
              }`}
              aria-pressed={c.id === courseId}
            >
              {c.name}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Goal (optional)</span>
        <input
          ref={goalRef}
          autoFocus
          value={goal}
          maxLength={200}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. finish induction practice problems"
          className="selectable rounded-xl border border-line bg-card/80 px-3 py-2 outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </label>

      {problem?.reason === "permission" ? (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-500/15 p-3 text-[12px] leading-snug">
          <p className="font-medium">{problem.message}</p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              Click <b>Open System Settings</b>, then turn on <b>Electron</b> under Screen &amp; System Audio
              Recording.
            </li>
            <li>Quit Gloss from its menu and start it again (macOS applies the permission on restart).</li>
          </ol>
          <button
            type="button"
            onClick={() => void window.api.openScreenRecordingSettings()}
            className="self-start rounded-md bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700"
          >
            Open System Settings
          </button>
        </div>
      ) : problem ? (
        <p className="rounded-lg bg-red-500/15 p-3 text-[12px]">{problem.message}</p>
      ) : null}

      <div className="mt-auto flex flex-col gap-2">
        <button
          type="submit"
          disabled={!selected || starting}
          className="rounded-lg bg-accent py-2 font-semibold text-white hover:bg-accent-strong disabled:opacity-40"
        >
          {starting ? "Starting…" : selected ? `Start ${selected.name}` : "Choose a course"}
        </button>
        <p className="text-center text-[11px] text-muted">
          Never start a session during a test, quiz or exam.
        </p>
      </div>
    </form>
  );
}

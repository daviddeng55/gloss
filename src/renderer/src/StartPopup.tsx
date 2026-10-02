// The popup under the menu bar icon: pick a course, optionally type a goal, Start.
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

export default function StartPopup() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string | null>(readLastCourse());
  const [goal, setGoal] = useState("");
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<Extract<StartResult, { ok: false }> | null>(null);
  const goalRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void window.api.getCourses().then(setCourses);
    // Each time the popup opens, start from a clean form.
    return window.api.onState(() => {
      setGoal("");
      setProblem(null);
      setStarting(false);
      void window.api.getCourses().then(setCourses);
      goalRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void window.api.closeWindow();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      className="flex h-screen flex-col gap-4 p-4 text-[13px] text-neutral-900 dark:text-neutral-100"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h1 className="text-[15px] font-semibold">Start a study session</h1>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">Course</legend>
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
                  ? "bg-blue-600 text-white"
                  : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
              }`}
              aria-pressed={c.id === courseId}
            >
              {c.name}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Goal (optional)</span>
        <input
          ref={goalRef}
          autoFocus
          value={goal}
          maxLength={200}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. finish induction practice problems"
          className="selectable rounded-lg border border-black/10 bg-white/70 px-3 py-2 outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-white/15 dark:bg-black/20"
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
            <li>Quit Study Buddy from its menu and start it again (macOS applies the permission on restart).</li>
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
          className="rounded-lg bg-blue-600 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {starting ? "Starting…" : selected ? `Start ${selected.name}` : "Choose a course"}
        </button>
        <p className="text-center text-[11px] text-neutral-500 dark:text-neutral-400">
          Never start a session during a test, quiz or exam.
        </p>
      </div>
    </form>
  );
}

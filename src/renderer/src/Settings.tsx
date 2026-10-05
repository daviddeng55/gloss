// Settings: courses, the ask shortcut and voice, capture timing, learning, never-record list, AI models,
// and the rules for using Study Buddy. Saved to settings.json / courses.json / never-record.json.
import { useEffect, useState, type ReactNode } from "react";
import type { SettingsView } from "../../shared/types.ts";

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="mb-6 rounded-2xl border border-line bg-card p-5 shadow-sm">
      <h2 className="text-xs font-bold tracking-widest text-accent uppercase">{title}</h2>
      {note ? <p className="mt-1 text-[13px] text-muted">{note}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const input = "rounded-lg border border-line bg-paper px-2 py-1 outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 selectable";

function NumberInput({ value, onChange, min, max, suffix }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className={`${input} w-20 text-right tabular-nums`} />
      {suffix ? <span className="text-muted">{suffix}</span> : null}
    </span>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? "left-5.5" : "left-0.5"}`} />
    </button>
  );
}

function ModelPicker({ value, installed, onChange }: { value: string; installed: string[]; onChange: (m: string) => void }) {
  const options = installed.includes(value) ? installed : [value, ...installed];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${input} w-44`}>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
          {!installed.includes(m) ? " (not downloaded)" : ""}
        </option>
      ))}
    </select>
  );
}

/** An editable list of short strings (one per line). */
function ListEditor({ items, onChange, placeholder }: { items: string[]; onChange: (items: string[]) => void; placeholder: string }) {
  return (
    <textarea
      value={items.join("\n")}
      onChange={(e) => onChange(e.target.value.split("\n"))}
      rows={Math.min(10, Math.max(3, items.length + 1))}
      placeholder={placeholder}
      className={`${input} w-full font-mono text-[12px] leading-relaxed`}
    />
  );
}

export default function Settings() {
  const [s, setS] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; message?: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.api.getSettings().then(setS);
  }, []);
  if (!s) return <div className="drag h-12" />;

  const update = (fn: (draft: SettingsView) => void) => {
    const next = structuredClone(s);
    fn(next);
    setS(next);
    setDirty(true);
    setStatus(null);
  };
  const save = async () => {
    const res = await window.api.saveSettings(s);
    setStatus(res);
    if (res.ok) {
      setDirty(false);
      setS(await window.api.getSettings());
    }
  };

  return (
    <div className="flex h-screen flex-col text-[14px] text-ink">
      <div className="drag h-12 shrink-0" />
      <div className="flex-1 overflow-y-auto px-8 pb-28">
        <div className="mx-auto max-w-2xl">
          <h1 className="mb-6 text-[28px] leading-tight font-bold tracking-tight">Settings</h1>

          <Section title="Rules for me" note="Study Buddy is a study partner, not a way around the rules.">
            <ul className="list-disc space-y-1 pl-5 font-serif text-[16px]">
              <li>Never start a session during a test, quiz or exam.</li>
              <li>Check each course's rules about AI tools, and follow them.</li>
            </ul>
          </Section>

          <Section title="Courses" note="Math courses also re-read formulas with the math reader, so symbols come out right.">
            {s.courses.map((c, i) => (
              <div key={i} className="flex items-center gap-3">
                <input
                  value={c.name}
                  onChange={(e) => update((d) => void (d.courses[i].name = e.target.value))}
                  className={`${input} flex-1`}
                  placeholder="Course name, e.g. MATH 135"
                />
                <span className="flex items-center gap-2 text-[13px] text-muted">
                  Math <Toggle on={!!c.math} onChange={(b) => update((d) => void (d.courses[i].math = b))} />
                </span>
                <button
                  onClick={() => update((d) => void d.courses.splice(i, 1))}
                  className="rounded px-2 text-muted hover:text-bad"
                  title="Remove from the list (its sessions stay in History)"
                >
                  ✕
                </button>
              </div>
            ))}
            <button onClick={() => update((d) => void d.courses.push({ id: "", name: "" }))} className="text-accent hover:underline">
              + Add a course
            </button>
          </Section>

          <Section title="Circle and ask">
            <Row label="Shortcut" hint={'Press to start circling, again to send. Format like "Alt+A" (Alt = Option) or "CommandOrControl+Shift+A".'}>
              <input value={s.settings.ask.shortcut} onChange={(e) => update((d) => void (d.settings.ask.shortcut = e.target.value))} className={`${input} w-56`} />
            </Row>
            <Row label="Ask by voice" hint="Microphone on only between the two presses; speech is turned into text on your Mac.">
              <Toggle on={s.settings.ask.voice} onChange={(b) => update((d) => void (d.settings.ask.voice = b))} />
            </Row>
            <Row label="Area around the cursor" hint="Sent when you don't circle anything.">
              <span className="flex items-center gap-1.5">
                <NumberInput value={s.settings.ask.fallbackW} min={200} max={3000} onChange={(n) => update((d) => void (d.settings.ask.fallbackW = n))} />
                ×
                <NumberInput value={s.settings.ask.fallbackH} min={150} max={2000} onChange={(n) => update((d) => void (d.settings.ask.fallbackH = n))} suffix="points" />
              </span>
            </Row>
          </Section>

          <Section title="Capture">
            <Row label="Check the screen every">
              <NumberInput value={s.settings.capture.intervalSeconds} min={2} max={60} suffix="seconds" onChange={(n) => update((d) => void (d.settings.capture.intervalSeconds = n))} />
            </Row>
            <Row label="Read a page after it's been in front for" hint="Quick tab switches shorter than this are never recorded.">
              <NumberInput value={s.settings.capture.dwellSeconds} min={0} max={60} suffix="seconds" onChange={(n) => update((d) => void (d.settings.capture.dwellSeconds = n))} />
            </Row>
          </Section>

          <Section title="Learning">
            <Row label="Offer help when I seem stuck" hint="A quiet notification; it never interrupts on its own.">
              <Toggle on={s.settings.learn.offerHelpWhenStuck} onChange={(b) => update((d) => void (d.settings.learn.offerHelpWhenStuck = b))} />
            </Row>
          </Section>

          <Section
            title="Never record"
            note="Checked before every capture. Apps: one bundle ID or app name per line. Window titles: one pattern per line (case-insensitive; regular expressions allowed)."
          >
            <p className="font-medium">Apps</p>
            <ListEditor items={s.neverRecord.apps} onChange={(v) => update((d) => void (d.neverRecord.apps = v))} placeholder="com.apple.MobileSMS" />
            <p className="font-medium">Window titles</p>
            <ListEditor items={s.neverRecord.titles} onChange={(v) => update((d) => void (d.neverRecord.titles = v))} placeholder="online banking" />
          </Section>

          <Section title="AI models" note="Everything runs on your Mac through Ollama. Nothing is sent online.">
            {s.aiProblem ? <p className="rounded-lg bg-bad/15 px-3 py-2">⚠︎ {s.aiProblem}</p> : <p className="text-good">✓ Ollama is running.</p>}
            <Row label="Summaries, quizzes and marking" hint="Runs after a session, in the background: a bigger model is slower but writes better quizzes.">
              <ModelPicker value={s.settings.ai.reviewModel} installed={s.installed ?? []} onChange={(m) => update((d) => void (d.settings.ai.reviewModel = m))} />
            </Row>
            <Row label="Circle and ask" hint="Answers while you wait: a smaller model is faster.">
              <ModelPicker value={s.settings.ai.askModel} installed={s.installed ?? []} onChange={(m) => update((d) => void (d.settings.ai.askModel = m))} />
            </Row>
            {s.models ? (
              <ul className="space-y-1 text-[13px]">
                <li>
                  <span className="text-muted">Math reader (math courses):</span> {s.models.math}
                </li>
                <li>
                  <span className="text-muted">Course memory (search by meaning):</span> {s.models.memory}
                </li>
              </ul>
            ) : null}
            <p className="text-[13px] text-muted">Only one model is loaded at a time; each unloads after 3 minutes unused.</p>
          </Section>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 border-t border-line bg-card/95 px-8 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <p className={`text-[13px] ${status ? (status.ok ? "text-good" : "text-bad") : "text-muted"}`}>
            {status?.message ?? (dirty ? "Unsaved changes" : "All changes saved")}
          </p>
          <button
            onClick={() => void save()}
            disabled={!dirty}
            className="rounded-lg bg-accent px-5 py-1.5 font-semibold text-white hover:bg-accent-strong disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

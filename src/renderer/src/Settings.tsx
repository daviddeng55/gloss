// Settings: courses, the ask shortcut and voice, capture timing, learning, never-record list, fast mode,
// AI models, and the rules for using Gloss. Saved to settings.json / courses.json / never-record.json; the
// Gemini key goes straight to the macOS Keychain and never comes back to this window.
import { useEffect, useState, type ReactNode } from "react";
import type { CloudView, SettingsView } from "../../shared/types.ts";
import { BuddyChooser } from "./Buddy.tsx";

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="mb-8">
      <h2 className="font-serif text-[19px] font-semibold tracking-tight">{title}</h2>
      {note ? <p className="mt-1 text-[13px] leading-relaxed text-muted">{note}</p> : null}
      <div className="card mt-3 space-y-4 p-6">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-6">
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-[12px] leading-snug text-muted">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const input = "field selectable h-8 py-1";

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
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150 ${on ? "bg-accent" : "bg-ink/15"}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-all duration-150 ${on ? "left-4.5" : "left-0.5"}`} />
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
      className="field selectable w-full font-mono text-[12px] leading-relaxed"
    />
  );
}

/** Paste, check and save the Gemini key; or test / remove the saved one. Saved at once (not with Save). */
function CloudKey({ view, onChange }: { view: CloudView; onChange: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const run = async (work: () => Promise<{ ok: boolean; message: string } | void>) => {
    setBusy(true);
    setResult(null);
    const r = await work();
    setBusy(false);
    if (r) setResult(r);
    onChange();
  };
  return (
    <div className="space-y-2">
      {view.hasKey ? (
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 font-medium">
            <span className={`size-2 rounded-full ${view.active ? "bg-good" : "bg-ink/25"}`} />
            {view.active ? "Key saved in your Keychain" : "Key saved; fast mode is off"}
          </p>
          <span className="flex gap-2">
            <button disabled={busy} onClick={() => void run(() => window.api.testCloud())} className="btn-secondary">
              {busy ? "Testing…" : "Test"}
            </button>
            <button disabled={busy} onClick={() => void run(() => window.api.removeCloudKey())} className="btn-danger">
              Remove key
            </button>
          </span>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await window.api.saveCloudKey(key);
              if (r.ok) setKey("");
              return r;
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your Gemini API key"
            className={`${input} flex-1 font-mono`}
          />
          <button type="submit" disabled={busy || !key.trim()} className="btn-primary">
            {busy ? "Checking…" : "Save key"}
          </button>
        </form>
      )}
      {result ? <p className={`text-[13px] ${result.ok ? "text-good" : "text-bad"}`}>{result.message}</p> : null}
      {!result && view.active && view.problem ? (
        <p className="text-[13px] text-bad">
          Last cloud call failed: {view.problem} Using the model on your Mac{view.pausedForSeconds ? ` for the next ${view.pausedForSeconds} s` : " for that one"}.
        </p>
      ) : null}
    </div>
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
        <div className="appear mx-auto max-w-2xl">
          <h1 className="mb-8 font-serif text-[34px] leading-tight font-semibold tracking-tight">Settings</h1>

          <Section title="Rules for me" note="Gloss is a study partner, not a way around the rules.">
            <ul className="list-disc space-y-1 pl-5 font-serif text-[16px] leading-relaxed">
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
                <span className="flex items-center gap-2 text-[12px] text-muted">
                  Math <Toggle on={!!c.math} onChange={(b) => update((d) => void (d.courses[i].math = b))} />
                </span>
                <button
                  onClick={() => update((d) => void d.courses.splice(i, 1))}
                  className="btn-danger h-8 px-2"
                  title="Remove from the list (its sessions stay in History)"
                >
                  ✕
                </button>
              </div>
            ))}
            <button onClick={() => update((d) => void d.courses.push({ id: "", name: "" }))} className="btn-secondary">
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

          <Section title="Study Buddy" note="After you finish something, your buddy asks you to explain it, like a curious classmate. No grades; your answers quietly update How You Learn.">
            <Row label="Study Buddy" hint="Never while you're reading, typing or asking.">
              <Toggle on={s.settings.buddy.enabled} onChange={(b) => update((d) => void (d.settings.buddy.enabled = b))} />
            </Row>
            {s.settings.buddy.enabled ? (
              <>
                <BuddyChooser
                  character={s.settings.buddy.character}
                  name={s.settings.buddy.name}
                  onChange={(c) => update((d) => void Object.assign(d.settings.buddy, c))}
                />
                <Row label="Appear at most every" hint="“Not now” in the buddy's window also gives you 20 minutes.">
                  <NumberInput value={s.settings.buddy.minMinutes} min={10} max={120} suffix="minutes" onChange={(n) => update((d) => void (d.settings.buddy.minMinutes = n))} />
                </Row>
              </>
            ) : null}
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

          <Section
            title="Fast mode"
            note="With your own Gemini API key, Google's Gemini writes summaries, quizzes, notes, answers and Study Buddy's questions in seconds. Only text read in the study apps below is sent, after the same redaction as everything Gloss saves. If there's no key, no internet, or the rate limit is hit, your Mac's model answers instead, as before."
          >
            {s.cloud ? <CloudKey view={s.cloud} onChange={() => void window.api.cloudView().then((cloud) => setS((cur) => (cur ? { ...cur, cloud } : cur)))} /> : null}
            <p className="text-[12px] leading-snug text-muted">
              Get a key at aistudio.google.com → API keys. On Google's free tier, what's sent may be used to improve Google's products (not on a paid key); you must be 18 or older,
              and in the EU, UK and Switzerland only paid keys are allowed. Answers from Gemini carry a “sent to cloud” label.
            </p>
            <Row label="Use fast mode" hint="Off: everything stays on your Mac, even with a key saved.">
              <Toggle on={s.settings.cloud.enabled} onChange={(b) => update((d) => void (d.settings.cloud.enabled = b))} />
            </Row>
            <Row label="Gemini model" hint="gemini-3.5-flash-lite is the fastest Flash model.">
              <input value={s.settings.cloud.model} onChange={(e) => update((d) => void (d.settings.cloud.model = e.target.value.trim()))} className={`${input} w-56 font-mono text-[12px]`} />
            </Row>
            <p className="font-medium">Study apps</p>
            <p className="-mt-3 text-[12px] leading-snug text-muted">
              Only what was read in these apps can be sent (one app name per line, as in the menu bar). A question about any other window, or a picture with a password or card number in it, stays on your Mac.
            </p>
            <ListEditor items={s.settings.cloud.studyApps} onChange={(v) => update((d) => void (d.settings.cloud.studyApps = v))} placeholder="Google Chrome" />
          </Section>

          <Section title="AI models" note="These run on your Mac through Ollama, and nothing they read is sent online. In fast mode they answer whatever can't go to Gemini.">
            {s.aiProblem ? (
              <p className="rounded-xl border border-bad/25 bg-bad/10 px-4 py-3">⚠︎ {s.aiProblem}</p>
            ) : (
              <p className="flex items-center gap-2 font-medium">
                <span className="size-2 rounded-full bg-good" /> Ollama is running
              </p>
            )}
            <Row label="Summaries, quizzes and marking" hint="Runs after a session, in the background: a bigger model is slower but writes better quizzes.">
              <ModelPicker value={s.settings.ai.reviewModel} installed={s.installed ?? []} onChange={(m) => update((d) => void (d.settings.ai.reviewModel = m))} />
            </Row>
            <Row label="Circle and ask" hint="Answers while you wait: a smaller model is faster.">
              <ModelPicker value={s.settings.ai.askModel} installed={s.installed ?? []} onChange={(m) => update((d) => void (d.settings.ai.askModel = m))} />
            </Row>
            {s.models ? (
              <ul className="space-y-1 border-t border-line pt-4 text-[13px]">
                <li>
                  <span className="text-muted">Math reader (math courses):</span> {s.models.math}
                </li>
                <li>
                  <span className="text-muted">Course memory (search by meaning):</span> {s.models.memory}
                </li>
              </ul>
            ) : null}
            <p className="text-[13px] text-muted">One model is loaded at a time (plus the small memory model); each unloads after 3 minutes unused.</p>
          </Section>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 border-t border-line bg-paper/85 px-8 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <p className={`text-[13px] ${status ? (status.ok ? "text-good" : "text-bad") : "text-muted"}`}>
            {status?.message ?? (dirty ? "Unsaved changes" : "All changes saved")}
          </p>
          <button onClick={() => void save()} disabled={!dirty} className="btn-primary px-6">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

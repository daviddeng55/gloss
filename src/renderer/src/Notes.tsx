// The Notes window: class notes organised by course → topic (the main view), with "All captures"
// (every raw capture, by session) one click away. Notes are written in the background after sessions.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChunkRow, NoteKind, NoteTopic, NoteTree } from "../../shared/types.ts";
import { notesMarkdown } from "../../shared/mathText.ts";
import { shortDateFmt, timeFmt } from "./format.ts";
import History from "./History.tsx";
import Rich from "./Rich.tsx";

type View = { mode: "notes" } | { mode: "captures"; sessionId?: string; chunkId?: string };

export default function Library({ topicId, sectionId }: { topicId?: string; sectionId?: string }) {
  const [view, setView] = useState<View>({ mode: "notes" });
  if (view.mode === "captures") {
    return <History onBack={() => setView({ mode: "notes" })} initialSessionId={view.sessionId} highlightChunkId={view.chunkId} />;
  }
  return <NotesView initialTopic={topicId} focusSection={sectionId} onCaptures={(sessionId, chunkId) => setView({ mode: "captures", sessionId, chunkId })} />;
}

function NotesView(props: { initialTopic?: string; focusSection?: string; onCaptures: (sessionId?: string, chunkId?: string) => void }) {
  const [tree, setTree] = useState<NoteTree | null>(null);
  const [selected, setSelected] = useState<string | null>(props.initialTopic ?? null);
  const [topic, setTopic] = useState<NoteTopic | null>(null);

  const refresh = useCallback(async () => {
    const t = await window.api.getNoteTree();
    setTree(t);
    const all = t.courses.flatMap((c) => c.topics.map((x) => x.id));
    setSelected((id) => (id && all.includes(id) ? id : (all[0] ?? null)));
  }, []);

  useEffect(() => {
    void refresh();
    return window.api.onNotes(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    if (!selected) return setTopic(null);
    void window.api.getTopic(selected).then(setTopic);
  }, [selected, tree]);

  const busy = !!tree && (tree.writing || tree.pending > 0);

  return (
    <div className="flex h-screen text-[13px] text-ink">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-ink/[0.025]">
        <div className="drag h-12 shrink-0" />
        <h1 className="px-4 pb-3 font-serif text-[26px] font-semibold tracking-tight">Notes</h1>
        {busy ? <WritingStatus tree={tree!} /> : null}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {tree && tree.courses.length === 0 ? <p className="px-2 py-2 text-muted">Topics will appear here.</p> : null}
          {tree?.courses.map((c) => (
            <section key={c.courseId} className="mt-4 first:mt-1">
              <h2 className="eyebrow flex h-6 items-center px-2">{c.courseName}</h2>
              {c.topics.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
                    t.id === selected ? "bg-accent-soft" : "hover:bg-hover"
                  }`}
                >
                  <span className="truncate font-serif text-[15px]">{t.title}</span>
                  <span className="shrink-0 text-[11px] text-muted tabular-nums">{t.sections}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="flex flex-col border-t border-line p-2">
          <button onClick={() => props.onCaptures()} className="btn-ghost justify-start px-2">
            All captures
          </button>
          <button onClick={() => void window.api.openLearn()} className="btn-ghost justify-start px-2">
            How you learn
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag h-12 shrink-0" />
        {topic ? (
          <TopicView key={topic.id} topic={topic} focusSection={topic.id === props.initialTopic ? props.focusSection : undefined} onCaptures={props.onCaptures} />
        ) : tree && tree.courses.length === 0 ? (
          <Empty busy={busy} />
        ) : null}
      </main>
    </div>
  );
}

function WritingStatus({ tree }: { tree: NoteTree }) {
  const left = tree.pending;
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-[12px] text-muted">
      {tree.writing ? <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden /> : null}
      <span>
        {tree.writing ? "Writing notes…" : "Waiting to write notes"}
        {left > 0 ? ` · ${left} session${left === 1 ? "" : "s"} left` : ""}
      </span>
    </div>
  );
}

function Empty({ busy }: { busy: boolean }) {
  return (
    <div className="appear flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
      {busy ? <span className="mb-4 size-5 animate-spin rounded-full border-2 border-muted border-t-transparent" aria-hidden /> : null}
      <p className="font-serif text-[24px] font-semibold tracking-tight">{busy ? "Writing your notes" : "No notes yet"}</p>
      <p className="mt-2 max-w-sm leading-relaxed text-muted">
        {busy
          ? "Gloss is turning your sessions into class notes, one at a time, in the background. Topics appear here as they're ready."
          : "Start a session from the menu bar. When it ends, Gloss writes clean notes here, organised by course and topic."}
      </p>
    </div>
  );
}

type Section = NoteTopic["sections"][number];

const GROUPS: { title: string; kinds: NoteKind[] }[] = [
  { title: "Key definitions", kinds: ["definition"] },
  { title: "Theorems & formulas", kinds: ["theorem", "formula"] },
  { title: "Key ideas", kinds: ["point"] },
  { title: "Worked examples", kinds: ["example"] },
  { title: "Common mistakes", kinds: ["mistake"] },
];

function TopicView({ topic, focusSection, onCaptures }: { topic: NoteTopic; focusSection?: string; onCaptures: (sessionId?: string, chunkId?: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null); // section whose raw capture is showing

  // Opened from a "Find it" result: scroll to that section.
  useEffect(() => {
    if (focusSection) ref.current?.querySelector(`[data-section="${focusSection}"]`)?.scrollIntoView({ block: "center" });
  }, [focusSection]);

  const source = (s: Section) => (
    <SourceLink section={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} onCaptures={onCaptures} />
  );

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-8 pb-16">
      <article className="appear mx-auto max-w-[720px]">
        <header className="mb-10">
          <button
            onClick={() => {
              if (confirm(`Delete the notes for "${topic.title}"? Your captures stay; only these notes are removed.`)) void window.api.deleteTopic(topic.id);
            }}
            className="btn-danger float-right -mt-1"
          >
            Delete topic
          </button>
          <p className="eyebrow">
            {topic.courseName} · Updated {shortDateFmt.format(new Date(topic.updatedAt))}
          </p>
          <h1 className="mt-2 font-serif text-[36px] leading-[1.12] font-semibold tracking-tight">{topic.title}</h1>
          {topic.summary ? <Rich text={notesMarkdown(topic.summary)} className="mt-4 font-serif text-[19px] leading-relaxed text-ink/85" /> : null}
        </header>

        {GROUPS.map((g) => {
          const items = topic.sections.filter((s) => g.kinds.includes(s.kind));
          if (!items.length) return null;
          return (
            <section key={g.title} className="mb-10">
              <h2 className="mb-4 font-serif text-[21px] font-semibold">{g.title}</h2>
              <div className="space-y-3">
                {items.map((s) => (
                  <Block key={s.id} s={s} focused={s.id === focusSection}>
                    {source(s)}
                  </Block>
                ))}
              </div>
            </section>
          );
        })}
      </article>
    </div>
  );
}

/** One section, styled by kind: definitions in a highlighted box, theorems/examples in cards, mistakes tinted. */
function Block({ s, focused, children }: { s: Section; focused: boolean; children: ReactNode }) {
  const body = <Rich text={notesMarkdown(s.body)} className="font-serif text-[16px]" />;
  // Titles can hold math too ("Every integer $n \ge 2$ is a product of primes").
  const title = (cls: string) => <Rich text={notesMarkdown(s.title)} className={`font-serif font-semibold ${cls}`} />;
  const ring = focused ? " ring-2 ring-accent/40" : "";
  if (s.kind === "definition") {
    return (
      <div data-section={s.id} className={`rounded-2xl border border-accent/20 bg-accent-soft/60 px-6 py-4${ring}`}>
        {title("mb-1 text-[17px]")}
        {body}
        {children}
      </div>
    );
  }
  if (s.kind === "mistake") {
    return (
      <div data-section={s.id} className={`flex gap-3 rounded-2xl border border-bad/20 bg-bad/[0.06] px-6 py-4${ring}`}>
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-bad text-[11px] font-bold text-white" aria-hidden>
          ✕
        </span>
        <div className="min-w-0 flex-1">
          {title("mb-1 text-[16px]")}
          {body}
          {children}
        </div>
      </div>
    );
  }
  if (s.kind === "point") {
    return (
      <div data-section={s.id} className={`flex gap-4 rounded-xl px-1 py-1${ring}`}>
        <span className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          {title("text-[16px]")}
          {body}
          {children}
        </div>
      </div>
    );
  }
  const label = s.kind === "theorem" ? "Theorem" : s.kind === "formula" ? "Formula" : "Example";
  return (
    <div data-section={s.id} className={`card px-6 py-5${ring}`}>
      <p className="eyebrow">{label}</p>
      {title("mt-1 mb-2 text-[17px]")}
      {body}
      {children}
    </div>
  );
}

/** "from Oct 14, 2:14 PM" — opens the raw capture this section was written from. */
function SourceLink({ section, open, onToggle, onCaptures }: { section: Section; open: boolean; onToggle: () => void; onCaptures: (sessionId?: string, chunkId?: string) => void }) {
  const [capture, setCapture] = useState<ChunkRow | null>(null);
  useEffect(() => {
    if (open && section.chunkId && !capture) void window.api.getCapture(section.chunkId).then(setCapture);
  }, [open, section.chunkId, capture]);
  if (!section.chunkId || !section.capturedAt) return null;
  const at = new Date(section.capturedAt);
  return (
    <div className="mt-2">
      <button onClick={onToggle} className="rounded text-[12px] text-muted transition-colors duration-150 hover:text-ink">
        from {shortDateFmt.format(at)}, {timeFmt.format(at)} {open ? "▴" : "▾"}
      </button>
      {open && capture ? (
        <div className="appear mt-2 rounded-xl border border-line bg-paper px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate text-[12px] text-muted">
              {capture.sourceApp}
              {capture.sourceTitle ? ` — ${capture.sourceTitle}` : ""}
            </p>
            <button onClick={() => onCaptures(capture.sessionId, capture.id)} className="shrink-0 text-[12px] font-medium text-muted transition-colors duration-150 hover:text-ink">
              Show in All captures →
            </button>
          </div>
          <Rich text={capture.text} keepLines className="max-h-72 overflow-y-auto font-serif text-[14px]" />
        </div>
      ) : null}
    </div>
  );
}

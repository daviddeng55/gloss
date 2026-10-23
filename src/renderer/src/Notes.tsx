// The Notes window: your courses in the sidebar; a course's page groups its topics under units (general
// headings, sorted by the AI; rename them and drag topics between them); a topic's page has its notes, with key
// terms linked to where they're explained, and the pages that link back to it under "Related". "All captures"
// (every raw capture, by session) is one click away. Notes are written in the background after sessions.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChunkRow, CourseNotes, NoteKind, NoteTopic, NoteTree } from "../../shared/types.ts";
import { applyXrefs } from "../../shared/xrefLinks.ts";
import { notesMarkdown } from "../../shared/mathText.ts";
import { shortDateFmt, timeFmt } from "./format.ts";
import CloudTag from "./CloudTag.tsx";
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

/** Where the notes pane is: a course's page (units → topics) or one topic. */
type Place = { kind: "course"; courseId: string } | { kind: "topic"; topicId: string; sectionId?: string };

function NotesView(props: { initialTopic?: string; focusSection?: string; onCaptures: (sessionId?: string, chunkId?: string) => void }) {
  const [tree, setTree] = useState<NoteTree | null>(null);
  const [place, setPlace] = useState<Place | null>(props.initialTopic ? { kind: "topic", topicId: props.initialTopic, sectionId: props.focusSection } : null);
  const [back, setBack] = useState<Place[]>([]); // where cross-reference links came from
  const [topic, setTopic] = useState<NoteTopic | null>(null);
  const [version, setVersion] = useState(0); // bumps when notes change, so open pages reload

  const refresh = useCallback(async () => {
    const t = await window.api.getNoteTree();
    setTree(t);
    setVersion((v) => v + 1);
    // Nothing chosen yet (or the course is gone): the first course.
    setPlace((p) => (p && (p.kind === "topic" || t.courses.some((c) => c.courseId === p.courseId)) ? p : t.courses[0] ? { kind: "course", courseId: t.courses[0].courseId } : null));
  }, []);

  useEffect(() => {
    void refresh();
    return window.api.onNotes(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    if (place?.kind !== "topic") return setTopic(null);
    void window.api.getTopic(place.topicId).then((t) => {
      setTopic(t);
      if (!t) setPlace((p) => (p?.kind === "topic" && p.topicId === place.topicId && tree?.courses[0] ? { kind: "course", courseId: tree.courses[0].courseId } : p)); // deleted
    });
  }, [place, version]);

  const go = (next: Place, remember = false) => {
    if (remember && place) setBack((b) => [...b, place]);
    else setBack([]);
    setPlace(next);
  };
  const busy = !!tree && (tree.writing || tree.pending > 0);
  const currentCourse = place?.kind === "course" ? place.courseId : topic?.courseId;

  return (
    <div className="flex h-screen text-[13px] text-ink">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-ink/[0.025]">
        <div className="drag h-12 shrink-0" />
        <h1 className="px-4 pb-3 font-serif text-[26px] font-semibold tracking-tight">Notes</h1>
        {busy ? <WritingStatus tree={tree!} /> : null}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {tree && tree.courses.length === 0 ? <p className="px-2 py-2 text-muted">Your courses will appear here.</p> : null}
          {tree?.courses.map((c) => (
            <button
              key={c.courseId}
              data-course={c.courseId}
              onClick={() => go({ kind: "course", courseId: c.courseId })}
              className={`mb-0.5 flex w-full items-baseline justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${
                c.courseId === currentCourse ? "bg-accent-soft" : "hover:bg-hover"
              }`}
            >
              <span className="truncate font-serif text-[16px]">{c.courseName}</span>
              <span className="shrink-0 text-[11px] text-muted tabular-nums">
                {c.topics.length} {c.topics.length === 1 ? "topic" : "topics"}
              </span>
            </button>
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
        {place?.kind === "course" ? (
          <CourseView key={place.courseId} courseId={place.courseId} version={version} onOpen={(topicId) => go({ kind: "topic", topicId })} />
        ) : topic && place?.kind === "topic" && topic.id === place.topicId ? (
          <TopicView
            key={`${topic.id}/${place?.kind === "topic" ? (place.sectionId ?? "") : ""}`}
            topic={topic}
            focusSection={place?.kind === "topic" ? place.sectionId : undefined}
            back={back.length ? () => {
              setPlace(back[back.length - 1]);
              setBack((b) => b.slice(0, -1));
            } : undefined}
            onCourse={() => go({ kind: "course", courseId: topic.courseId })}
            onGo={(topicId, sectionId) => go({ kind: "topic", topicId, sectionId }, true)}
            onCaptures={props.onCaptures}
          />
        ) : tree && tree.courses.length === 0 ? (
          <Empty busy={busy} />
        ) : null}
      </main>
    </div>
  );
}

// ---------- a course's page: units with their topics ----------

/** A topic being dragged, and where it would land (in `unitId`, before `beforeId` or at the end). */
type Drag = { topicId: string; over?: { unitId: string | null | "new"; beforeId?: string } };

function CourseView({ courseId, version, onOpen }: { courseId: string; version: number; onOpen: (topicId: string) => void }) {
  const [data, setData] = useState<CourseNotes | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // unit being renamed

  useEffect(() => {
    void window.api.getCourseNotes(courseId).then(setData);
  }, [courseId, version]);
  if (!data) return null;

  const topicCount = data.units.reduce((n, u) => n + u.topics.length, 0);
  const unitCount = data.units.filter((u) => u.id).length;

  // Moves at once on screen, then saves (the saved order comes back with the next refresh).
  const drop = async (unitId: string | null | "new", beforeId?: string) => {
    const moving = drag?.topicId;
    setDrag(null);
    if (!moving || moving === beforeId) return;
    let target = unitId;
    if (target === "new") {
      target = await window.api.addUnit(courseId, "New unit");
      setEditing(target);
    }
    setData((d) => {
      if (!d) return d;
      const card = d.units.flatMap((u) => u.topics).find((t) => t.id === moving);
      if (!card) return d;
      const units = d.units.map((u) => ({ ...u, topics: u.topics.filter((t) => t.id !== moving) }));
      const into = units.find((u) => u.id === target);
      if (into) {
        const at = beforeId ? into.topics.findIndex((t) => t.id === beforeId) : -1;
        into.topics.splice(at < 0 ? into.topics.length : at, 0, card);
      }
      return { ...d, units };
    });
    await window.api.moveTopic(moving, target, beforeId);
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 pb-16" onDragEnd={() => setDrag(null)}>
      <div className="appear mx-auto max-w-[760px]">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Course notes</p>
            <h1 className="mt-2 font-serif text-[36px] leading-[1.12] font-semibold tracking-tight">{data.courseName}</h1>
            <p className="mt-1.5 text-muted">
              {topicCount} {topicCount === 1 ? "topic" : "topics"}
              {unitCount ? ` in ${unitCount} ${unitCount === 1 ? "unit" : "units"}` : ""} · drag topics between units; click a unit's name to rename it
            </p>
          </div>
          {data.sorting ? (
            <span className="flex shrink-0 items-center gap-2 text-muted">
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
              Sorting into units…
            </span>
          ) : data.canSort ? (
            <button onClick={() => void window.api.sortTopics(courseId)} className="btn-secondary shrink-0">
              Sort into units
            </button>
          ) : null}
        </header>

        {data.units.map((u) => {
          const key = u.id ?? "none";
          const over = drag?.over?.unitId === u.id;
          return (
            <section
              key={key}
              data-unit={key}
              className={`mb-8 rounded-2xl transition-colors duration-150 ${over ? "bg-accent-soft/50 ring-2 ring-accent/30" : ""}`}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over?.unitId !== u.id || drag.over.beforeId) setDrag({ ...drag, over: { unitId: u.id } });
              }}
              onDrop={(e) => {
                e.preventDefault();
                void drop(u.id, drag?.over?.unitId === u.id ? drag.over.beforeId : undefined);
              }}
            >
              <div className="mb-3 flex items-baseline gap-3 px-1">
                {u.id && editing === u.id ? (
                  <input
                    autoFocus
                    defaultValue={u.title === "New unit" ? "" : u.title}
                    placeholder="Unit name"
                    className="field selectable h-9 flex-1 font-serif text-[21px] font-semibold"
                    onBlur={(e) => {
                      setEditing(null);
                      if (e.currentTarget.value.trim() && e.currentTarget.value.trim() !== u.title) void window.api.renameUnit(u.id!, e.currentTarget.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        e.currentTarget.value = u.title;
                        e.currentTarget.blur();
                      }
                    }}
                  />
                ) : u.id ? (
                  <button onClick={() => setEditing(u.id)} className="group flex items-baseline gap-2 text-left" title="Rename this unit">
                    <h2 className="font-serif text-[21px] font-semibold">{u.title}</h2>
                    <span className="text-[12px] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100">Rename</span>
                  </button>
                ) : (
                  <h2 className="font-serif text-[21px] font-semibold text-muted">{u.title}</h2>
                )}
                <span className="ml-auto text-[12px] text-muted tabular-nums">{u.topics.length || ""}</span>
                {u.id && !u.topics.length ? (
                  <button onClick={() => void window.api.deleteUnit(u.id!)} className="btn-ghost h-7 px-2 text-[12px]">
                    Remove unit
                  </button>
                ) : null}
              </div>
              <div className="space-y-2">
                {u.topics.map((t) => (
                  <div
                    key={t.id}
                    onDragOver={(e) => {
                      if (!drag || drag.topicId === t.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (drag.over?.beforeId !== t.id) setDrag({ ...drag, over: { unitId: u.id, beforeId: t.id } });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void drop(u.id, t.id);
                    }}
                  >
                    {drag?.over?.beforeId === t.id ? <div className="mb-2 h-0.5 rounded-full bg-accent" /> : null}
                    <TopicCard topic={t} dragging={drag?.topicId === t.id} onOpen={() => onOpen(t.id)} onDragStart={() => setDrag({ topicId: t.id })} />
                  </div>
                ))}
                {!u.topics.length ? (
                  <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-muted">Drag topics here</p>
                ) : null}
              </div>
            </section>
          );
        })}

        <button
          onClick={async () => setEditing(await window.api.addUnit(courseId, "New unit"))}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            if (drag.over?.unitId !== "new") setDrag({ ...drag, over: { unitId: "new" } });
          }}
          onDrop={(e) => {
            e.preventDefault();
            void drop("new");
          }}
          className={`w-full rounded-2xl border border-dashed px-4 py-4 text-muted transition-colors duration-150 hover:bg-hover hover:text-ink ${
            drag?.over?.unitId === "new" ? "border-accent/50 bg-accent-soft/50 text-ink" : "border-line"
          }`}
        >
          + New unit{drag ? " — drop a topic here to start one" : ""}
        </button>
      </div>
    </div>
  );
}

function TopicCard({ topic, dragging, onOpen, onDragStart }: { topic: CourseNotes["units"][number]["topics"][number]; dragging: boolean; onOpen: () => void; onDragStart: () => void }) {
  return (
    <button
      draggable
      data-topic={topic.id}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", topic.title);
        onDragStart();
      }}
      onClick={onOpen}
      title="Click to open · drag to another unit"
      className={`card block w-full cursor-pointer px-5 py-4 text-left transition-all duration-150 hover:shadow-card active:cursor-grabbing ${dragging ? "opacity-40" : ""}`}
    >
      <span className="block min-w-0">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate font-serif text-[18px] font-semibold">{topic.title}</span>
          <span className="shrink-0 text-[12px] text-muted tabular-nums">
            {topic.sections} {topic.sections === 1 ? "note" : "notes"} · {shortDateFmt.format(new Date(topic.updatedAt))}
          </span>
        </span>
        {topic.summary ? <Rich text={notesMarkdown(topic.summary)} className="mt-1 line-clamp-2 text-[14px] text-muted [&_p]:my-0 [&_p]:inline" /> : null}
      </span>
    </button>
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

function TopicView({
  topic,
  focusSection,
  back,
  onCourse,
  onGo,
  onCaptures,
}: {
  topic: NoteTopic;
  focusSection?: string;
  back?: () => void; // after following a link: return to the page it was on
  onCourse: () => void;
  onGo: (topicId: string, sectionId?: string) => void; // a cross-reference was clicked
  onCaptures: (sessionId?: string, chunkId?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null); // section whose raw capture is showing

  // Opened from a "Find it" result: scroll to that section.
  useEffect(() => {
    if (focusSection) ref.current?.querySelector(`[data-section="${focusSection}"]`)?.scrollIntoView({ block: "center" });
  }, [focusSection]);

  const xref = (id: string) => topic.xrefs?.[id];
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
          {back ? (
            <button onClick={back} className="btn-ghost -ml-3 mb-2 h-7 px-3 text-[12px]">
              ← Back
            </button>
          ) : null}
          <p className="eyebrow flex flex-wrap items-baseline gap-x-1.5">
            <button onClick={onCourse} className="eyebrow transition-colors duration-150 hover:text-ink" title="All of this course's notes">
              {topic.courseName}
            </button>
            {topic.unit ? (
              <>
                <span aria-hidden>›</span>
                <button onClick={onCourse} className="eyebrow transition-colors duration-150 hover:text-ink">
                  {topic.unit.title}
                </button>
              </>
            ) : null}
            <span>· Updated {shortDateFmt.format(new Date(topic.updatedAt))}</span>
          </p>
          <h1 className="mt-2 font-serif text-[36px] leading-[1.12] font-semibold tracking-tight">{topic.title}</h1>
          {topic.summary ? (
            <Rich text={applyXrefs(notesMarkdown(topic.summary), xref("summary"))} onXref={onGo} className="mt-4 font-serif text-[19px] leading-relaxed text-ink/85" />
          ) : null}
        </header>

        {GROUPS.map((g) => {
          const items = topic.sections.filter((s) => g.kinds.includes(s.kind));
          if (!items.length) return null;
          return (
            <section key={g.title} className="mb-10">
              <h2 className="mb-4 font-serif text-[21px] font-semibold">{g.title}</h2>
              <div className="space-y-3">
                {items.map((s) => (
                  <Block key={s.id} s={s} focused={s.id === focusSection} links={xref(s.id)} onXref={onGo}>
                    {source(s)}
                  </Block>
                ))}
              </div>
            </section>
          );
        })}

        <Related topic={topic} onGo={onGo} />
      </article>
    </div>
  );
}

/** Other pages whose notes link to this topic, and the words they use for it. */
function Related({ topic, onGo }: { topic: NoteTopic; onGo: (topicId: string) => void }) {
  const related = topic.related ?? [];
  return (
    <section className="mt-14 border-t border-line pt-8">
      <h2 className="mb-1 font-serif text-[21px] font-semibold">Related</h2>
      <p className="mb-4 text-[13px] text-muted">
        {related.length ? "Pages whose notes link here." : "No other pages link here yet. Links appear when other notes use this topic's terms."}
      </p>
      {related.length ? (
        <ul className="space-y-2">
          {related.map((r) => (
            <li key={r.topicId}>
              <button onClick={() => onGo(r.topicId)} className="card flex w-full items-baseline justify-between gap-4 px-5 py-3 text-left transition-shadow duration-150 hover:shadow-card">
                <span className="min-w-0">
                  <span className="block truncate font-serif text-[17px] font-semibold">{r.title}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">mentions {r.terms.map((t) => `“${t}”`).join(", ")}</span>
                </span>
                {r.courseName !== topic.courseName ? <span className="chip shrink-0 text-muted">{r.courseName}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One section, styled by kind: definitions in a highlighted box, theorems/examples in cards, mistakes tinted. */
function Block({
  s,
  focused,
  links,
  onXref,
  children,
}: {
  s: Section;
  focused: boolean;
  links?: NonNullable<NoteTopic["xrefs"]>[string];
  onXref: (topicId: string, sectionId?: string) => void;
  children: ReactNode;
}) {
  const body = <Rich text={applyXrefs(notesMarkdown(s.body), links)} onXref={onXref} className="font-serif text-[16px]" />;
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
      {section.cloud ? <CloudTag className="ml-2" /> : null}
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

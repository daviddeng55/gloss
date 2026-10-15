// "Find it": search everything Gloss has read on your screen. Drops down from the menu bar icon.
// Type what you remember; click a result (or use ↑ ↓ and Return) to see the whole passage.
import { useEffect, useRef, useState } from "react";
import type { FoundMoment } from "../../shared/types.ts";
import { splitMatches } from "../../shared/search.ts";
import { dateFmt, timeFmt } from "./format.ts";

/** Text with the matching words highlighted. */
function Marked({ text }: { text: string }) {
  return (
    <>
      {splitMatches(text).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-accent-strong">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function When({ at }: { at: string }) {
  const d = new Date(at);
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums">
      {dateFmt.format(d)}, {timeFmt.format(d)}
    </span>
  );
}

export default function Find() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundMoment[]>([]);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<{ moment: FoundMoment; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const latest = useRef(0); // only the newest search's results are shown

  // Each time the window drops down, put the cursor back in the search box (your last search stays).
  useEffect(
    () =>
      window.api.onState(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }),
    [],
  );

  useEffect(() => {
    const n = ++latest.current;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    void window.api.find(query).then((r) => {
      if (n !== latest.current) return;
      setResults(r);
      setSelected(0);
    });
  }, [query]);

  async function show(moment: FoundMoment) {
    const text = (await window.api.foundText(moment.chunkId, query)) ?? "This passage has been deleted.";
    setOpen({ moment, text });
  }

  function back() {
    setOpen(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // In the full passage, scroll to the first match.
  useEffect(() => {
    if (open) detailRef.current?.querySelector("mark")?.scrollIntoView({ block: "center" });
  }, [open]);

  // Keep the chosen result in view while moving with the arrow keys.
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (open) back();
        else void window.api.closeWindow();
      } else if (!open && e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, results.length - 1));
      } else if (!open && e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (!open && e.key === "Enter" && results[selected]) {
        void show(results[selected]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (open) {
    const m = open.moment;
    return (
      <div className="flex h-screen flex-col text-[13px] text-ink">
        <div className="flex flex-col gap-1 border-b border-line px-4 pt-3 pb-2.5">
          <button type="button" onClick={back} className="self-start font-medium text-accent hover:text-accent-strong">
            ← Results
          </button>
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="truncate text-[14px] font-semibold">
              <Marked text={m.sourceTitle} />
            </h1>
            <span className="text-[11px] text-muted">
              <When at={m.capturedAt} />
            </span>
          </div>
          <p className="text-[11px] text-muted">
            {m.courseName} · {m.sourceApp}
          </p>
        </div>
        <div ref={detailRef} className="selectable flex-1 overflow-y-auto px-4 py-3 font-serif text-[14px] leading-relaxed whitespace-pre-wrap">
          <Marked text={open.text} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col text-[13px] text-ink">
      <div className="p-3 pb-2">
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find it: what do you remember seeing?"
          aria-label="Search everything Gloss has read"
          className="selectable w-full rounded-xl border border-line bg-card/80 px-3 py-2 text-[14px] outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </div>

      {!query.trim() ? (
        <p className="px-4 pt-2 text-muted">
          Search everything Gloss has read on your screen, e.g. <i>strong induction</i>. Nothing leaves your Mac.
        </p>
      ) : results.length === 0 ? (
        <p className="px-4 pt-2 text-muted">Nothing found for “{query.trim()}”.</p>
      ) : (
        <>
          <p className="px-4 pb-1 text-[11px] text-muted">
            {results.length === 50 ? "Top 50 matches" : `${results.length} ${results.length === 1 ? "match" : "matches"}`}
          </p>
          <ul ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2">
            {results.map((m, i) => (
              <li key={m.chunkId}>
                <button
                  type="button"
                  data-result
                  onClick={() => void show(m)}
                  onMouseMove={() => setSelected(i)}
                  className={`flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left ${i === selected ? "bg-accent-soft/60" : ""}`}
                >
                  <span className="flex items-baseline justify-between gap-3 text-[11px] text-muted">
                    <span className="truncate">
                      <span className="font-medium text-ink">{m.courseName}</span> · {m.sourceApp} — <Marked text={m.sourceTitle} />
                    </span>
                    <When at={m.capturedAt} />
                  </span>
                  <span className="line-clamp-3 font-serif text-[13px] leading-snug">
                    <Marked text={m.snippet} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

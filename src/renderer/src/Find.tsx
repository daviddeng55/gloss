// "Find it": search everything Gloss has read on your screen. Shown inside the popover (Popover.tsx):
// type what you remember; click a result (or use ↑ ↓ and Return) to see the whole passage.
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
          <mark key={i} className="rounded-[3px] bg-accent-soft px-0.5 text-ink">
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

export type Found = { moment: FoundMoment; text: string };

/** Fetches a result's whole passage, with the matches marked. */
export async function openFound(moment: FoundMoment, query: string): Promise<Found> {
  return { moment, text: (await window.api.foundText(moment.chunkId, query)) ?? "This passage has been deleted." };
}

/** The results for `query`. ↑ ↓ choose and Return opens, while the search box has the cursor. */
export function FindResults({ query, onOpen }: { query: string; onOpen: (m: FoundMoment) => void }) {
  const [results, setResults] = useState<FoundMoment[]>([]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const latest = useRef(0); // only the newest search's results are shown

  useEffect(() => {
    const n = ++latest.current;
    void window.api.find(query).then((r) => {
      if (n !== latest.current) return;
      setResults(r);
      setSelected(0);
    });
  }, [query]);

  // Keep the chosen result in view while moving with the arrow keys.
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter" && results[selected]) {
        onOpen(results[selected]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!results.length)
    return (
      <div className="appear px-4 pt-6 text-center">
        <p className="font-serif text-[15px]">Nothing found for “{query.trim()}”</p>
        <p className="mt-1 text-[12px] text-muted">Try fewer or different words — every word has to appear.</p>
      </div>
    );
  return (
    <>
      <p className="eyebrow px-4 pt-3 pb-2">
        {results.length === 50 ? "Top 50 matches" : `${results.length} ${results.length === 1 ? "match" : "matches"}`}
      </p>
      <ul ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2">
        {results.map((m, i) => (
          <li key={m.chunkId}>
            <button
              type="button"
              data-result
              onClick={() => onOpen(m)}
              onMouseMove={() => setSelected(i)}
              className={`flex w-full flex-col gap-1 rounded-lg px-2 py-2 text-left transition-colors duration-150 ${i === selected ? "bg-hover" : ""}`}
            >
              <span className="flex items-baseline justify-between gap-3 text-[11px] text-muted">
                <span className="truncate">
                  <span className="font-medium text-ink">{m.courseName}</span> · <Marked text={m.sourceTitle} />
                </span>
                <When at={m.capturedAt} />
              </span>
              <span className="line-clamp-2 font-serif text-[13.5px] leading-snug">
                <Marked text={m.snippet} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One result's whole captured passage, scrolled to the first match. */
export function FindDetail({ found, onBack }: { found: Found; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const m = found.moment;
  useEffect(() => {
    ref.current?.querySelector("mark")?.scrollIntoView({ block: "center" });
  }, [found]);
  return (
    <div className="appear flex h-screen flex-col text-[13px] text-ink">
      <div className="flex flex-col gap-1 border-b border-line px-4 pt-3 pb-3">
        <button type="button" onClick={onBack} className="btn-ghost -ml-3 h-7 self-start px-3">
          ← Back
        </button>
        <h1 className="truncate font-serif text-[16px] font-semibold">
          <Marked text={m.sourceTitle} />
        </h1>
        <p className="flex justify-between gap-3 text-[11px] text-muted">
          <span className="truncate">
            {m.courseName} · {m.sourceApp}
          </span>
          <When at={m.capturedAt} />
        </p>
      </div>
      <div ref={ref} className="selectable flex-1 overflow-y-auto px-4 py-4 font-serif text-[15px] leading-relaxed whitespace-pre-wrap">
        <Marked text={found.text} />
      </div>
    </div>
  );
}

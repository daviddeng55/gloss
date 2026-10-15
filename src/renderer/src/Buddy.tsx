// The four Study Buddy characters, drawn as small SVGs and animated with CSS (index.css, ".buddy"):
// a gentle idle bob and blinking; a curious head tilt when asking; a happy bounce; a puzzled tilt with
// a "?" when an answer has a gap; thinking dots while the AI reads your answer.
import type { BuddyCharacterId, BuddyMoodId } from "../../shared/types.ts";

type Pt = { x: number; y: number };

/** Eyes for a mood. `tall` = cat eyes (upright ovals). */
function Eyes({ l, r, mood, tall }: { l: Pt; r: Pt; mood: BuddyMoodId; tall?: boolean }) {
  if (mood === "happy" || mood === "thanks") {
    return (
      <g fill="none" stroke="var(--buddy-ink)" strokeWidth={2.2} strokeLinecap="round">
        <path d={`M${l.x - 3.2} ${l.y + 1.2} Q${l.x} ${l.y - 3.2} ${l.x + 3.2} ${l.y + 1.2}`} />
        <path d={`M${r.x - 3.2} ${r.y + 1.2} Q${r.x} ${r.y - 3.2} ${r.x + 3.2} ${r.y + 1.2}`} />
      </g>
    );
  }
  const eye = (p: Pt, small = false) =>
    tall ? (
      <ellipse className="b-eye" cx={p.x} cy={p.y} rx={small ? 1.8 : 2.4} ry={small ? 2.6 : 3.5} fill="var(--buddy-ink)" />
    ) : (
      <ellipse className="b-eye" cx={p.x} cy={p.y} rx={small ? 2 : 2.7} ry={small ? 2 : 2.9} fill="var(--buddy-ink)" />
    );
  if (mood === "confused") {
    return (
      <g>
        {eye(l)}
        {eye(r, true)}
        <path d={`M${l.x - 4} ${l.y - 6.5} L${l.x + 3} ${l.y - 8.5}`} stroke="var(--buddy-ink)" strokeWidth={1.8} strokeLinecap="round" />
      </g>
    );
  }
  return (
    <g>
      {eye(l)}
      {eye(r)}
      {/* a tiny highlight makes the eyes look alive */}
      <circle cx={l.x + 0.9} cy={l.y - 1.1} r={0.8} fill="var(--buddy-shine)" />
      <circle cx={r.x + 0.9} cy={r.y - 1.1} r={0.8} fill="var(--buddy-shine)" />
    </g>
  );
}

function Mouth({ at, mood }: { at: Pt; mood: BuddyMoodId }) {
  const { x, y } = at;
  const line = { fill: "none", stroke: "var(--buddy-ink)", strokeWidth: 1.8, strokeLinecap: "round" as const };
  if (mood === "happy" || mood === "thanks") return <path d={`M${x - 4.5} ${y - 0.5} Q${x} ${y + 6} ${x + 4.5} ${y - 0.5} Z`} fill="var(--buddy-ink)" />;
  if (mood === "confused") return <path d={`M${x - 3.5} ${y + 1} q1.75 -1.8 3.5 0 q1.75 1.8 3.5 0`} {...line} />;
  if (mood === "thinking") return <circle cx={x} cy={y + 1} r={1.4} fill="var(--buddy-ink)" />;
  return <path d={`M${x - 3.5} ${y} Q${x} ${y + 3} ${x + 3.5} ${y}`} {...line} />;
}

function Cheeks({ l, r }: { l: Pt; r: Pt }) {
  return (
    <g fill="var(--buddy-blush)">
      <ellipse cx={l.x} cy={l.y} rx={3.4} ry={2.2} />
      <ellipse cx={r.x} cy={r.y} rx={3.4} ry={2.2} />
    </g>
  );
}

/** Little extras above the head that show the mood. */
function MoodMark({ mood }: { mood: BuddyMoodId }) {
  if (mood === "thinking") {
    return (
      <g fill="var(--muted)">
        <circle className="b-dot" cx={50} cy={12} r={2.4} />
        <circle className="b-dot" cx={60} cy={12} r={2.4} />
        <circle className="b-dot" cx={70} cy={12} r={2.4} />
      </g>
    );
  }
  if (mood === "confused") {
    return (
      <text className="b-float" x={90} y={30} fontSize={20} fontWeight={600} fill="var(--muted)" fontFamily="var(--font-serif)">
        ?
      </text>
    );
  }
  if (mood === "happy") {
    const star = (x: number, y: number, s: number) => `M${x} ${y - s} Q${x} ${y} ${x + s} ${y} Q${x} ${y} ${x} ${y + s} Q${x} ${y} ${x - s} ${y} Q${x} ${y} ${x} ${y - s} Z`;
    return (
      <g fill="var(--buddy-spark)">
        <path className="b-twinkle" d={star(24, 30, 6)} />
        <path className="b-twinkle b-late" d={star(96, 22, 5)} />
      </g>
    );
  }
  if (mood === "thanks") {
    return <path className="b-float" d="M92 30 c-3 -3 -8 -1 -6 3 l6 6 l6 -6 c2 -4 -3 -6 -6 -3 Z" fill="var(--buddy-heart)" />;
  }
  return null;
}

function Dog({ mood }: { mood: BuddyMoodId }) {
  return (
    <>
      <path className="b-wag" d="M78 100 Q93 95 91 82" fill="none" stroke="var(--buddy-dog-dark)" strokeWidth={5} strokeLinecap="round" />
      <rect x={40} y={78} width={40} height={34} rx={17} fill="var(--buddy-dog)" />
      <ellipse cx={60} cy={97} rx={11} ry={10} fill="var(--buddy-belly)" />
      <g className="b-head">
        <circle cx={60} cy={52} r={24} fill="var(--buddy-dog)" />
        <path d="M41 35 C29 37 27 57 34 63 C39 65 42 56 43 46 Z" fill="var(--buddy-dog-dark)" />
        <path d="M79 35 C91 37 93 57 86 63 C81 65 78 56 77 46 Z" fill="var(--buddy-dog-dark)" />
        <ellipse cx={69} cy={48} rx={7.5} ry={6.5} fill="var(--buddy-dog-dark)" opacity={0.45} />
        <Cheeks l={{ x: 46, y: 59 }} r={{ x: 74, y: 59 }} />
        <Eyes l={{ x: 52, y: 49 }} r={{ x: 68, y: 49 }} mood={mood} />
        <ellipse cx={60} cy={57} rx={3.8} ry={2.7} fill="var(--buddy-ink)" />
        <Mouth at={{ x: 60, y: 62 }} mood={mood} />
      </g>
    </>
  );
}

function Cat({ mood }: { mood: BuddyMoodId }) {
  return (
    <>
      <path className="b-wag" d="M77 104 C96 104 98 86 89 79" fill="none" stroke="var(--buddy-cat)" strokeWidth={6} strokeLinecap="round" />
      <rect x={41} y={78} width={38} height={34} rx={17} fill="var(--buddy-cat)" />
      <ellipse cx={60} cy={98} rx={10} ry={9} fill="var(--buddy-belly)" />
      <g className="b-head">
        <path d="M38 46 L40 23 L56 36 Z" fill="var(--buddy-cat)" stroke="var(--buddy-cat)" strokeWidth={4} strokeLinejoin="round" />
        <path d="M82 46 L80 23 L64 36 Z" fill="var(--buddy-cat)" stroke="var(--buddy-cat)" strokeWidth={4} strokeLinejoin="round" />
        <path d="M42 39 L43 29 L50 35 Z" fill="var(--buddy-blush)" />
        <path d="M78 39 L77 29 L70 35 Z" fill="var(--buddy-blush)" />
        <ellipse cx={60} cy={54} rx={25} ry={21} fill="var(--buddy-cat)" />
        <path d="M54 35 L56 41 M60 34 L60 40 M66 35 L64 41" stroke="var(--buddy-cat-dark)" strokeWidth={1.8} strokeLinecap="round" />
        <Cheeks l={{ x: 46, y: 60 }} r={{ x: 74, y: 60 }} />
        <Eyes l={{ x: 51, y: 52 }} r={{ x: 69, y: 52 }} mood={mood} tall />
        <path d="M57.5 58.5 L62.5 58.5 L60 61.3 Z" fill="var(--buddy-nose)" />
        <g stroke="var(--muted)" strokeWidth={1.1} strokeLinecap="round" opacity={0.8}>
          <path d="M43 58 L32 56 M43 61.5 L32 62.5" />
          <path d="M77 58 L88 56 M77 61.5 L88 62.5" />
        </g>
        {mood === "happy" || mood === "thanks" || mood === "thinking" || mood === "confused" ? (
          <Mouth at={{ x: 60, y: 64 }} mood={mood} />
        ) : (
          <path d="M56 63 Q58 65.5 60 63 Q62 65.5 64 63" fill="none" stroke="var(--buddy-ink)" strokeWidth={1.6} strokeLinecap="round" />
        )}
      </g>
    </>
  );
}

function Penguin({ mood }: { mood: BuddyMoodId }) {
  return (
    <>
      <ellipse cx={52} cy={112} rx={6.5} ry={2.6} fill="var(--buddy-beak)" />
      <ellipse cx={68} cy={112} rx={6.5} ry={2.6} fill="var(--buddy-beak)" />
      <path d="M34 70 C23 80 24 93 30 99 C34 93 36 83 37 75 Z" fill="var(--buddy-penguin)" />
      <path d="M86 70 C97 80 96 93 90 99 C86 93 84 83 83 75 Z" fill="var(--buddy-penguin)" />
      <path d="M60 22 C80 22 87 50 87 76 C87 100 76 112 60 112 C44 112 33 100 33 76 C33 50 40 22 60 22 Z" fill="var(--buddy-penguin)" />
      <ellipse cx={60} cy={91} rx={18} ry={19} fill="var(--buddy-belly-strong)" />
      <g className="b-head">
        <path d="M60 39 C52 31 39 37 41 51 C42 62 51 66 60 63 C69 66 78 62 79 51 C81 37 68 31 60 39 Z" fill="var(--buddy-belly-strong)" />
        <Cheeks l={{ x: 47, y: 57 }} r={{ x: 73, y: 57 }} />
        <Eyes l={{ x: 53, y: 49 }} r={{ x: 67, y: 49 }} mood={mood} />
        {mood === "happy" || mood === "thanks" ? (
          <path d="M55.5 55.5 L64.5 55.5 L60 61.5 Z M57 59.5 L63 59.5" fill="var(--buddy-beak)" stroke="var(--buddy-beak-dark)" strokeWidth={0.8} />
        ) : (
          <path d="M55.5 55.5 L64.5 55.5 L60 60.5 Z" fill="var(--buddy-beak)" />
        )}
      </g>
      {/* a small bow tie: polite and a little formal */}
      <path d="M52 68 L60 71.5 L52 75 Z M68 68 L60 71.5 L68 75 Z" fill="var(--buddy-tie)" strokeLinejoin="round" />
      <circle cx={60} cy={71.5} r={1.9} fill="var(--buddy-tie)" />
    </>
  );
}

function Birdie({ mood }: { mood: BuddyMoodId }) {
  return (
    <>
      <g stroke="var(--buddy-beak)" strokeWidth={2} strokeLinecap="round">
        <path d="M54 103 L54 111 M51 111 L57 111" />
        <path d="M66 103 L66 111 M63 111 L69 111" />
      </g>
      <circle cx={60} cy={74} r={30} fill="var(--buddy-bird)" />
      <ellipse cx={60} cy={86} rx={18} ry={14} fill="var(--buddy-belly)" opacity={0.75} />
      <path className="b-flap" d="M33 76 C28 88 37 99 48 94 C44 88 42 81 33 76 Z" fill="var(--buddy-bird-dark)" />
      <path className="b-flap b-right" d="M87 76 C92 88 83 99 72 94 C76 88 78 81 87 76 Z" fill="var(--buddy-bird-dark)" />
      <g className="b-head">
        <path d="M59 45 C55 40 53 34 56 30 C60 33 61 39 59 45 Z M61 45 C63 39 67 35 71 35 C70 40 66 43 61 45 Z" fill="var(--buddy-bird-dark)" />
        <Cheeks l={{ x: 45, y: 75 }} r={{ x: 75, y: 75 }} />
        <Eyes l={{ x: 51, y: 67 }} r={{ x: 69, y: 67 }} mood={mood} />
        {mood === "happy" || mood === "thanks" ? (
          <path d="M56 73 L64 73 L60 76 Z M56.5 77 L63.5 77 L60 80 Z" fill="var(--buddy-beak)" />
        ) : (
          <path d="M56 73 L64 73 L60 78.5 Z" fill="var(--buddy-beak)" />
        )}
      </g>
    </>
  );
}

const BODIES: Record<BuddyCharacterId, (p: { mood: BuddyMoodId }) => React.JSX.Element> = { dog: Dog, cat: Cat, penguin: Penguin, birdie: Birdie };

/** One buddy, animated for its mood. */
export function BuddyFigure({ character, mood = "idle", size = 120, className = "" }: { character: BuddyCharacterId; mood?: BuddyMoodId; size?: number; className?: string }) {
  const Body = BODIES[character];
  return (
    <svg className={`buddy ${className}`} data-mood={mood} data-character={character} viewBox="0 0 120 120" width={size} height={size} aria-hidden>
      <ellipse className="b-shadow" cx={60} cy={113} rx={25} ry={3.5} fill="var(--ink)" opacity={0.08} />
      <g className="b-body">
        <Body mood={mood} />
      </g>
      <MoodMark mood={mood} />
    </svg>
  );
}

export const CHARACTERS: { id: BuddyCharacterId; label: string; defaultName: string; blurb: string }[] = [
  { id: "dog", label: "Dog", defaultName: "Biscuit", blurb: "Eager and warm" },
  { id: "cat", label: "Cat", defaultName: "Miso", blurb: "Calm and quietly curious" },
  { id: "penguin", label: "Penguin", defaultName: "Pip", blurb: "Polite and earnest" },
  { id: "birdie", label: "Birdie", defaultName: "Wren", blurb: "Chirpy and playful" },
];

/** Four animated cards to pick from, plus a name field. Used on first launch and in Settings. */
export function BuddyChooser({
  character,
  name,
  onChange,
}: {
  character: BuddyCharacterId | "";
  name: string;
  onChange: (c: { character: BuddyCharacterId; name: string }) => void;
}) {
  const chosen = CHARACTERS.find((c) => c.id === character);
  return (
    <div>
      <div className="grid grid-cols-4 gap-3" role="radiogroup" aria-label="Choose a buddy">
        {CHARACTERS.map((c) => {
          const on = c.id === character;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-buddy={c.id}
              onClick={() => onChange({ character: c.id, name })}
              className={`flex flex-col items-center rounded-2xl border px-2 pt-3 pb-3 transition-colors duration-150 ${
                on ? "border-accent/50 bg-accent-soft" : "border-line bg-card hover:bg-hover"
              }`}
            >
              <BuddyFigure character={c.id} mood={on ? "happy" : "idle"} size={96} />
              <span className="mt-1 text-[14px] font-semibold">{c.label}</span>
              <span className="text-[12px] leading-snug text-muted">{c.blurb}</span>
            </button>
          );
        })}
      </div>
      <label className="mt-5 flex items-center gap-3">
        <span className="font-medium">Name</span>
        <input
          value={name}
          maxLength={24}
          placeholder={chosen?.defaultName ?? "Pick a buddy first"}
          disabled={!chosen}
          onChange={(e) => chosen && onChange({ character: chosen.id, name: e.target.value })}
          className="field selectable h-8 w-56 py-1"
        />
      </label>
    </div>
  );
}

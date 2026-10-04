// The transparent layer shown while circling: draws the cursor's path and a short hint.
import { useEffect, useRef, useState } from "react";

export default function Overlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [label, setLabel] = useState("⌥A");
  const [last, setLast] = useState<{ x: number; y: number } | null>(null);
  const [voice, setVoice] = useState<{ state: "listening" | "off" | "unavailable" | "starting"; message?: string }>({ state: "off" });
  const [heard, setHeard] = useState("");
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void window.api.closeWindow();
    window.addEventListener("keydown", onKey);
    const off = window.api.onOverlay((e) => {
      if (e.type === "voice") return setVoice({ state: e.state, message: e.message });
      if (e.type === "speech") return setHeard(e.text);
      if (e.type === "level") return setLevel(e.value);
      const c = canvas.current;
      if (!c) return;
      const ctx = c.getContext("2d")!;
      const dpr = window.devicePixelRatio || 1;
      // Match the canvas to the window (it can change display between uses).
      if (c.width !== Math.round(window.innerWidth * dpr) || c.height !== Math.round(window.innerHeight * dpr)) {
        c.width = Math.round(window.innerWidth * dpr);
        c.height = Math.round(window.innerHeight * dpr);
      }
      if (e.type === "start") {
        setLabel(e.shortcutLabel);
        setVoice({ state: "starting" });
        setHeard("");
        setLevel(0);
        ctx.clearRect(0, 0, c.width, c.height);
        setLast(null);
        return;
      }
      if (e.type === "end") {
        ctx.clearRect(0, 0, c.width, c.height);
        setLast(null);
        return;
      }
      // Redraw the whole path: a soft glow under a solid terracotta line.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const pts = e.points;
      if (pts.length > 1) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const [width, color] of [[12, "rgba(224,121,79,0.25)"], [4, "rgba(224,121,79,0.95)"]] as const) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.lineWidth = width;
          ctx.strokeStyle = color;
          ctx.stroke();
        }
      }
      setLast(pts[pts.length - 1] ?? null);
    });
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="fixed inset-0 cursor-crosshair" onMouseDown={() => void window.api.overlayClick()}>
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" />
      {last ? (
        <div
          className="pointer-events-none absolute rounded-full bg-ink/85 px-3 py-1 text-[12px] font-medium whitespace-nowrap text-paper shadow-lg"
          // Keep the hint on screen: flip it to the left/top of the cursor near the edges.
          style={{
            ...(last.x > window.innerWidth - 380 ? { right: window.innerWidth - last.x + 18 } : { left: last.x + 18 }),
            ...(last.y > window.innerHeight - 60 ? { bottom: window.innerHeight - last.y + 18 } : { top: last.y + 18 }),
          }}
        >
          Circle it · {label} or click to ask · Esc to cancel
        </div>
      ) : null}
      <VoicePanel voice={voice} heard={heard} level={level} />
    </div>
  );
}

/** Top-centre card: whether the microphone is on, how loud it hears you, and the words so far. */
function VoicePanel(props: {
  voice: { state: "listening" | "off" | "unavailable" | "starting"; message?: string };
  heard: string;
  level: number;
}) {
  const { voice, heard, level } = props;
  if (voice.state === "off") return null;
  const listening = voice.state === "listening";
  return (
    <div className="pointer-events-none absolute top-10 left-1/2 w-[min(560px,80vw)] -translate-x-1/2 rounded-2xl bg-ink/85 px-4 py-3 text-paper shadow-2xl">
      <div className="flex items-center gap-3">
        <span className={`relative flex size-7 items-center justify-center rounded-full ${listening ? "bg-red-500" : "bg-white/20"}`}>
          {listening ? <span className="absolute inset-0 animate-ping rounded-full bg-red-500/60" /> : null}
          <svg viewBox="0 0 24 24" className="relative size-4 fill-white" aria-hidden>
            <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
          </svg>
        </span>
        <span className="text-[13px] font-semibold">
          {listening ? "Listening — ask your question" : voice.state === "starting" ? "Starting microphone…" : "Voice unavailable"}
        </span>
        {listening ? (
          <span className="ml-auto flex h-4 items-end gap-0.5" aria-hidden>
            {[0.3, 0.6, 1, 0.6, 0.3].map((w, i) => (
              <span key={i} className="w-1 rounded-sm bg-red-400" style={{ height: `${Math.max(15, Math.min(100, level * w * 100))}%` }} />
            ))}
          </span>
        ) : null}
      </div>
      {voice.state === "unavailable" ? (
        <p className="mt-1 text-[12px] text-paper/80">{voice.message} You can type your question instead.</p>
      ) : heard ? (
        <p className="mt-2 font-serif text-[16px] leading-snug">{heard}</p>
      ) : null}
    </div>
  );
}

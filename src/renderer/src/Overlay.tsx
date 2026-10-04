// The transparent layer shown while circling: draws the cursor's path and a short hint.
import { useEffect, useRef, useState } from "react";

export default function Overlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [label, setLabel] = useState("⌥A");
  const [last, setLast] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void window.api.closeWindow();
    window.addEventListener("keydown", onKey);
    const off = window.api.onOverlay((e) => {
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
    </div>
  );
}

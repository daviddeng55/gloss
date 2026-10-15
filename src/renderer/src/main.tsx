import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Ask from "./Ask.tsx";
import History from "./History.tsx";
import Learn from "./Learn.tsx";
import Settings from "./Settings.tsx";
import Warmup from "./Warmup.tsx";
import Overlay from "./Overlay.tsx";
import Review from "./Review.tsx";
import Popover from "./Popover.tsx";
import "./index.css";

// One page, several screens: #/popover (menu bar), #/history, #/review/<session>[/summary|quiz], #/overlay, #/ask/<ask>.
const [route, param, extra] = location.hash.replace(/^#\/?/, "").split("/");
document.body.className = ["popover", "overlay", "ask"].includes(route) ? "bg-transparent" : "bg-paper";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route === "popover" ? (
      <Popover />
    ) : route === "overlay" ? (
      <Overlay />
    ) : route === "ask" && param ? (
      <Ask askId={param} />
    ) : route === "settings" ? (
      <Settings />
    ) : route === "learn" ? (
      <Learn />
    ) : route === "warmup" && param ? (
      <Warmup sessionId={param} />
    ) : route === "review" && param ? (
      <Review sessionId={param} section={extra === "summary" || extra === "quiz" ? extra : undefined} />
    ) : (
      <History />
    )}
  </StrictMode>,
);

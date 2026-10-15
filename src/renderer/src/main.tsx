import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Ask from "./Ask.tsx";
import Library from "./Notes.tsx";
import Learn from "./Learn.tsx";
import Settings from "./Settings.tsx";
import Warmup from "./Warmup.tsx";
import Overlay from "./Overlay.tsx";
import Review from "./Review.tsx";
import Popover from "./Popover.tsx";
import "./index.css";

// One page, several screens: #/popover (menu bar), #/history[/<topic>[/<section>]] (Notes + All captures),
// #/review/<session>[/summary|quiz], #/overlay, #/ask/<ask>.
const [route, param, extra] = location.hash.replace(/^#\/?/, "").split("/");
// A window reused for another screen (e.g. the review window opened again at the quiz) only changes the
// hash, which doesn't reload the page: reload so the new screen shows.
window.addEventListener("hashchange", () => location.reload());
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
      <Library topicId={param} sectionId={extra} />
    )}
  </StrictMode>,
);

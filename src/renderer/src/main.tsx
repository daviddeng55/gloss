import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Ask from "./Ask.tsx";
import History from "./History.tsx";
import Overlay from "./Overlay.tsx";
import Review from "./Review.tsx";
import StartPopup from "./StartPopup.tsx";
import "./index.css";

// One page, several screens: #/start (menu bar popup), #/history, #/review/<session>, #/overlay, #/ask/<ask>.
const [route, param] = location.hash.replace(/^#\/?/, "").split("/");
document.body.className = ["start", "overlay", "ask"].includes(route) ? "bg-transparent" : "bg-paper";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route === "start" ? (
      <StartPopup />
    ) : route === "overlay" ? (
      <Overlay />
    ) : route === "ask" && param ? (
      <Ask askId={param} />
    ) : route === "review" && param ? (
      <Review sessionId={param} />
    ) : (
      <History />
    )}
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import History from "./History.tsx";
import Review from "./Review.tsx";
import StartPopup from "./StartPopup.tsx";
import "./index.css";

// One page, three screens: #/start (the menu bar popup), #/history and #/review/<session id>.
const [route, param] = location.hash.replace(/^#\/?/, "").split("/");
document.body.className = route === "start" ? "bg-transparent" : "bg-white dark:bg-neutral-900";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {route === "start" ? <StartPopup /> : route === "review" && param ? <Review sessionId={param} /> : <History />}
  </StrictMode>,
);

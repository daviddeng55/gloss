import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import History from "./History.tsx";
import StartPopup from "./StartPopup.tsx";
import "./index.css";

// One page, two screens: #/start (the menu bar popup) and #/history.
const route = location.hash.replace(/^#\/?/, "");
document.body.className = route === "start" ? "bg-transparent" : "bg-white dark:bg-neutral-900";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{route === "start" ? <StartPopup /> : <History />}</StrictMode>,
);

// The only bridge between the windows and the main process. Windows get `window.api` and
// nothing else: no file system or Node access.
import { contextBridge, ipcRenderer } from "electron";
import type { AppState, AskEvent, BuddyView, OverlayEvent, PopoverView, StudyApi } from "../shared/types.ts";

const api: StudyApi = {
  getCourses: () => ipcRenderer.invoke("courses:list"),
  getState: () => ipcRenderer.invoke("state:get"),
  startSession: (courseId, goal) => ipcRenderer.invoke("session:start", courseId, goal),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSession: (id) => ipcRenderer.invoke("sessions:get", id),
  openScreenRecordingSettings: () => ipcRenderer.invoke("settings:screen-recording"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  askInfo: (askId) => ipcRenderer.invoke("ask:info", askId),
  ask: (askId, question, level) => ipcRenderer.invoke("ask:send", askId, question, level),
  onAsk: (callback) => {
    const listener = (_e: unknown, ev: AskEvent) => callback(ev);
    ipcRenderer.on("ask:event", listener);
    return () => ipcRenderer.removeListener("ask:event", listener);
  },
  onOverlay: (callback) => {
    const listener = (_e: unknown, ev: OverlayEvent) => callback(ev);
    ipcRenderer.on("overlay:event", listener);
    return () => ipcRenderer.removeListener("overlay:event", listener);
  },
  overlayClick: () => ipcRenderer.invoke("overlay:click"),
  getLearnProfile: () => ipcRenderer.invoke("learn:profile"),
  markConcept: (id, known) => ipcRenderer.invoke("learn:mark", id, known),
  deleteConcept: (id) => ipcRenderer.invoke("learn:delete", id),
  deleteLearnerModel: (courseId) => ipcRenderer.invoke("learn:delete-course", courseId),
  openLearn: () => ipcRenderer.invoke("learn:open"),
  getWarmup: (sessionId) => ipcRenderer.invoke("warmup:get", sessionId),
  getReview: (sessionId) => ipcRenderer.invoke("review:get", sessionId),
  retryReview: (sessionId) => ipcRenderer.invoke("review:retry", sessionId),
  answerQuestion: (itemId, response) => ipcRenderer.invoke("quiz:answer", itemId, response),
  openReview: (sessionId, section) => ipcRenderer.invoke("review:open", sessionId, section),
  redoReview: (sessionId) => ipcRenderer.invoke("review:redo", sessionId),
  deletePassage: (chunkId) => ipcRenderer.invoke("chunks:delete", chunkId),
  deleteSession: (sessionId) => ipcRenderer.invoke("sessions:delete", sessionId),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  openSettings: () => ipcRenderer.invoke("settings:open"),
  pauseSession: () => ipcRenderer.invoke("session:pause"),
  resumeSession: () => ipcRenderer.invoke("session:resume"),
  endSession: () => ipcRenderer.invoke("session:end"),
  openHistory: () => ipcRenderer.invoke("history:open"),
  quit: () => ipcRenderer.invoke("app:quit"),
  popoverView: () => ipcRenderer.invoke("popover:view"),
  onPopoverOpen: (callback) => {
    const listener = (_e: unknown, view: PopoverView) => callback(view);
    ipcRenderer.on("popover:open", listener);
    return () => ipcRenderer.removeListener("popover:open", listener);
  },
  getNoteTree: () => ipcRenderer.invoke("notes:tree"),
  getTopic: (id) => ipcRenderer.invoke("notes:topic", id),
  getCapture: (chunkId) => ipcRenderer.invoke("notes:capture", chunkId),
  deleteTopic: (id) => ipcRenderer.invoke("notes:delete-topic", id),
  openNotes: (topicId, sectionId) => ipcRenderer.invoke("notes:open", topicId, sectionId),
  onNotes: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("notes", listener);
    return () => ipcRenderer.removeListener("notes", listener);
  },
  find: (query) => ipcRenderer.invoke("find:search", query),
  foundText: (chunkId, query) => ipcRenderer.invoke("find:text", chunkId, query),
  deleteCourseData: (courseId) => ipcRenderer.invoke("courses:delete-data", courseId),
  onReview: (callback) => {
    const listener = (_e: unknown, sessionId: string) => callback(sessionId);
    ipcRenderer.on("review", listener);
    return () => ipcRenderer.removeListener("review", listener);
  },
  getBuddyView: () => ipcRenderer.invoke("buddy:view"),
  onBuddyView: (callback) => {
    const listener = (_e: unknown, view: BuddyView) => callback(view);
    ipcRenderer.on("buddy:view", listener);
    return () => ipcRenderer.removeListener("buddy:view", listener);
  },
  buddyAnswer: (text) => ipcRenderer.invoke("buddy:answer", text),
  buddyMic: () => ipcRenderer.invoke("buddy:mic"),
  buddyNotNow: () => ipcRenderer.invoke("buddy:not-now"),
  buddyPauseSession: () => ipcRenderer.invoke("buddy:pause"),
  getBuddySettings: () => ipcRenderer.invoke("buddy:settings"),
  chooseBuddy: (choice) => ipcRenderer.invoke("buddy:choose", choice),
  onState: (callback) => {
    const listener = (_e: unknown, state: AppState) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

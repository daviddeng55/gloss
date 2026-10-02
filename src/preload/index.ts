// The only bridge between the windows and the main process. Windows get `window.api` and
// nothing else: no file system or Node access.
import { contextBridge, ipcRenderer } from "electron";
import type { AppState, StudyApi } from "../shared/types.ts";

const api: StudyApi = {
  getCourses: () => ipcRenderer.invoke("courses:list"),
  getState: () => ipcRenderer.invoke("state:get"),
  startSession: (courseId, goal) => ipcRenderer.invoke("session:start", courseId, goal),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSession: (id) => ipcRenderer.invoke("sessions:get", id),
  openScreenRecordingSettings: () => ipcRenderer.invoke("settings:screen-recording"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  onState: (callback) => {
    const listener = (_e: unknown, state: AppState) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

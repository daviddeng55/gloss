import type { StudyApi } from "../../shared/types.ts";

declare global {
  interface Window {
    api: StudyApi;
  }
}

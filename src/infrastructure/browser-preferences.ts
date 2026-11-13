import type { ApplicationPreferences } from "../app/application-preferences";
import {
  loadPreflightDrafts,
  PREFLIGHT_DRAFTS_KEY,
} from "./preflight-draft-storage";

const SCHEDULE_DATE_KEY = "autoschedule.scheduleDate";
const SCHEDULE_ZOOM_KEY = "autoschedule.scheduleZoom";

export function createBrowserPreferences(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): ApplicationPreferences {
  return {
    loadPreflightDrafts: () => loadPreflightDrafts(storage),
    savePreflightDrafts: (drafts) =>
      storage.setItem(PREFLIGHT_DRAFTS_KEY, JSON.stringify(drafts)),
    loadScheduleDate: () => storage.getItem(SCHEDULE_DATE_KEY),
    saveScheduleDate: (date) => storage.setItem(SCHEDULE_DATE_KEY, date),
    loadScheduleZoom: () => {
      const value = Number(storage.getItem(SCHEDULE_ZOOM_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    saveScheduleZoom: (zoom) =>
      storage.setItem(SCHEDULE_ZOOM_KEY, String(zoom)),
  };
}

import type { PreflightDraft } from "./preflight-drafts";

export interface ApplicationPreferences {
  loadScheduleDate(): string | null;
  saveScheduleDate(date: string): void;
  loadScheduleZoom(): number | null;
  saveScheduleZoom(zoom: number): void;
  /** Optional for hosts without durable form preferences; session memory still works. */
  loadPreflightDrafts?(): PreflightDraft[];
  savePreflightDrafts?(drafts: PreflightDraft[]): void;
}

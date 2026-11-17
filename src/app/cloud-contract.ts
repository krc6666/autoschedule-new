import type { AppState, ScheduleGroupId } from "../model";
import type { AuditDetails, AuditPage } from "./operation-audit-contract";
import type { WorkspaceVersion } from "./workspace-version-contract";

export interface PublicScheduleRow {
  flightNo: string;
  position: string;
  staffName: string;
  startTime: string;
  endTime: string;
  remark: string;
  status: string;
}

export interface PublicSchedule {
  schemaVersion: 1;
  groupId: ScheduleGroupId;
  date: string;
  publishedAt: string;
  rows: PublicScheduleRow[];
}

export interface CloudPublication {
  token: string;
  snapshot: PublicSchedule;
}

/** Transient request feedback; never part of the saved scheduling model. */
export type CloudSaveFeedback =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; savedAt: number }
  | { phase: "failed"; kind: CloudError["kind"] | "unknown"; message: string };

export interface CloudBackend {
  currentUser(): Promise<string | null>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  onSignedOut(callback: () => void): () => void;
  load(): Promise<{ version: number; model: AppState | null }>;
  save(expectedVersion: number, model: AppState): Promise<number>;
  listAudit(beforeId?: string | null): Promise<AuditPage>;
  auditDetails(entryId: string, afterIndex?: number): Promise<AuditDetails>;
  listVersions(): Promise<WorkspaceVersion[]>;
  restoreVersion(
    expectedVersion: number,
    id: string
  ): Promise<{ version: number; model: AppState }>;
  publish(
    expectedVersion: number,
    groupId: ScheduleGroupId
  ): Promise<CloudPublication>;
  readPublication(token: string): Promise<PublicSchedule | null>;
}

export class CloudError extends Error {
  constructor(
    readonly kind: "conflict" | "unauthorized" | "unavailable" | "invalid",
    message: string
  ) {
    super(message);
  }
}

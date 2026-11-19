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

/** Server state only; not part of AppState or exported workspaces. */
export interface EditorLoginRequest {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  expiresAt: string;
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
  acquireSession(sessionId: string): Promise<void>;
  touchSession(sessionId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  requestSession(
    sessionId: string,
    requestId: string
  ): Promise<EditorLoginRequest>;
  pollSessionRequest(
    sessionId: string,
    requestId: string | null
  ): Promise<EditorLoginRequest | null>;
  decideSessionRequest(
    sessionId: string,
    requestId: string,
    allow: boolean
  ): Promise<void>;
  cancelSessionRequest(sessionId: string, requestId: string): Promise<void>;
  onSignedOut(callback: () => void): () => void;
  load(): Promise<{ version: number; model: AppState | null }>;
  save(
    expectedVersion: number,
    model: AppState,
    sessionId?: string
  ): Promise<number>;
  listAudit(beforeId?: string | null): Promise<AuditPage>;
  auditDetails(entryId: string, afterIndex?: number): Promise<AuditDetails>;
  listVersions(): Promise<WorkspaceVersion[]>;
  restoreVersion(
    expectedVersion: number,
    id: string,
    sessionId?: string
  ): Promise<{ version: number; model: AppState }>;
  publish(
    expectedVersion: number,
    groupId: ScheduleGroupId,
    sessionId?: string
  ): Promise<CloudPublication>;
  readPublication(token: string): Promise<PublicSchedule | null>;
}

export class CloudError extends Error {
  constructor(
    readonly kind:
      "conflict" | "unauthorized" | "unavailable" | "invalid" | "session",
    message: string
  ) {
    super(message);
  }
}

/** Independent server audit, deliberately excluded from AppState and workbook data. */
export interface AuditEntry {
  id: string;
  actor: string;
  occurredAt: string;
  version: number;
  changeCount: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export interface AuditChange {
  index: number;
  scope: "A" | "B" | "shared";
  area: string;
  key: string;
  operation: "add" | "update" | "delete";
  before: unknown;
  after: unknown;
}

export type AuditStaffLabels = Partial<
  Record<"before" | "after", Partial<Record<"A" | "B", Record<string, string>>>>
>;

export interface AuditDetails {
  changes: AuditChange[];
  staffLabels: AuditStaffLabels;
  nextCursor: number | null;
}

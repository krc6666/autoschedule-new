import { CloudError } from "../app/cloud-contract";
import type {
  AuditChange,
  AuditDetails,
  AuditEntry,
  AuditPage,
} from "../app/operation-audit-contract";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function invalid(): never {
  throw new CloudError(
    "invalid",
    "操作记录回执不完整，未显示不可靠内容，请重试。"
  );
}

export function parseAuditPage(value: unknown): AuditPage {
  if (
    !record(value) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 20 ||
    !(value.nextCursor === null || id(value.nextCursor))
  )
    return invalid();
  const entries: AuditEntry[] = value.entries.map((entry: unknown) => {
    if (
      !record(entry) ||
      !id(entry.id) ||
      typeof entry.actor !== "string" ||
      typeof entry.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(entry.occurredAt)) ||
      !positive(entry.version) ||
      !positive(entry.changeCount)
    )
      return invalid();
    return {
      id: entry.id,
      actor: entry.actor,
      occurredAt: entry.occurredAt,
      version: entry.version,
      changeCount: entry.changeCount,
    };
  });
  if (
    entries.some(
      (entry, index) =>
        index > 0 && BigInt(entry.id) >= BigInt(entries[index - 1]!.id)
    ) ||
    (value.nextCursor !== null && value.nextCursor !== entries.at(-1)?.id)
  )
    return invalid();
  return { entries, nextCursor: value.nextCursor };
}

export function parseAuditDetails(value: unknown): AuditDetails {
  if (
    !record(value) ||
    !Array.isArray(value.changes) ||
    value.changes.length > 50 ||
    !record(value.staffLabels) ||
    !(value.nextCursor === null || positive(value.nextCursor))
  )
    return invalid();
  const changes: AuditChange[] = value.changes.map((change: unknown) => {
    if (
      !record(change) ||
      !positive(change.index) ||
      (change.scope !== "A" &&
        change.scope !== "B" &&
        change.scope !== "shared") ||
      typeof change.area !== "string" ||
      typeof change.key !== "string" ||
      (change.operation !== "add" &&
        change.operation !== "update" &&
        change.operation !== "delete") ||
      !Object.hasOwn(change, "before") ||
      !Object.hasOwn(change, "after")
    )
      return invalid();
    return {
      index: change.index,
      scope: change.scope,
      area: change.area,
      key: change.key,
      operation: change.operation,
      before: change.before,
      after: change.after,
    };
  });
  if (
    changes.some(
      (change, index) => index > 0 && change.index <= changes[index - 1]!.index
    ) ||
    (value.nextCursor !== null && value.nextCursor !== changes.at(-1)?.index)
  )
    return invalid();
  const staffLabels: AuditDetails["staffLabels"] = {};
  for (const side of ["before", "after"] as const) {
    const groups = value.staffLabels[side];
    if (groups === undefined) continue;
    if (!record(groups)) return invalid();
    const labels: NonNullable<AuditDetails["staffLabels"][typeof side]> = {};
    for (const group of ["A", "B"] as const) {
      const names = groups[group];
      if (names === undefined) continue;
      if (
        !record(names) ||
        Object.values(names).some((name) => typeof name !== "string")
      )
        return invalid();
      labels[group] = Object.fromEntries(
        Object.entries(names).map(([key, name]) => [key, String(name)])
      );
    }
    staffLabels[side] = labels;
  }
  return { changes, nextCursor: value.nextCursor, staffLabels };
}

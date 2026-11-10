import type { LeaveType, Staff, StaffStatusSelection } from "../model";

export const BUILTIN_STAFF_STATUSES = ["正常", "病假", "休假"] as const;

export function leaveTypeNameError(
  name: string,
  types: readonly LeaveType[],
  id?: string
): string | null {
  const value = name.trim();
  if (!value) return "请输入休假类别名称";
  if (
    BUILTIN_STAFF_STATUSES.some((status) => status === value) ||
    types.some((item) => item.id !== id && item.name === value)
  )
    return "休假类别名称已存在，请换一个名称";
  return null;
}

export function normalizeLeaveTypes(value: unknown): LeaveType[] {
  if (!Array.isArray(value)) return [];
  const result: LeaveType[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.name !== "string" ||
      typeof item.enabled !== "boolean" ||
      result.some((entry) => entry.id === item.id) ||
      leaveTypeNameError(item.name, result)
    )
      continue;
    result.push({ id: item.id, name: item.name.trim(), enabled: item.enabled });
  }
  return result;
}

export function staffStatusValue(
  person: Pick<Staff, "status" | "leaveTypeId">
): StaffStatusSelection {
  return person.status === "休假" && person.leaveTypeId
    ? `leave:${person.leaveTypeId}`
    : person.status;
}

export function staffStatusLabel(
  person: Pick<Staff, "status" | "leaveTypeId">,
  types: readonly LeaveType[]
): string {
  if (person.status !== "休假" || !person.leaveTypeId) return person.status;
  return (
    types.find((item) => item.id === person.leaveTypeId)?.name ??
    "休假（类别缺失）"
  );
}

export function staffStatusOptions(
  types: readonly LeaveType[],
  current?: string
): { value: StaffStatusSelection; label: string }[] {
  const result: { value: StaffStatusSelection; label: string }[] =
    BUILTIN_STAFF_STATUSES.map((value) => ({ value, label: value }));
  for (const type of types) {
    const value: StaffStatusSelection = `leave:${type.id}`;
    if (type.enabled || value === current)
      result.push({
        value,
        label: type.name + (type.enabled ? "" : "（已停用）"),
      });
  }
  if (
    current?.startsWith("leave:") &&
    !result.some((option) => option.value === current)
  )
    result.push({
      value: `leave:${current.slice(6)}`,
      label: "休假（类别缺失）",
    });
  return result;
}

export function setStaffStatus(
  person: Staff,
  value: string,
  types: readonly LeaveType[]
): boolean {
  const builtin = BUILTIN_STAFF_STATUSES.find((status) => status === value);
  if (builtin) {
    person.status = builtin;
    delete person.leaveTypeId;
    return true;
  }
  const type = types.find((item) => `leave:${item.id}` === value);
  if ((!type || !type.enabled) && value !== staffStatusValue(person))
    return false;
  if (!value.startsWith("leave:") || !value.slice(6)) return false;
  person.status = "休假";
  person.leaveTypeId = value.slice(6);
  return true;
}

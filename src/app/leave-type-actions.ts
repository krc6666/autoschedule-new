import type { AppState, LeaveType } from "../model";
import { leaveTypeNameError } from "../domain/staff-status";
import { createId } from "../utils";

type ChangeResult = { ok: true } | { ok: false; error: string };

export function addLeaveType(state: AppState, name: string): ChangeResult {
  const error = leaveTypeNameError(name, state.leaveTypes);
  if (error) return { ok: false, error };
  state.leaveTypes.push({
    id: createId("leave"),
    name: name.trim(),
    enabled: true,
  });
  return { ok: true };
}

export function updateLeaveType(
  state: AppState,
  id: string,
  patch: Partial<Pick<LeaveType, "name" | "enabled">>
): ChangeResult {
  const type = state.leaveTypes.find((item) => item.id === id);
  if (!type) return { ok: false, error: "休假类别不存在" };
  if (patch.name !== undefined) {
    const error = leaveTypeNameError(patch.name, state.leaveTypes, id);
    if (error) return { ok: false, error };
    type.name = patch.name.trim();
  }
  if (patch.enabled !== undefined) type.enabled = patch.enabled;
  return { ok: true };
}

export function deleteLeaveType(state: AppState, id: string): ChangeResult {
  if (!state.leaveTypes.some((type) => type.id === id))
    return { ok: false, error: "休假类别不存在" };
  if (state.staff.some((person) => person.leaveTypeId === id))
    return { ok: false, error: "该类别仍有人员使用，请先停用或修改人员状态" };
  state.leaveTypes = state.leaveTypes.filter((type) => type.id !== id);
  return { ok: true };
}

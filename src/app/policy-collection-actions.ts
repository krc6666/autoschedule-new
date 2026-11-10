import type { AppState } from "../model";
import { markActiveScheduleStale } from "../domain/kernel/schedule-lifecycle";

interface IdentifiedPolicyItem {
  id: string;
}

export type PolicyItemUpdate = "invalid" | "unchanged" | "changed";

function markChanged(state: AppState): void {
  markActiveScheduleStale(state);
}

export function appendPolicyItem<T extends IdentifiedPolicyItem>(
  state: AppState,
  items: T[],
  item: T
): T {
  items.push(item);
  markChanged(state);
  return item;
}

export function savePolicyItem<T extends IdentifiedPolicyItem>(
  state: AppState,
  items: T[],
  item: T
): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) items.push(item);
  else items[index] = item;
  markChanged(state);
}

export function movePolicyItem<T extends IdentifiedPolicyItem>(
  state: AppState,
  items: T[],
  id: string,
  direction: -1 | 1
): boolean {
  const index = items.findIndex((item) => item.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return false;
  [items[index], items[targetIndex]] = [items[targetIndex]!, items[index]!];
  markChanged(state);
  return true;
}

export function deletePolicyItem<T extends IdentifiedPolicyItem>(
  state: AppState,
  items: T[],
  id: string
): boolean {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  items.splice(index, 1);
  markChanged(state);
  return true;
}

export function updatePolicyItem<T extends IdentifiedPolicyItem>(
  state: AppState,
  items: T[],
  id: string,
  update: (item: T) => PolicyItemUpdate
): boolean {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return false;
  const result = update(item);
  if (result === "invalid") return false;
  if (result === "changed") markChanged(state);
  return true;
}

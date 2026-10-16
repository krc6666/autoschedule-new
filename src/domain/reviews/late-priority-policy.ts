import type { PositionRule } from "../../model";
import { timeToMinutes } from "../shared/time";
import { isCombinedDeclarationDeliveryPosition } from "../rules/priority-position-semantics";
import { isPriorityRotationPosition } from "./position-rotation-policy";

const NEXT_DAY_EARLY_HOUR_CUTOFF_MINUTES = 6 * 60;

export const LATE_PRIORITY_KIND_DEFINITIONS = [
  {
    kind: "supervisor",
    label: "督导",
    keyword: "督导",
    allowedDifference: 1,
  },
  {
    kind: "number-one",
    label: "一号",
    keyword: "一号",
    allowedDifference: 1,
  },
  {
    kind: "declaration",
    label: "申报",
    keyword: "申报",
    allowedDifference: 2,
  },
  {
    kind: "delivery",
    label: "送资料",
    keyword: "送资料",
    allowedDifference: 2,
  },
] as const;

export type LatePriorityKindDefinition =
  (typeof LATE_PRIORITY_KIND_DEFINITIONS)[number];
export type LatePriorityFrequencyKind = LatePriorityKindDefinition["kind"];
export type LatePriorityKindLabel = LatePriorityKindDefinition["label"];

const DEFINITION_BY_KIND = new Map<
  LatePriorityFrequencyKind,
  LatePriorityKindDefinition
>(
  LATE_PRIORITY_KIND_DEFINITIONS.map((definition) => [
    definition.kind,
    definition,
  ])
);
const KIND_BY_LABEL = new Map<LatePriorityKindLabel, LatePriorityFrequencyKind>(
  LATE_PRIORITY_KIND_DEFINITIONS.map((definition) => [
    definition.label,
    definition.kind,
  ])
);

export const LATE_PRIORITY_FREQUENCY_ORDER: readonly LatePriorityFrequencyKind[] =
  LATE_PRIORITY_KIND_DEFINITIONS.map((definition) => definition.kind);

export const LATE_PRIORITY_ALLOWED_DIFFERENCE: Readonly<
  Record<LatePriorityFrequencyKind, number>
> = Object.fromEntries(
  LATE_PRIORITY_KIND_DEFINITIONS.map((definition) => [
    definition.kind,
    definition.allowedDifference,
  ])
) as Record<LatePriorityFrequencyKind, number>;

export function latePriorityKindDefinition(
  kind: LatePriorityFrequencyKind
): LatePriorityKindDefinition {
  return DEFINITION_BY_KIND.get(kind)!;
}

export function latePriorityKindLabel(
  kind: LatePriorityFrequencyKind
): LatePriorityKindLabel {
  return latePriorityKindDefinition(kind).label;
}

export function latePriorityKindForLabel(
  label: LatePriorityKindLabel
): LatePriorityFrequencyKind {
  return KIND_BY_LABEL.get(label)!;
}

export function latePriorityMonthlyLabel(
  kind: LatePriorityFrequencyKind
): string {
  return `本月跨航班${latePriorityKindLabel(kind)}`;
}

function normalizeLatePriorityReference(value: string): string {
  return value.trim().toUpperCase().replaceAll(/\s+/g, "");
}

export function normalizeLatePriorityFlightNumber(value: string): string {
  return normalizeLatePriorityReference(value);
}

export function normalizeLatePriorityPositionReference(value: string): string {
  return normalizeLatePriorityReference(value);
}

export function endsAfterLateShiftThreshold(
  target: Pick<{ startTime: string; endTime: string }, "startTime" | "endTime">,
  thresholdTime: string
): boolean {
  const start = timeToMinutes(target.startTime);
  let end = timeToMinutes(target.endTime);
  const threshold = timeToMinutes(thresholdTime);
  if (![start, end, threshold].every(Number.isFinite)) return false;
  if (end <= start || start < NEXT_DAY_EARLY_HOUR_CUTOFF_MINUTES)
    end += 24 * 60;
  return end > threshold;
}

export function isLatePriorityPosition(
  rule: Pick<PositionRule, "category" | "name" | "remark">,
  target: { startTime: string; endTime: string },
  thresholdTime: string
): boolean {
  return (
    isPriorityRotationPosition(rule) &&
    endsAfterLateShiftThreshold(target, thresholdTime)
  );
}

export function isDeclarationOrDeliveryPosition(
  target: Pick<PositionRule, "name" | "remark">
): boolean {
  const kinds = latePriorityFrequencyKinds(target);
  return kinds.includes("declaration") || kinds.includes("delivery");
}

export function latePriorityFrequencyKinds(
  target: Pick<PositionRule, "name" | "remark">
): readonly LatePriorityFrequencyKind[] {
  const searchable = `${target.name} ${target.remark}`;
  const kinds = LATE_PRIORITY_KIND_DEFINITIONS.flatMap((definition) =>
    searchable.includes(definition.keyword) ? [definition.kind] : []
  );
  return isCombinedDeclarationDeliveryPosition(target)
    ? kinds.filter((kind) => kind !== "declaration")
    : kinds;
}

export function isSupervisorPosition(
  target: Pick<PositionRule, "name" | "remark">
): boolean {
  return latePriorityFrequencyKinds(target).includes("supervisor");
}

import type { HistoryRecord, PositionRule } from "../../model";
import {
  flightPositionSource,
  flightRuleMatches,
  type FlightIdentityFacts,
} from "../flights/flight-identities";
import {
  normalizeLatePriorityFlightNumber,
  normalizeLatePriorityPositionReference,
} from "../reviews/late-priority-policy";

/** Exact archived version first; an explicitly inherited job comes next. */
export function latePriorityHistoryRule(
  context: FlightIdentityFacts,
  rules: readonly PositionRule[],
  record: Pick<HistoryRecord, "flightNo" | "position" | "date">
): PositionRule | undefined {
  const candidates = rules.filter(
    (r) =>
      normalizeLatePriorityPositionReference(r.name) ===
      normalizeLatePriorityPositionReference(record.position)
  );
  const exact = (no: string) =>
    candidates.find(
      (r) =>
        normalizeLatePriorityFlightNumber(r.flightNo) ===
        normalizeLatePriorityFlightNumber(no)
    );
  return (
    exact(record.flightNo) ??
    exact(flightPositionSource(context, record.flightNo, record.date)) ??
    candidates.find((r) =>
      flightRuleMatches(context, r.flightNo, record.flightNo, record.date)
    )
  );
}

/** Counting follows role evidence, even after that role moves to another position. */
export function latePriorityRecordSemantics(
  record: Pick<HistoryRecord, "position" | "remark" | "assignmentRemarks">,
  currentRule?: Pick<PositionRule, "name" | "remark">
): Pick<PositionRule, "name" | "remark"> {
  const originalRemark =
    record.assignmentRemarks?.remark ??
    record.remark.split(
      /(?:^|；)(?:规则\/人工调整提醒|规则提醒|人工调整提醒)：/u
    )[0]!;
  return {
    name: record.position,
    remark: [originalRemark, currentRule?.remark].filter(Boolean).join("；"),
  };
}

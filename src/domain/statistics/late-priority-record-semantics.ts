import type { HistoryRecord, PositionRule } from "../../model";

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

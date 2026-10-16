import type { RuleFeedbackKey } from "../rules/schedule-rule-contract";
import { warningSummary } from "../reviews/warning-presentation";

export type ScheduleFeedbackLevel = "ok" | "attention" | "info";
export type ScheduleFeedbackGroup = "flight-staff" | "rule-execution";
export type ScheduleFeedbackStatus = "已执行" | "需复核" | "无基准";
export type ScheduleFeedbackKey =
  "coverage" | "fatigue" | "connections" | "manual-overrides" | RuleFeedbackKey;

export interface ScheduleFeedbackItem {
  key: ScheduleFeedbackKey;
  group: ScheduleFeedbackGroup;
  label: string;
  level: ScheduleFeedbackLevel;
  status: ScheduleFeedbackStatus;
  evidence: string;
  text: string;
}

export function feedbackItem(
  group: ScheduleFeedbackGroup,
  key: ScheduleFeedbackItem["key"],
  label: string,
  level: ScheduleFeedbackLevel,
  text: string
): ScheduleFeedbackItem {
  const status: ScheduleFeedbackStatus =
    level === "ok" ? "已执行" : level === "attention" ? "需复核" : "无基准";
  return {
    group,
    key,
    label,
    level,
    status,
    evidence: text,
    text: level === "attention" ? warningSummary(text) : text,
  };
}

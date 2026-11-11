import type { PositionRule } from "./model";

export function orderPositionRules(rules: PositionRule[]): PositionRule[] {
  const flightNumbers = [...new Set(rules.map((rule) => rule.flightNo))];
  return flightNumbers.flatMap((flightNo) => {
    const flightRules = rules.filter((rule) => rule.flightNo === flightNo);
    return flightRules
      .filter((rule) => rule.name.includes("督导"))
      .concat(flightRules.filter((rule) => !rule.name.includes("督导")));
  });
}

export function sortFlightCountersDescending(
  rules: PositionRule[],
  flightNo: string
): PositionRule[] {
  const counterNumber = (name: string): number | null => {
    const match = name.trim().match(/^[GH](\d{1,2})$/i);
    return match ? Number(match[1]) : null;
  };
  const selected = rules
    .filter((rule) => rule.flightNo === flightNo)
    .map((rule, index) => ({ rule, index }));
  const sorted = [...selected]
    .sort((left, right) => {
      const leftSupervisor = left.rule.name.includes("督导");
      const rightSupervisor = right.rule.name.includes("督导");
      if (leftSupervisor !== rightSupervisor) return leftSupervisor ? -1 : 1;
      const leftCounter = counterNumber(left.rule.name);
      const rightCounter = counterNumber(right.rule.name);
      if (leftCounter !== null && rightCounter !== null)
        return rightCounter - leftCounter;
      if (leftCounter !== null || rightCounter !== null)
        return leftCounter !== null ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ rule }) => rule);
  let selectedIndex = 0;
  return rules.map((rule) =>
    rule.flightNo === flightNo ? sorted[selectedIndex++]! : rule
  );
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function splitList(value: unknown): string[] {
  return normalizeText(value)
    .split(/[,，、/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Slashes belong to compound position names, such as 督导/引导. */
export function splitPositionList(value: unknown): string[] {
  return normalizeText(value)
    .split(/[,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function visiblePositionRemark(value: unknown): string {
  return normalizeText(value)
    .replaceAll("一号", "")
    .replaceAll(/^[\s，、,/]+|[\s，、,/]+$/g, "")
    .trim();
}

export function combinedAssignmentRemark(
  positionRemark: unknown,
  manualRemark: unknown
): string {
  return [visiblePositionRemark(positionRemark), normalizeText(manualRemark)]
    .filter(Boolean)
    .join("；");
}

export function persistedAssignmentRemark(
  positionRemark: unknown,
  manualRemark: unknown
): string {
  return [normalizeText(positionRemark), normalizeText(manualRemark)]
    .filter(Boolean)
    .join("；");
}

export function assignmentWarningRemark(
  positionRemark: unknown,
  manualRemark: unknown,
  warnings: readonly { message: string; code?: string }[] | undefined
): string {
  const hasRuleWarning = warnings?.some(
    (warning) => warning.code === "same-day-cross-flight-priority"
  );
  const hasManualWarning = warnings?.some(
    (warning) => warning.code !== "same-day-cross-flight-priority"
  );
  const warningPrefix =
    hasRuleWarning && hasManualWarning
      ? "规则/人工调整提醒"
      : hasRuleWarning
        ? "规则提醒"
        : "人工调整提醒";
  return persistedAssignmentRemark(
    persistedAssignmentRemark(positionRemark, manualRemark),
    warnings?.length
      ? `${warningPrefix}：${warnings.map((warning) => warning.message).join("；")}`
      : ""
  );
}

export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function assertElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`页面缺少元素：${selector}`);
  return element;
}

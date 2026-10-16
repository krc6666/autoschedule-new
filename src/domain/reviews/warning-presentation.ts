/** A compact preview of recorded text. Full evidence is always kept alongside it. */
export function warningSummary(evidence: string): string {
  const firstLine = evidence.trim().split(/\r?\n/)[0] ?? "";
  if (!firstLine) return "具体原因未记录";
  if (firstLine.length <= 110) return firstLine;
  return `${firstLine.slice(0, 110)}…`;
}

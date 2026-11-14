export function timeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return Number.NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return Number.NaN;
  return hours * 60 + minutes;
}

export function normalizeTime(value: string): string {
  const minutes = timeToMinutes(value);
  if (!Number.isFinite(minutes)) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Put after-midnight work on the same operational day as the preceding evening. */
export function operationalInterval(
  startTime: string,
  endTime: string,
  nightEnd: string
): [number, number] | null {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  const dayStart = timeToMinutes(nightEnd);
  if (![start, end, dayStart].every(Number.isFinite)) return null;
  const operationalStart = start < dayStart ? start + 1440 : start;
  let operationalEnd = end;
  if (operationalStart >= 1440 || operationalEnd <= operationalStart)
    operationalEnd += 1440;
  return [operationalStart, operationalEnd];
}

export function addIsoDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  )
    .toISOString()
    .slice(0, 10);
}

export function durationHours(startTime: string, endTime: string): number {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end <= start) end += 24 * 60;
  return Math.round(((end - start) / 60) * 100) / 100;
}

function interval(startTime: string, endTime: string): [number, number] {
  const start = timeToMinutes(startTime);
  let end = timeToMinutes(endTime);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export function intervalsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const [startA, endA] = interval(aStart, aEnd);
  const [startB, endB] = interval(bStart, bEnd);
  if (![startA, endA, startB, endB].every(Number.isFinite)) return false;
  const candidates: Array<[number, number]> = [
    [startB, endB],
    [startB + 1440, endB + 1440],
    [startB - 1440, endB - 1440],
  ];
  return candidates.some(([start, end]) => startA < end && start < endA);
}

export function isNightInterval(
  startTime: string,
  endTime: string,
  nightStart = "22:00",
  nightEnd = "06:00"
): boolean {
  return intervalsOverlap(startTime, endTime, nightStart, nightEnd);
}

import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { latePriorityFlightInScope } from "../statistics/late-priority-flight-scope";

export const DAILY_SCHEDULE_BASE_TIMEOUT_MS = 150_000;
export const DAILY_SCHEDULE_MAX_TIMEOUT_MS = 300_000;

export function dailyScheduleTimeoutMs(
  state: ScheduleGenerationFacts,
  date: string
): number {
  const month = date.slice(0, 7);
  const hasCurrentManualLedger = (
    state.latePriorityFrequencyAdjustments ?? []
  ).some(
    (adjustment) =>
      adjustment.month === month &&
      latePriorityFlightInScope(
        state.settings.latePriorityFlightNumbers,
        adjustment.flightNo,
        state
      ) &&
      (adjustment.delta !== 0 || (adjustment.resetBaseline ?? 0) > 0)
  );
  return hasCurrentManualLedger
    ? DAILY_SCHEDULE_MAX_TIMEOUT_MS
    : DAILY_SCHEDULE_BASE_TIMEOUT_MS;
}

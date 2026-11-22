import { recentArchivedWorkdays } from "../../domain/statistics/fatigue";
import { flightLeaderWarnings } from "../../domain/rules/flight-leader-coverage";
import type {
  AppState,
  HistoryRecord,
  FlightLeaderCoverageStatus,
} from "../../model";

export interface ArchivedScheduleFlightGroup {
  flightNo: string;
  startTime: string;
  endTime: string;
  records: HistoryRecord[];
}

export interface ArchivedScheduleDayView {
  flightLeaderWarnings?: string[];
  date: string;
  groups: ArchivedScheduleFlightGroup[];
  recordCount: number;
  rowCount: number;
  totalHours: number;
  hasPartialHistory: boolean;
}

function positionOrderKey(flightNo: string, position: string): string {
  return `${flightNo}\u0000${position}`;
}

function positionOrder(
  state: Pick<AppState, "positionRules">
): Map<string, number> {
  const order = new Map<string, number>();
  state.positionRules.forEach((rule, index) => {
    const key = positionOrderKey(rule.flightNo, rule.name);
    if (!order.has(key)) order.set(key, index);
  });
  return order;
}

function flightGroups(
  records: HistoryRecord[],
  order: ReadonlyMap<string, number>
): ArchivedScheduleFlightGroup[] {
  const recordsByFlight = new Map<
    string,
    Array<{ record: HistoryRecord; index: number }>
  >();
  records.forEach((record, index) => {
    const flightNo = record.flightNo || "未标注航班";
    const flightRecords = recordsByFlight.get(flightNo) ?? [];
    flightRecords.push({ record, index });
    recordsByFlight.set(flightNo, flightRecords);
  });
  return [...recordsByFlight.entries()]
    .map(([flightNo, indexedRecords]) => {
      const ordered = indexedRecords
        .sort((left, right) => {
          const leftIndex =
            order.get(
              positionOrderKey(left.record.flightNo, left.record.position)
            ) ?? Number.MAX_SAFE_INTEGER;
          const rightIndex =
            order.get(
              positionOrderKey(right.record.flightNo, right.record.position)
            ) ?? Number.MAX_SAFE_INTEGER;
          return leftIndex - rightIndex || left.index - right.index;
        })
        .map(({ record }) => record);
      return {
        flightNo,
        startTime: indexedRecords[0]?.record.startTime ?? "",
        endTime: indexedRecords[0]?.record.endTime ?? "",
        records: ordered,
      };
    })
    .sort((left, right) => left.startTime.localeCompare(right.startTime));
}

function dayView(
  date: string,
  records: HistoryRecord[],
  order: ReadonlyMap<string, number>,
  coverage?: readonly FlightLeaderCoverageStatus[]
): ArchivedScheduleDayView {
  const groups = flightGroups(records, order);
  return {
    ...(coverage === undefined
      ? {}
      : { flightLeaderWarnings: flightLeaderWarnings(coverage) }),
    date,
    groups,
    recordCount: records.length,
    rowCount: Math.max(0, ...groups.map((group) => group.records.length)),
    totalHours: records.reduce((sum, record) => sum + record.workHours, 0),
    hasPartialHistory: records.some(
      (record) => record.historyCoverage === "late-priority-only"
    ),
  };
}

export function buildArchivedScheduleDays(
  state: Pick<
    AppState,
    "history" | "positionRules" | "flightLeaderCoverageHistory"
  >
): ArchivedScheduleDayView[] {
  const recordsByDate = new Map<string, HistoryRecord[]>();
  for (const record of state.history) {
    const records = recordsByDate.get(record.date) ?? [];
    records.push(record);
    recordsByDate.set(record.date, records);
  }
  const order = positionOrder(state);
  return [...recordsByDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, records]) =>
      dayView(
        date,
        records,
        order,
        state.flightLeaderCoverageHistory?.find((day) => day.date === date)
          ?.flights
      )
    );
}

export function buildPreviousArchivedScheduleView(
  state: Pick<
    AppState,
    "history" | "positionRules" | "flightLeaderCoverageHistory"
  >,
  date: string
): ArchivedScheduleDayView | null {
  const records = recentArchivedWorkdays(state.history, date, 1);
  const previousDate = records[0]?.date;
  return previousDate
    ? dayView(
        previousDate,
        records,
        positionOrder(state),
        state.flightLeaderCoverageHistory?.find(
          (day) => day.date === previousDate
        )?.flights
      )
    : null;
}

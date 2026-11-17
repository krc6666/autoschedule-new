import { createDefaultState } from "../../src/defaults";
import { currentScheduleHistory } from "../../src/app/history-actions";
import { scheduleRuleFingerprint } from "../../src/domain/rules/schedule-rule-fingerprint";
import { createStatePersistence } from "../../src/infrastructure/storage";

export const syncDate = "2026-11-18";

export function historySyncState() {
  const state = createDefaultState();
  const flight = state.flights[0]!;
  const rule = state.positionRules.find((r) => r.flightNo === flight.flightNo)!;
  const people = state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .slice(0, 2);
  people.forEach((p, i) => {
    p.name = `同步测试人员${i + 1}`;
    p.nightShift = true;
  });
  state.staff = people;
  state.positionRules = [
    { ...rule, qualifiedStaffIds: people.map((p) => p.id), manual: false },
  ];
  state.flights = [{ ...flight, positions: [rule.name] }];
  state.templates = structuredClone(state.flights);
  state.settings.dutyFatiguePoints = 0;
  state.activeScheduleDate = syncDate;
  state.assignments = [
    {
      id: "sync-slot",
      flightId: flight.id,
      flightNo: flight.flightNo,
      positionRuleId: rule.id,
      position: rule.name,
      staffId: people[0]!.id,
      staffName: people[0]!.name,
      startTime: flight.startTime,
      endTime: flight.endTime,
      workHours: 2,
      fatiguePoints: 3,
      remark: rule.remark,
      manualRemark: "原备注",
      status: "assigned",
    },
  ];
  state.history = currentScheduleHistory(state, syncDate);
  state.history.push({
    ...state.history[0]!,
    id: "other-date",
    date: "2026-11-16",
  });
  state.schedulePolicyStale = false;
  state.scheduleRuleFingerprint = scheduleRuleFingerprint(state);
  return state;
}

export function memoryPersistence() {
  const memory = new Map<string, string>();
  return createStatePersistence({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  });
}

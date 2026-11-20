import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.min.css";
import "../../src/styles.css";
import { createDefaultState } from "../../src/defaults";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import { createStatePersistence } from "../../src/infrastructure/storage";
import { mountAutoscheduleApp } from "../../src/app";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { restorePersistedState } from "../../src/infrastructure/state-restoration";
import { buildMonthlyLatePriorityStatistics } from "../../src/domain/statistics/monthly-late-priority-statistics";
import * as XLSX from "xlsx-js-style";

function fixture() {
  const state = createDefaultState();
  const person = {
    ...state.staff[0]!,
    id: "test-person",
    name: "测试人员",
    dutyQualified: false,
  };
  state.staff = [person, { ...person, id: "test-other", name: "测试同事" }];
  state.flights = [];
  state.history = [];
  state.assignments = [];
  state.settings.latePriorityFlightNumbers = ["CX937晚"];
  state.settings.lateShiftEndTime = "22:00";
  state.settings.dutyPositionPriorities = [];
  state.settings.positionTransitionPolicies = [];
  state.templates = ["CX937早", "CX937晚", "AB999"].map((flightNo, i) => ({
    ...state.templates[0]!,
    id: `t${i}`,
    flightNo,
    startTime: "20:00",
    endTime: "23:00",
    positions: ["H02"],
  }));
  state.positionRules = ["CX937早", "CX937晚"].map((flightNo, i) => ({
    ...state.positionRules[0]!,
    id: `p${i}`,
    flightNo,
    name: "H02",
    category: "常规",
    manual: false,
    remark: "一号",
    qualifiedStaffIds: [person.id],
  }));
  state.history = ["CX937早", "CX937晚", "AB999"].map((flightNo, i) => ({
    id: `h${i}`,
    flightNo,
    date: i < 2 ? "2026-11-01" : "2026-11-02",
    position: "H02",
    staffId: person.id,
    staffName: person.name,
    startTime: "20:00",
    endTime: "23:00",
    workHours: 3,
    fatiguePoints: 3,
    remark: "一号",
  }));
  state.settings.sameFlightStaffExclusions = [
    {
      id: "pair",
      flightNo: "CX937晚",
      enabled: true,
      staffIds: [person.id, "test-other"],
    },
  ];
  state.groups.B.staff = [];
  state.groups.B.positionRules = [];
  state.groups.B.history = [];
  state.groups.B.assignments = [];
  return state;
}
const key = "flight-identities-isolated-state";
const storage = {
  getItem: () => localStorage.getItem(key),
  setItem: (_key: string, value: string) => localStorage.setItem(key, value),
  removeItem: () => localStorage.removeItem(key),
};
const persistence = createStatePersistence(storage);
const store = createAutoscheduleStore({
  persistence,
  initialState: localStorage.getItem(key) ? persistence.load() : fixture(),
});
const mounted = mountAutoscheduleApp(document.querySelector("#app")!, {
  store,
  shouldWarnOnExit: () => false,
});
Object.assign(window, {
  isolated: {
    store,
    mounted,
    snapshot: () => JSON.parse(JSON.stringify(store.getState().model)),
    roundtrip() {
      const source = store.getState().model;
      const bytes = XLSX.write(buildConfigWorkbook(source), {
        type: "array",
        bookType: "xlsx",
      });
      const target = createDefaultState();
      target.staff = [];
      target.history = [];
      target.shared.flightIdentities = [
        {
          id: "other",
          displayName: "不同旧值",
          aliases: [{ flightNo: "ZZ100" }],
        },
      ];
      const imported = parseWorkbook(XLSX.read(bytes, { type: "array" }), []);
      const result = applyWorkbookImport(target, imported, "config", {
        restoreFlightConfiguration: true,
      });
      if (result.errors) throw new Error(result.errors.join("；"));
      const restored = restorePersistedState(
        JSON.parse(JSON.stringify(target)),
        createDefaultState()
      )!;
      const statistics = buildMonthlyLatePriorityStatistics(
        restored,
        "2026-11-20"
      );
      return {
        identities: restored.shared.flightIdentities,
        rules: restored.settings.latePriorityFlightNumbers,
        columns: statistics.flightNumbers,
        actualNumberOneCount:
          statistics.rows[0]!.categories["一号"].effectiveCount,
        originalEvents: statistics.rows[0]!.categories["一号"].details.map(
          (d) => ({ date: d.date, flightNo: d.flightNo })
        ),
        role: restored.positionRules
          .filter((r) => r.flightNo === "AB999")
          .map((r) => ({
            name: r.name,
            qualifiedStaffIds: r.qualifiedStaffIds,
          })),
      };
    },
  },
});

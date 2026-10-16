// Read-only real-workbook check. Input path comes from argv; output has no people identifiers.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import XLSX from "xlsx-js-style";
import { createServer } from "vite";

const input = process.argv[2];
assert(input, "Provide the owner-authorized workbook path");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = readFileSync(input);
// Node's CJS namespace lacks XLSX named exports. Adapt only the probe's in-memory
// SSR imports; production sources and workbook input remain unchanged.
const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  plugins: [
    {
      name: "probe-cjs-xlsx",
      enforce: "pre",
      transform(code, id) {
        if (!id.replaceAll("\\", "/").includes("/src/infrastructure/")) return;
        return code.replace(
          'import * as XLSX from "xlsx-js-style";',
          'import XLSX from "xlsx-js-style";'
        );
      },
    },
  ],
});
try {
  const { createDefaultState } = await server.ssrLoadModule("/src/defaults.ts");
  const { parseWorkbook } = await server.ssrLoadModule(
    "/src/infrastructure/excel.ts"
  );
  const { applyWorkbookImport } = await server.ssrLoadModule(
    "/src/app/workbook-actions.ts"
  );
  const { buildMonthlyLatePriorityStatistics: late } =
    await server.ssrLoadModule(
      "/src/domain/statistics/monthly-late-priority-statistics.ts"
    );
  const { buildOrdinaryPriorityStatistics: ordinary } =
    await server.ssrLoadModule(
      "/src/domain/statistics/ordinary-priority-statistics.ts"
    );
  const state = createDefaultState();
  state.history = [];
  const parsed = parseWorkbook(XLSX.read(original, { type: "buffer" }), []);
  const applied = applyWorkbookImport(state, parsed, "all");
  assert(!applied.errors?.length, "Real workbook application rejected");
  assert(state.history.length > 0, "No history imported");
  assert(state.assignments.length === 0, "Unexpected current assignments");
  const date = "2026-10-17";
  const norm = (value) => value.trim().toUpperCase().replaceAll(/\s+/g, "");
  const ref = (value) => value.trim().toUpperCase().replaceAll(/\s+/g, " ");
  const airline = (flight) => {
    const compact = norm(flight);
    return compact.match(/^([A-Z0-9]{2,3}?)(?=\d{2,})/)?.[1] ?? compact;
  };
  // Independently implement the confirmed business definition, without production counting helpers.
  const kinds = (target) => {
    const text = `${target.name} ${target.remark}`;
    const labels = ["督导", "一号", "申报", "送资料"].filter((label) =>
      text.includes(label)
    );
    return labels.includes("申报") && labels.includes("送资料")
      ? labels.filter((label) => label !== "申报")
      : labels;
  };
  const minutes = (value) =>
    Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const lateEnough = (record) => {
    const start = minutes(record.startTime);
    let end = minutes(record.endTime);
    if (end <= start || start < 360) end += 1440;
    return end > minutes(state.settings.lateShiftEndTime);
  };
  const baseline = (record) =>
    record.countBaseline ? record.countBaseline.staffId : record.staffId;
  const records = state.history.filter((record) =>
    record.date.startsWith("2026-10")
  );
  const before = hash(Buffer.from(JSON.stringify(state)));
  const actual = late(state, date);
  let lateCells = 0;
  for (const row of actual.rows)
    for (const flightNo of actual.flightNumbers)
      for (const label of row.flights[flightNo].applicableCategories) {
        const finalKeys = new Set();
        const baseKeys = new Set();
        for (const record of records) {
          if (norm(record.flightNo) !== flightNo || !lateEnough(record))
            continue;
          const rule = state.positionRules.find(
            (rule) =>
              norm(rule.flightNo) === flightNo &&
              norm(rule.name) === norm(record.position)
          );
          if (
            !rule ||
            !kinds(rule).includes(label) ||
            !kinds({
              name: record.position,
              remark: record.assignmentRemarks?.remark ?? record.remark,
            }).includes(label)
          )
            continue;
          const key = `${record.date}|${flightNo}|${label}`;
          if (record.staffId === row.staff.id) finalKeys.add(key);
          if (baseline(record) === row.staff.id) baseKeys.add(key);
        }
        const kind = {
          督导: "supervisor",
          一号: "number-one",
          申报: "declaration",
          送资料: "delivery",
        }[label];
        const adjustments = state.latePriorityFrequencyAdjustments.filter(
          (a) =>
            a.month === "2026-10" &&
            a.staffId === row.staff.id &&
            norm(a.flightNo) === flightNo &&
            a.kind === kind
        );
        const delta = adjustments.reduce((sum, a) => sum + a.delta, 0);
        const cell = row.flights[flightNo].categories[label];
        assert.equal(
          cell.details.length,
          finalKeys.size,
          "Late actual count mismatch"
        );
        assert.equal(
          cell.effectiveCount,
          Math.max(0, finalKeys.size + delta),
          "Late final count mismatch"
        );
        assert.equal(
          cell.baseCount,
          Math.max(
            0,
            baseKeys.size -
              adjustments.reduce((sum, a) => sum + (a.resetBaseline ?? 0), 0)
          ),
          "Late baseline mismatch"
        );
        lateCells++;
      }
  const ordinaryRows = ordinary(state, date);
  assert.equal(
    ordinaryRows.length,
    state.staff.filter((s) => s.staffType === "常规").length *
      state.settings.ordinaryPriorityPositions.length,
    "Ordinary rows missing"
  );
  const selectedFlights = new Set(
    state.settings.latePriorityFlightNumbers.map(norm)
  );
  for (const record of records) {
    if (!selectedFlights.has(norm(record.flightNo)) || !lateEnough(record))
      continue;
    const rule = state.positionRules.find(
      (r) =>
        norm(r.flightNo) === norm(record.flightNo) &&
        norm(r.name) === norm(record.position)
    );
    if (!rule || !kinds(rule).length) continue;
    for (const id of [record.staffId, baseline(record)]) {
      if (!state.staff.some((s) => s.id === id && s.staffType === "常规"))
        continue;
      assert(
        actual.rows.some((r) => r.staff.id === id),
        "Late record staff row missing"
      );
    }
  }
  for (const row of ordinaryRows) {
    const matching = records.filter(
      (r) =>
        airline(r.flightNo) === row.airlineCode &&
        ref(r.position) === ref(row.position)
    );
    const base = matching.filter((r) => baseline(r) === row.staff.id).length;
    const count = matching.filter((r) => r.staffId === row.staff.id).length;
    const correction = state.ordinaryPriorityFrequencyAdjustments
      .filter(
        (a) =>
          a.month === "2026-10" &&
          a.staffId === row.staff.id &&
          a.airlineCode === row.airlineCode &&
          ref(a.position) === ref(row.position)
      )
      .reduce((sum, a) => sum + a.delta + (a.resetBaseline ?? 0), 0);
    assert.equal(row.actualCount, base, "Ordinary baseline mismatch");
    assert.equal(
      row.manualCorrection,
      count - base + correction,
      "Ordinary correction mismatch"
    );
    assert.equal(
      row.effectiveCount,
      Math.max(0, count + correction),
      "Ordinary final count mismatch"
    );
  }
  assert.equal(
    hash(Buffer.from(JSON.stringify(state))),
    before,
    "Statistics mutated source state"
  );
  const supervisorRule = state.positionRules.find(
    (r) => norm(r.flightNo) === "TR121" && r.name === "督导"
  );
  const supervisorRecords = records.filter(
    (r) =>
      r.date === "2026-10-13" &&
      norm(r.flightNo) === "TR121" &&
      r.position === "督导"
  );
  const confirmedOctober13 = supervisorRecords.filter((r) =>
    actual.rows.some(
      (row) =>
        row.staff.id === r.staffId &&
        row.categories.督导.details.some(
          (detail) =>
            detail.date === "2026-10-13" && norm(detail.flightNo) === "TR121"
        )
    )
  ).length;
  assert.equal(
    confirmedOctober13,
    supervisorRecords.length,
    "October 13 supervision missing"
  );
  assert.equal(hash(readFileSync(input)), hash(original), "Input file changed");
  console.log(
    JSON.stringify(
      {
        inputSha256: hash(original),
        inputUnchanged: true,
        date,
        recordsInMonth: records.length,
        ordinaryCellsIndependentlyChecked: ordinaryRows.length,
        lateCellsIndependentlyChecked: lateCells,
        tr121SupervisorCategory: supervisorRule?.category,
        october13SupervisorRecords: supervisorRecords.length,
        october13SupervisorRecordsCounted: confirmedOctober13,
        sourceStateUnchanged: true,
        browserValidated: false,
      },
      null,
      2
    )
  );
} finally {
  await server.close();
}

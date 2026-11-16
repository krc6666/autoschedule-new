const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const req = createRequire(path.join(process.cwd(), "package.json"));

(async () => {
  const { createServer } = await import(
    pathToFileURL(req.resolve("vite")).href
  );
  const XLSX = req("xlsx-js-style");
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ["xlsx-js-style"] },
    resolve: {
      alias: [{ find: "xlsx-js-style", replacement: "\0artifact-xlsx" }],
    },
    // Node SSR needs named exports for this CommonJS package; product bundling is unchanged.
    plugins: [
      {
        name: "artifact-xlsx-node-interop",
        resolveId(id) {
          if (id === "\0artifact-xlsx") return id;
        },
        load(id) {
          if (id === "\0artifact-xlsx")
            return `import { createRequire } from "node:module"; const XLSX = createRequire(${JSON.stringify(path.join(process.cwd(), "package.json"))})("xlsx-js-style"); export const utils = XLSX.utils; export const read = XLSX.read; export const write = XLSX.write; export const CFB = XLSX.CFB;`;
        },
      },
    ],
  });
  const originalSelf = global.self;
  try {
    const load = (p) => server.ssrLoadModule("/" + p + ".ts");
    const { createDefaultState } = await load("src/defaults");
    const { priorityContinuityScenario } = await load(
      "tests/helpers/priority-continuity-scenario"
    );
    const { CONTINUITY_DATE: date } = await load(
      "tests/helpers/staff-work-continuity-scenario"
    );
    const excel = await load("src/infrastructure/excel");
    const { applyWorkbookImport } = await load("src/app/workbook-actions");
    const { saveState, loadState } = await load("src/infrastructure/storage");
    const { createScheduleGenerationFacts } = await load(
      "src/domain/shared/scheduling-facts"
    );
    const { createTestAutoscheduleStore } = await load(
      "tests/helpers/application"
    );
    const source = {
      ...createDefaultState(),
      ...priorityContinuityScenario(),
      activeScheduleDate: date,
    };
    source.staff.forEach((p) => {
      p.cxPreflightQualified = true;
      p.standbyQualified = true;
    });
    const inputBytes = XLSX.write(excel.buildConfigWorkbook(source), {
      bookType: "xlsx",
      type: "array",
    });
    const restored = createDefaultState();
    const imported = applyWorkbookImport(
      restored,
      excel.parseWorkbook(XLSX.read(inputBytes, { type: "array" }), []),
      "all"
    );
    assert.equal(imported.errors, undefined);
    let saved;
    saveState(restored, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const restarted = loadState({ getItem: () => saved });
    const messages = [];
    global.self = {
      onmessage: null,
      postMessage: (message) => messages.push(structuredClone(message)),
    };
    await load("src/schedule.worker");
    await global.self.onmessage({
      data: {
        state: createScheduleGenerationFacts(restarted),
        date,
        preferences: { halfRestStaffIds: [] },
      },
    });
    assert.deepEqual(
      messages.filter((m) => m.type === "error"),
      []
    );
    const response = messages.find((m) => m.type === "result");
    assert(response);
    assert.equal(response.result.unfilledCount, 0);
    assert.equal(response.result.safetyCredential.phase, "final");
    const store = createTestAutoscheduleStore(restarted);
    store.getState().schedule.install(date, response.result);
    const model = store.getState().model;
    const base =
      "docs/acceptance/evidence/2026-11-16-continuity-priority-final";
    const bytes = XLSX.write(excel.buildScheduleWorkbook(model, date), {
      bookType: "xlsx",
      type: "buffer",
    });
    fs.writeFileSync(base + ".xlsx", bytes);
    const book = XLSX.read(fs.readFileSync(base + ".xlsx"), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets["排班结果"]);
    const selected = rows.find((r) => r["航班号"] === "KE160")["人员编号"];
    const counts = model.staff.map((p) => ({
      staffId: p.id,
      monthlyPriorityCount: model.history.filter(
        (h) =>
          h.staffId === p.id &&
          /^KE/.test(h.flightNo) &&
          h.position === "督导" &&
          h.date.startsWith("2026-11") &&
          h.date < date
      ).length,
      exportedFlights: [
        ...new Set(
          rows.filter((r) => r["人员编号"] === p.id).map((r) => r["航班号"])
        ),
      ],
    }));
    assert.equal(selected, "peer-a");
    assert.deepEqual(
      counts.map((p) => p.monthlyPriorityCount),
      [0, 3]
    );
    counts.forEach((p) => assert.equal(p.exportedFlights.length, 2));
    saveState(model, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.deepEqual(
      loadState({ getItem: () => saved }).assignments,
      model.assignments
    );
    const report = {
      date,
      scope:
        "Anonymous configuration bytes -> save/restart -> real Worker module and HiGHS WASM in Node host -> Store -> written XLSX -> independent readback; no browser acceptance",
      monthlyBalance:
        "disabled to isolate the authorized continuity fix; known monthly-balance issue remains out of scope",
      selectedPriorityStaffId: selected,
      counts,
      unfilledCount: response.result.unfilledCount,
      credentialPhase: response.result.safetyCredential.phase,
      rows,
    };
    fs.writeFileSync(base + ".json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (originalSelf === undefined) delete global.self;
    else global.self = originalSelf;
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

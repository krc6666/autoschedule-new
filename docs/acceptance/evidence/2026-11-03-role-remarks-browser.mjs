import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import XLSX from "xlsx-js-style";
import { chromium } from "playwright-core";

const source = process.env.ROLE_COUNTS_WORKBOOK;
assert.ok(
  source,
  "Set ROLE_COUNTS_WORKBOOK to the owner-provided local workbook."
);
const input = readFileSync(source);
const book = XLSX.read(input, { type: "buffer" });
const history = XLSX.utils.sheet_to_json(book.Sheets["历史排班"], {
  header: 1,
});
const target = history.find(
  (r) => r[1] === "2026-10-29" && r[2] === "TR121" && r[3] === "H05"
);
assert.ok(target);
const targetId = String(target[4]);
const sourceHash = createHash("sha256").update(input).digest("hex");
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  sourceSha256: sourceHash,
  source:
    "Owner-provided private workbook, isolated browser; no source data copied into evidence.",
  checks: {},
};
async function showStatistics() {
  await page.locator('nav button[title="统计"]').click();
  const month = page.getByLabel("末班重点岗位统计月份", { exact: true });
  await month.fill("2026-10");
  await month.dispatchEvent("change");
  await page
    .getByRole("button", { name: "末班重点岗位统计类别：送资料", exact: true })
    .click();
}
try {
  await page.goto("http://127.0.0.1:5193/", { waitUntil: "networkidle" });
  await page
    .locator('input[type="file"][accept=".xlsx,.xls"]')
    .setInputFiles(source);
  await page.getByRole("button", { name: "确认导入配置与历史" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("autoschedule-app")
      .model.history.some(
        (r) =>
          r.date === "2026-10-29" &&
          r.flightNo === "TR121" &&
          r.position === "H05"
      )
  );
  await showStatistics();
  const facts = await page.evaluate(async (id) => {
    const state = document.querySelector("autoschedule-app").model;
    const { buildMonthlyLatePriorityStatistics } =
      await import("/src/domain/statistics/monthly-late-priority-statistics.ts");
    const { buildOrdinaryPriorityStatistics } =
      await import("/src/domain/statistics/ordinary-priority-statistics.ts");
    const { buildMonthlyRelaxedShiftStatistics } =
      await import("/src/domain/statistics/relaxed-shift-statistics.ts");
    const stat = buildMonthlyLatePriorityStatistics(
      state,
      "2026-10-29"
    ).rows.find((r) => r.staff.id === id);
    const relaxed = buildMonthlyRelaxedShiftStatistics(
      state,
      "2026-10-29"
    ).rows.find((r) => r.staff.id === id);
    const current = state.positionRules.find(
      (r) => r.flightNo === "TR121" && r.name === "H05"
    );
    return {
      delivery: stat.categories.送资料.effectiveCount,
      deliveryDetails: stat.categories.送资料.details,
      targetPositionQualified: current.qualifiedStaffIds.includes(id),
      targetCurrentRemark: current.remark,
      ordinaryH05: buildOrdinaryPriorityStatistics(state, "2026-10-29").find(
        (r) =>
          r.staff.id === id && r.airlineCode === "TR" && r.position === "H05"
      ).effectiveCount,
      afternoonRestIncludesTargetDate:
        relaxed.afternoonRestDates.includes("2026-10-29"),
      earlyDepartureIncludesTargetDate: relaxed.earlyDepartures.some(
        (r) => r.date === "2026-10-29"
      ),
    };
  }, targetId);
  assert.equal(facts.delivery, 3);
  assert.equal(facts.targetPositionQualified, false);
  assert.equal(facts.targetCurrentRemark, "");
  assert.equal(facts.ordinaryH05, 1);
  assert.equal(facts.afternoonRestIncludesTargetDate, true);
  assert.equal(facts.earlyDepartureIncludesTargetDate, false);
  assert.ok(
    facts.deliveryDetails.some(
      (d) =>
        d.date === "2026-10-29" &&
        d.flightNo === "TR121" &&
        d.position === "H05"
    )
  );
  // Independently count only the target person's actual delivery records, not the domain function.
  const positions = XLSX.utils.sheet_to_json(book.Sheets["岗位配置"], {
    header: 1,
  });
  const scope = new Set(
    XLSX.utils
      .sheet_to_json(book.Sheets["末班重点航班范围"], { header: 1 })
      .slice(1)
      .map((r) => String(r[0]))
  );
  const independent = new Set(
    history.slice(1).flatMap((r) => {
      if (
        String(r[4]) !== targetId ||
        !String(r[1]).startsWith("2026-10") ||
        !scope.has(String(r[2]))
      )
        return [];
      const evidence = r[14] ? JSON.parse(String(r[14])) : {};
      const original =
        evidence.assignmentRemarks?.remark ??
        String(r[10] ?? "").split(
          /(?:^|；)(?:规则\/人工调整提醒|规则提醒|人工调整提醒)：/u
        )[0];
      const current = positions.find((p) => p[0] === r[2] && p[2] === r[3]);
      if (!`${r[3]} ${original} ${current?.[3] ?? ""}`.includes("送资料"))
        return [];
      const mins = (t) => {
        const [h, m] = String(t).split(":").map(Number);
        return h * 60 + m;
      };
      const start = mins(r[6]);
      let end = mins(r[7]);
      if (end <= start || start < 360) end += 1440;
      return end > 1380 ? [`${r[1]}|${r[2]}|送资料`] : [];
    })
  );
  assert.equal(independent.size, 3);
  report.checks.realImport = {
    ...facts,
    independentlyRecountedDelivery: independent.size,
  };
  const detail = page.locator(
    `.late-priority-count-detail[data-staff-id="${targetId}"][data-flight-no="TR121"]`
  );
  assert.equal((await detail.locator("summary").innerText()).trim(), "1");
  await detail.locator("summary").click();
  const delivery = detail.locator('[data-late-priority-category="送资料"]');
  assert.ok((await delivery.innerText()).includes("10-29 H05"));
  await delivery.screenshot({
    path: "docs/acceptance/evidence/2026-11-03-role-remarks-page.png",
  });
  report.checks.visibleTargetDetail =
    "TR121 delivery 1; 10-29 H05 shown with no qualification requirement.";
  const downloadPromise = page.waitForEvent("download");
  await page.locator('button[title="导出当前月份末班重点岗位次数"]').click();
  const download = await downloadPromise;
  const exported = XLSX.readFile(await download.path());
  const exportedRows = XLSX.utils.sheet_to_json(
    exported.Sheets[exported.SheetNames[0]],
    { header: 1 }
  );
  const exportedTarget = exportedRows.find(
    (r) => String(r[1]) === targetId && r[3] === "TR121" && r[4] === "送资料"
  );
  assert.equal(exportedTarget[5], 1);
  report.checks.actualDownloadedWorkbook = { targetTRDelivery: 1 };
  await page.reload({ waitUntil: "networkidle" });
  await showStatistics();
  assert.equal((await detail.locator("summary").innerText()).trim(), "1");
  report.checks.persistedAfterReload = true;
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal((await detail.locator("summary").innerText()).trim(), "1");
  report.checks.mobileViewport = true;
  assert.deepEqual(errors, []);
  assert.equal(
    createHash("sha256").update(readFileSync(source)).digest("hex"),
    sourceHash
  );
  report.checks.privateWorkbookUnchanged = true;
  report.pageErrors = errors;
  writeFileSync(
    "docs/acceptance/evidence/2026-11-03-role-remarks-browser.txt",
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

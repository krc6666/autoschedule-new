import * as XLSX from "xlsx-js-style";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  buildScheduleWorkbook,
  writeWorkbook,
} from "../../src/infrastructure/excel";

const download = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  downloadBlob: download,
}));

function fixture(flights = 5, rows = 10, people = 18) {
  const state = createDefaultState();
  const base = state.staff[0]!;
  state.staff = Array.from({ length: people }, (_, i) => ({
    ...base,
    id: `p${i}`,
    name: `P${i + 1}`,
    status: "正常" as const,
    staffType: "常规" as const,
  }));
  state.flights = Array.from({ length: flights }, (_, i) => ({
    id: `f${i}`,
    flightNo: `FL${100 + i}`,
    startTime: "08:00",
    endTime: "10:00",
    remark: "到岗08:00",
    positions: [],
    bookedPassengers: 0,
  }));
  state.assignments = state.flights.flatMap((f, i) =>
    Array.from({ length: rows }, (_, j) => ({
      id: `a${i}-${j}`,
      flightId: f.id,
      flightNo: f.flightNo,
      positionRuleId: null,
      position: `G${j + 1}`,
      staffId: `p${j % 18}`,
      staffName: `P${(j % 18) + 1}`,
      startTime: f.startTime,
      endTime: f.endTime,
      status: "assigned" as const,
      remark: j === 0 ? "申报/送资料" : "",
      manualRemark: "",
      workHours: 2,
      fatiguePoints: 1,
    }))
  );
  return buildScheduleWorkbook(state, "2026-11-10");
}

async function exported(workbook: XLSX.WorkBook) {
  writeWorkbook(workbook, "test.xlsx");
  const blob = download.mock.calls.at(-1)![0] as Blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, zip: XLSX.CFB.read(bytes, { type: "array" }) };
}
function xml(zip: ReturnType<typeof XLSX.CFB.read>, index = 1): string {
  return new TextDecoder().decode(
    XLSX.CFB.find(zip, `/xl/worksheets/sheet${index}.xml`).content
  );
}
function zoom(xml: string) {
  return Number(/\bzoomScale="(\d+)"/.exec(xml)?.[1]);
}

describe("downloaded workbook default view", () => {
  beforeEach(() => download.mockClear());
  it("fits the five-flight roster and bottom summary in the normal workspace using the actual downloaded bytes", async () => {
    const wb = fixture();
    const { bytes, zip } = await exported(wb);
    const ratio = zoom(xml(zip)) / 100;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1);
    const ws = XLSX.read(bytes, { type: "array", cellStyles: true }).Sheets[
      "保障明细"
    ]!;
    const width = ws["!cols"]!.reduce((sum, c) => sum + c!.wpx!, 0);
    const height = ws["!rows"]!.reduce((sum, r) => sum + (r!.hpt! * 4) / 3, 0);
    expect(width * ratio).toBeLessThanOrEqual(1280);
    expect(height * ratio).toBeLessThanOrEqual(650);
    expect(xml(zip)).toContain('topLeftCell="A1"');
    expect(xml(zip)).not.toContain("序号");
  });
  it("recomputes zoom for wider or taller final tables and preserves readable lower bounds", async () => {
    const regular = zoom(xml((await exported(fixture())).zip));
    const wide = zoom(xml((await exported(fixture(8))).zip));
    const tall = zoom(xml((await exported(fixture(5, 45))).zip));
    expect(wide).toBeLessThan(regular);
    expect(tall).toBe(50);
    expect(zoom(xml((await exported(fixture(1, 1, 2))).zip))).toBe(100);
  });
  it("changes only the target sheet view inside the archive, including when it is not the first sheet", async () => {
    const wb = fixture();
    wb.SheetNames = [
      wb.SheetNames[1]!,
      wb.SheetNames[0]!,
      ...wb.SheetNames.slice(2),
    ];
    const before = XLSX.CFB.read(
      new Uint8Array(
        XLSX.write(structuredClone(wb), {
          type: "array",
          bookType: "xlsx",
          compression: true,
        })
      ),
      { type: "array" }
    );
    const { zip } = await exported(wb);
    expect(zoom(xml(zip, 2))).toBeGreaterThanOrEqual(50);
    expect(xml(zip, 1)).not.toContain("zoomScale");
    for (let i = 0; i < before.FullPaths.length; i++) {
      const path = before.FullPaths[i];
      if (path.endsWith("docProps/core.xml")) continue;
      const entry = before.FileIndex[i];
      const after = XLSX.CFB.find(zip, path);
      if (entry.type !== 2 || entry.name === "\u0001Sh33tJ5") continue;
      if (path.endsWith("xl/worksheets/sheet2.xml")) {
        const stripView = (content: Uint8Array) =>
          new TextDecoder()
            .decode(content)
            .replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, "");
        expect(stripView(after.content)).toBe(stripView(entry.content));
      } else
        expect(new Uint8Array(after.content)).toEqual(
          new Uint8Array(entry.content)
        );
    }
  });
  it("leaves exports without the print sheet on the original XLSX writer path", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["配置", "原文"]]),
      "参数"
    );
    const { bytes, zip } = await exported(wb);
    expect(xml(zip)).not.toContain("zoomScale");
    expect(XLSX.read(bytes, { type: "array" }).Sheets["参数"]!.B1.v).toBe(
      "原文"
    );
  });
});

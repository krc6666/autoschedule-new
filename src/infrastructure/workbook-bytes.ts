import * as XLSX from "xlsx-js-style";

function scheduleZoom(sheet: XLSX.WorkSheet): number {
  // A conservative worksheet area on a typical laptop, excluding toolbars.
  // Keep large sheets readable rather than shrinking unlimited content to fit.
  const width = (sheet["!cols"] ?? []).reduce(
    (sum, col) => sum + (col?.wpx ?? (col?.wch ?? 10) * 7 + 5),
    0
  );
  const height = (sheet["!rows"] ?? []).reduce(
    (sum, row) => sum + (row?.hpt ?? 26) * (4 / 3),
    0
  );
  return Math.max(
    50,
    Math.min(100, Math.floor(Math.min(1280 / width, 650 / height) * 95))
  );
}

export function workbookBytes(
  workbook: XLSX.WorkBook
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    XLSX.write(workbook, {
      bookType: "xlsx",
      type: "array",
      compression: true,
    })
  );
  const index = workbook.SheetNames.indexOf("保障明细");
  if (index === -1) return bytes;

  // xlsx-js-style reads zoom but omits it when writing. Patch only the generated
  // print sheet's view using its bundled ZIP implementation, preserving cells,
  // styles, merges and all other workbook entries.
  const zip = XLSX.CFB.read(bytes, { type: "array" });
  const entry = XLSX.CFB.find(zip, `/xl/worksheets/sheet${index + 1}.xml`);
  if (!entry) throw new Error("Excel保障明细工作表缺失，未导出文件。");
  const xml = new TextDecoder().decode(entry.content);
  const zoom = scheduleZoom(workbook.Sheets["保障明细"]!);
  const view = /<sheetView\b[^>]*>/;
  if (!view.test(xml)) throw new Error("Excel保障明细视图缺失，未导出文件。");
  const updated = xml.replace(view, (tag) => {
    const clean = tag.replace(
      /\s(?:zoomScale|zoomScaleNormal|topLeftCell)="[^"]*"/g,
      ""
    );
    return clean.replace(
      /\/?>$/,
      (end) =>
        ` zoomScale="${zoom}" zoomScaleNormal="${zoom}" topLeftCell="A1"${end}`
    );
  });
  entry.content = new TextEncoder().encode(updated);
  entry.size = entry.content.length;
  return new Uint8Array(
    XLSX.CFB.write(zip, { type: "array", fileType: "zip", compression: true })
  );
}

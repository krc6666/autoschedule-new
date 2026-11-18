"""Check anonymous browser output without importing the product statistics code."""
import json
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

prefix = Path("docs/acceptance/evidence/2026-11-18-relaxed-")
artifact = json.loads(Path(str(prefix) + "browser.json").read_text(encoding="utf-8"))
facts = artifact["facts"]

def minute(clock):
    hour, minutes = map(int, clock.split(":"))
    return hour * 60 + minutes

def end_minute(task):
    start, end = minute(task["startTime"]), minute(task["endTime"])
    return end + (1440 if end <= start else 0)

tasks = defaultdict(list)
for row in facts["history"]:
    if row["date"].startswith("2026-11") and row["date"] != facts["date"]:
        tasks[(row["staffId"], row["date"])].append(row)
for row in facts["assignments"]:
    if row["status"] == "assigned":
        tasks[(row["staffId"], facts["date"])].append(row)

expected = defaultdict(lambda: defaultdict(list))
for (staff_id, day), day_tasks in tasks.items():
    last = max(day_tasks, key=end_minute)
    latest_cutoff = max(
        minute(next((f["endTime"] for f in facts["flights"] if f["flightNo"] == row["flightNo"]), row["endTime"]))
        for row in day_tasks
    )
    if end_minute(last) < minute(facts["earlyCutoff"]) and latest_cutoff <= 23 * 60:
        expected[staff_id][last["flightNo"]].append(day[5:])
    off = all(minute(row["startTime"]) <= 12 * 60 for row in day_tasks)
    overlapping = any(minute(row["startTime"]) < minute(facts["afternoonEnd"]) and end_minute(row) > minute(facts["afternoonStart"]) for row in day_tasks)
    free = not off and not overlapping and any(minute(row["startTime"]) >= minute(facts["afternoonEnd"]) for row in day_tasks)
    if off:
        expected[staff_id]["下午休"].append(day[5:])
    if free:
        expected[staff_id]["下午空"].append(day[5:])

checked = 0
for name in ("original", "final"):
    for row in artifact[name]["rows"]:
        staff_id = next(person["id"] for person in facts["staff"] if person["name"] == row["name"])
        for cell in row["cells"]:
            dates = sorted(set(expected[staff_id][cell["column"]]))
            assert cell["count"] == len(dates), (name, row["name"], cell, dates)
            assert cell["dates"] == ("、".join(dates) if dates else "暂无日期")
            checked += 1

ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(str(prefix) + "config.xlsx") as archive:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheets = workbook.find("x:sheets", ns)
    target = next(sheet for sheet in sheets if sheet.attrib["name"] == "轻松班次航班范围")
    relationship_id = target.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    relationship = next(item for item in relations if item.attrib["Id"] == relationship_id)
    sheet_path = relationship.attrib["Target"].lstrip("/")
    if not sheet_path.startswith("xl/"):
        sheet_path = "xl/" + sheet_path
    strings = []
    if "xl/sharedStrings.xml" in archive.namelist():
        strings = ["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
    rows = []
    for row in ET.fromstring(archive.read(sheet_path)).findall("x:sheetData/x:row", ns):
        values = []
        for cell in row:
            value = cell.find("x:v", ns)
            text = value.text if value is not None else "".join(cell.itertext())
            values.append(strings[int(text)] if cell.attrib.get("t") == "s" else text)
        rows.append(values)
    assert rows[0] == ["选择方式", "航班号"]
    assert all(row[0] == "指定" for row in rows[1:])
    assert [row[1] for row in rows[1:]] == artifact["final"]["headers"][1:-2]

summary = {
    "checkedCells": checked,
    "method": "Independent Python minute arithmetic from anonymous actual tasks; compare count and MM-DD dates; standard-library XLSX ZIP/XML checks scope values",
    "excelScopeFlights": len(rows) - 1,
    "browserPageErrors": artifact["pageErrors"],
    "result": "passed",
}
Path(str(prefix) + "independent.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False))

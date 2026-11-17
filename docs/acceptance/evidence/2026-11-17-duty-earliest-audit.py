"""Independently audit anonymous Worker output and exported XLSX bytes."""
import hashlib
import itertools
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

prefix = Path(__file__).with_name("2026-11-17-duty-earliest-artifact")
data = json.loads(prefix.with_suffix(".json").read_text(encoding="utf-8"))
state, result = data["input"], data["result"]
flights = {flight["id"]: flight for flight in state["flights"]}
rules = {rule["id"]: rule for rule in state["positionRules"]}
staff = {person["id"]: person for person in state["staff"]}


def minute(value):
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def legal(rows):
    by_staff = {}
    for row in rows:
        person = staff[row["staffId"]]
        rule = rules[row["positionRuleId"]]
        assert person["status"] == "正常"
        assert row["staffId"] in rule["qualifiedStaffIds"]
        start, end = map(minute, (row["startTime"], row["endTime"]))
        assert end > start  # This anonymous fixture has no midnight crossing.
        by_staff.setdefault(row["staffId"], []).append((start, end))
    for periods in by_staff.values():
        periods.sort()
        if any(a[1] > b[0] for a, b in zip(periods, periods[1:])):
            return False
        if sum(end - start for start, end in periods) / 60 > state["settings"]["maxDailyHours"]:
            return False
    return True


rows = result["assignments"]
assert len(rows) == len(rules) == 3
assert all(row["status"] == "assigned" for row in rows)
assert result["unfilledCount"] == 0
assert legal(rows)
assert data["restoredAssignments"] == rows
assert result["safetyCredential"]["phase"] == "final"
morning_min = minute(state["settings"]["nightEnd"])
duty_rows = [row for row in rows if row["staffId"] == "p0"]
actual_start = min(minute(flights[row["flightId"]]["startTime"]) for row in duty_rows
                   if morning_min <= minute(flights[row["flightId"]]["startTime"]) < 720)
assert next(row for row in rows if row["flightId"] == "late")["staffId"] == "p0"

# Enumerate this small fixture independently; do not call any scheduling helper.
feasible_starts = []
for people in itertools.product(*[rules[row["positionRuleId"]]["qualifiedStaffIds"] for row in rows]):
    candidate = [dict(row, staffId=person) for row, person in zip(rows, people)]
    if next(row for row in candidate if row["flightId"] == "late")["staffId"] != "p0" or not legal(candidate):
        continue
    starts = [minute(row["startTime"]) for row in candidate
              if row["staffId"] == "p0" and morning_min <= minute(row["startTime"]) < 720]
    if starts:
        feasible_starts.append(min(starts))
assert actual_start == min(feasible_starts) == 420

ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(prefix.with_suffix(".xlsx")) as workbook:
    strings = []
    if "xl/sharedStrings.xml" in workbook.namelist():
        shared = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
        strings = ["".join(node.itertext()) for node in shared.findall("m:si", ns)]
    sheet = ET.fromstring(workbook.read("xl/worksheets/sheet2.xml"))
    exported = []
    for row in sheet.findall("m:sheetData/m:row", ns):
        cells = {}
        for cell in row.findall("m:c", ns):
            column = "".join(c for c in cell.get("r") if c.isalpha())
            index = 0
            for letter in column:
                index = index * 26 + ord(letter) - ord("A") + 1
            value = cell.find("m:v", ns)
            value = value.text if value is not None else ""
            if cell.get("t") == "s":
                value = strings[int(value)]
            elif cell.get("t") == "inlineStr":
                value = "".join(cell.find("m:is", ns).itertext())
            cells[index - 1] = value
        exported.append([cells.get(i, "") for i in range(max(cells, default=-1) + 1)])
headers = exported[0]
records = [dict(zip(headers, values)) for values in exported[1:]]
assert len(records) == 3
assert next(row for row in records if row["航班号"] == "AA101")["人员编号"] == "p0"
assert next(row for row in records if row["航班号"] == "AA101")["开始时间"] == "07:00"
assert next(row for row in records if row["航班号"] == "ZZ900")["人员编号"] == "p0"
print(json.dumps({
    "source": "real Worker handler + WASM, Store install, persistence, XLSX export; anonymous fixture",
    "date": data["date"], "positions": len(rows), "assigned": len(rows), "vacancies": 0,
    "dutyEarliestMinutes": actual_start, "independentlyOptimalMinutes": min(feasible_starts),
    "lateDutyRetained": True, "independentQualificationsHoursAndConflicts": "passed",
    "jsonMatchesPersistence": True, "xlsxMatchesFinalRows": True,
    "artifactSha256": {ext: hashlib.sha256(prefix.with_suffix(ext).read_bytes()).hexdigest() for ext in [".json", ".xlsx"]},
    "ownerPageAcceptance": "pending; automatic evidence does not replace real page acceptance",
}, ensure_ascii=False, indent=2))

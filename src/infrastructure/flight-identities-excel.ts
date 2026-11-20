import type * as XLSX from "xlsx-js-style";
import type { FlightIdentity } from "../model";
import { validateFlightIdentities } from "../domain/flights/flight-identities";
import { append, rows } from "./excel-worksheet";

const sheet = "航班长期档案";
const header = [
  "档案编号",
  "统一名称",
  "原航班号",
  "生效日期",
  "截至日期",
  "岗位来源航班号",
];

export function appendFlightIdentities(
  book: XLSX.WorkBook,
  identities: readonly FlightIdentity[] = []
) {
  append(
    book,
    sheet,
    [
      header,
      ...identities.flatMap((i) =>
        i.aliases.map((a) => [
          i.id,
          i.displayName,
          a.flightNo,
          a.from ?? "",
          a.until ?? "",
          a.positionSourceFlightNo ?? "",
        ])
      ),
    ],
    [28, 24, 24, 18, 18, 24]
  );
}

export function parseFlightIdentities(book: XLSX.WorkBook): {
  value?: FlightIdentity[];
  errors: string[];
} {
  if (!book.Sheets[sheet]) return { errors: [] };
  const data = rows(book, sheet);
  if (header.some((v, index) => data[0]?.[index] !== v))
    return { errors: ["航班长期档案表头不完整，整个配置未导入"] };
  const identities = new Map<string, FlightIdentity>();
  const errors: string[] = [];
  for (const row of data.slice(1)) {
    const [id, displayName, flightNo, from, until, positionSourceFlightNo] =
      header.map((_, i) => String(row[i] ?? "").trim());
    if (!row.some((v) => String(v).trim())) continue;
    const previous = identities.get(id!);
    if (previous && previous.displayName !== displayName)
      errors.push(`${id}的统一名称不一致`);
    const identity = previous ?? {
      id: id!,
      displayName: displayName!,
      aliases: [],
    };
    identity.aliases.push({
      flightNo: flightNo!,
      ...(from ? { from } : {}),
      ...(until ? { until } : {}),
      ...(positionSourceFlightNo ? { positionSourceFlightNo } : {}),
    });
    identities.set(id!, identity);
  }
  const value = [...identities.values()];
  errors.push(...validateFlightIdentities(value));
  return errors.length ? { errors } : { value, errors };
}

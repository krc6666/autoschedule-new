import type { StructuredSchedulePolicies } from "./structured-policy-contract";

export function enabledAirlineMixPolicies(
  settings: Pick<StructuredSchedulePolicies, "airlineMixPolicies">
) {
  return settings.airlineMixPolicies.filter(
    (p) => p.enabled && p.airlineCodes.length >= 2
  );
}

/** Configuration input only: carrier codes, never flight numbers. */
export function normalizeAirlineMixCodes(value: unknown): string[] | null {
  const values =
    typeof value === "string" ? value.split(/[\s,，、;/；]+/) : value;
  if (!Array.isArray(values)) return null;
  const codes = values
    .map((v) => String(v).trim().toUpperCase())
    .filter(Boolean);
  if (
    codes.some((code) => !/^[A-Z0-9]{2,3}$/.test(code) || !/[A-Z]/.test(code))
  )
    return null;
  return [...new Set(codes)];
}

export const DEFAULT_STAFF_STATUS_OPTIONS = ["正常", "病假", "休假"] as const;

export function normalizeStaffStatusOptions(
  value: unknown,
  observedStatuses: readonly unknown[] = []
): string[] {
  const options = [
    ...(Array.isArray(value) ? value : []),
    ...observedStatuses,
  ].filter((item): item is string => typeof item === "string");
  const builtins: readonly string[] = DEFAULT_STAFF_STATUS_OPTIONS;
  const customOptions = options
    .map((item) => item.trim())
    .filter((item) => item && !builtins.includes(item));
  return [...DEFAULT_STAFF_STATUS_OPTIONS, ...new Set(customOptions)];
}

export function isStaffAvailable(status: string | null | undefined): boolean {
  return status === DEFAULT_STAFF_STATUS_OPTIONS[0];
}

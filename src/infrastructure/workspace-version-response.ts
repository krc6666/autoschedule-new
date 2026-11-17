import { CloudError } from "../app/cloud-contract";
import type { WorkspaceVersion } from "../app/workspace-version-contract";

export function parseWorkspaceVersions(value: unknown): WorkspaceVersion[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new CloudError("invalid", "历史版本列表格式不正确，请重试。");
  const ids = new Set<string>();
  let previousVersion = Infinity;
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !/^[1-9]\d*$/.test(entry.id) ||
      ids.has(entry.id) ||
      !("version" in entry) ||
      typeof entry.version !== "number" ||
      !Number.isSafeInteger(entry.version) ||
      entry.version <= 0 ||
      entry.version >= previousVersion ||
      !("createdAt" in entry) ||
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      !("actor" in entry) ||
      (entry.actor !== null &&
        (typeof entry.actor !== "string" || !entry.actor.trim()))
    )
      throw new CloudError(
        "invalid",
        "历史版本资料不完整，未显示或恢复，请重试。"
      );
    ids.add(entry.id);
    previousVersion = entry.version;
    return {
      id: entry.id,
      version: entry.version,
      createdAt: entry.createdAt,
      actor: entry.actor,
    };
  });
}

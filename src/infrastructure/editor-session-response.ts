import { CloudError, type EditorLoginRequest } from "../app/cloud-contract";

export function parseEditorLoginRequest(value: unknown): EditorLoginRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length < 16 ||
    value.id.length > 200 ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !["pending", "approved", "rejected", "expired", "cancelled"].includes(
      value.status
    ) ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new CloudError(
      "invalid",
      "登录申请回执不完整，未授予编辑权限，请重试。"
    );
  return {
    id: value.id,
    status: value.status as EditorLoginRequest["status"],
    expiresAt: value.expiresAt,
  };
}

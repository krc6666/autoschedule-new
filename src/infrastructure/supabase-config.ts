export interface CloudConfiguration {
  url: string;
  publicKey: string;
}

export function readCloudConfiguration(
  env: Record<string, string | undefined>
): CloudConfiguration | null {
  const url = env.VITE_SUPABASE_URL?.trim() ?? "";
  const publicKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!url && !publicKey) return null;
  if (!url || !publicKey)
    throw new Error("云端配置不完整，请同时填写项目网址和公开密钥。");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Supabase 项目网址无效。");
  }
  if (
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname)
      )) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("Supabase 项目网址必须是 HTTPS 根地址（本机开发除外）。");
  }
  let allowed = publicKey.startsWith("sb_publishable_");
  if (!allowed && publicKey.split(".").length === 3) {
    try {
      const payload = JSON.parse(
        atob(publicKey.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))
      );
      allowed = payload.role === "anon";
    } catch {
      /* Reject unrecognized or private keys without echoing them. */
    }
  }
  if (!allowed)
    throw new Error(
      "这里只能使用 publishable 或旧版 anon 公开密钥，禁止填写私密密钥。"
    );
  return { url: parsed.origin, publicKey };
}

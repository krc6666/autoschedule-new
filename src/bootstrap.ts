import { mountAutoscheduleApp } from "./app";
import { readCloudConfiguration } from "./infrastructure/supabase-config";

/** A bad cloud configuration must never expose an editable local fallback. */
export async function mountConfiguredApplication(
  root: HTMLElement
): Promise<{ dispose(): void }> {
  try {
    const configuration = readCloudConfiguration(import.meta.env);
    const publicRoute = new URLSearchParams(window.location.hash.slice(1)).has(
      "schedule"
    );
    if (!configuration) {
      if (publicRoute)
        throw new Error("此站点尚未配置云端服务，无法读取发布链接。");
      return mountAutoscheduleApp(root);
    }
    const [{ createSupabaseBackend }, { mountCloudApplication }] =
      await Promise.all([
        import("./infrastructure/supabase-backend"),
        import("./app/cloud-application"),
      ]);
    return mountCloudApplication(
      root,
      createSupabaseBackend(configuration),
      configuration.url
    );
  } catch (error) {
    const notice = document.createElement("p");
    notice.className = "container py-5";
    notice.setAttribute("role", "alert");
    notice.textContent =
      error instanceof Error ? error.message : "应用未能启动。";
    root.replaceChildren(notice);
    return { dispose: () => notice.remove() };
  }
}

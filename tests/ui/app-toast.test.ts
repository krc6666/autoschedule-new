// @vitest-environment happy-dom

import Toast from "bootstrap/js/dist/toast";
import { describe, expect, it, vi } from "vitest";

import "../../src/ui/components/app-toast";
import { mountElement } from "./lit-test-helpers";
import { UI_COMMAND_EVENT } from "../../src/ui/events/ui-command";
import type { AppToastElement } from "../../src/ui/components/app-toast";

interface ToastInstance {
  _config: {
    autohide: boolean;
    delay: number;
  };
}

describe("application toast", () => {
  it("shows each vacant position with its own collapsed reason in the yellow notification", async () => {
    const element = await mountElement("autoschedule-app-toast", {
      toast: {
        id: 3,
        message: "班表已生成，以下岗位未排上人：",
        tone: "warning",
        details: {
          code: "local-vacancies",
          date: "2026-10-14",
          reason: "以下岗位留空",
          facts: ["KE166 / H05：空岗", "TR121 / H03：空岗"],
          vacancies: [
            {
              assignmentId: "h05",
              label: "KE166 / H05：空岗",
              reasons: ["其他人员这段时间都有工作，无法接这个柜台。"],
            },
            { assignmentId: "h03", label: "TR121 / H03：空岗", reasons: [] },
          ],
          steps: [],
        },
      },
    });
    expect(element.textContent).toContain("KE166 / H05：空岗");
    expect(element.textContent).toContain("TR121 / H03：空岗");
    const details = Array.from(
      element.querySelectorAll<HTMLDetailsElement>("details")
    );
    expect(details).toHaveLength(2);
    expect(details.every((detail) => !detail.open)).toBe(true);
    expect(
      details.map((detail) => detail.querySelector("summary")?.textContent)
    ).toEqual(["原因", "原因"]);
    details[0]!.querySelector("summary")!.click();
    expect(details[0]!.open).toBe(true);
    expect(details[1]!.open).toBe(false);
    expect(details[0]!.textContent).toContain("其他人员这段时间都有工作");
    expect(details[1]!.textContent).toContain("这次没有记录到具体原因");
    expect(element.textContent).not.toContain("查看原因和解决办法");
    expect(element.textContent).not.toContain("导出诊断记录");
  });
  it("resets expanded vacancy reasons when the next schedule notification arrives", async () => {
    const reasons = [
      "这次换人会超过设置规定的下班时间。",
      "其他合法岗位已保留。",
    ];
    const firstToast = {
      id: 10,
      message: "班表已生成，以下 1 个岗位未排上人：",
      tone: "warning" as const,
      details: {
        code: "local-vacancies" as const,
        date: "2026-10-15",
        reason: "以下岗位未排上人",
        facts: ["TW616 / 督导：空岗"],
        steps: [],
        vacancies: [
          { assignmentId: "same-slot", label: "TW616 / 督导：空岗", reasons },
        ],
      },
    };
    const element = await mountElement<AppToastElement>(
      "autoschedule-app-toast",
      { toast: firstToast }
    );
    const detail = element.querySelector<HTMLDetailsElement>("details")!;
    detail.querySelector("summary")!.click();
    expect(detail.open).toBe(true);
    expect(
      Array.from(detail.querySelectorAll("p")).map((p) => p.textContent)
    ).toEqual(reasons);
    const instance = Toast.getInstance(
      element.querySelector<HTMLElement>(".toast")!
    ) as unknown as ToastInstance;
    expect(instance._config.autohide).toBe(false);
    element.toast = {
      ...firstToast,
      id: 11,
      details: {
        ...firstToast.details,
        vacancies: [
          {
            assignmentId: "same-slot",
            label: "TW616 / 督导：空岗",
            reasons: ["本次原因已更新。"],
          },
        ],
      },
    };
    await element.updateComplete;
    expect(element.querySelector<HTMLDetailsElement>("details")!.open).toBe(
      false
    );
    expect(element.textContent).toContain("本次原因已更新");
    expect(element.textContent).not.toContain(reasons[0]);
  });
  it.each(["ke166-distinct-staff-capacity", "program-error"])(
    "shows %s failure help collapsed and emits a diagnostic export command",
    async (code) => {
      const element = await mountElement<
        HTMLElement & { updateComplete: Promise<unknown> }
      >("autoschedule-app-toast", {
        toast: {
          id: 1,
          message: "KE166的人手安排未通过检查",
          tone: "danger",
          details: {
            code,
            date: "2026-10-14",
            reason: "柜台仍有其他人员可承担",
            facts: ["人员甲目前没有安排岗位"],
            steps: ["保留原班表，导出诊断记录交给开发人员检查。"],
            diagnosticMessages: ["RuntimeError: unreachable"],
          },
        },
      });
      const details = element.querySelector<HTMLDetailsElement>("details")!;
      expect(details).not.toBeNull();
      expect(details.open).toBe(false);
      expect(details.querySelector("summary")?.textContent).toContain(
        "查看原因和解决办法"
      );
      details.open = true;
      expect(details.textContent).toContain("人员甲目前没有安排岗位");
      expect(element.textContent).not.toContain("RuntimeError");
      const listener = vi.fn();
      element.addEventListener(UI_COMMAND_EVENT, listener);
      const button = Array.from(details.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("导出诊断记录")
      )!;
      button.click();
      expect(listener).toHaveBeenCalled();
      expect(listener.mock.calls[0]![0].detail).toEqual({
        type: "export-schedule-failure-details",
      });
    }
  );
  it("replaces a visible notification before its animation ends without crashing", async () => {
    vi.useFakeTimers();
    try {
      const element = await mountElement<
        HTMLElement & {
          updateComplete: Promise<unknown>;
          toast: { id: number; message: string; tone: "warning" };
        }
      >("autoschedule-app-toast", {
        toast: { id: 1, message: "排班正在计算", tone: "warning" },
      });

      element.toast = {
        id: 2,
        message: "请等待当前任务完成",
        tone: "warning",
      };
      await element.updateComplete;

      expect(() => vi.runAllTimers()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps danger errors visible until the close button is used", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-toast", {
      toast: { id: 1, message: "生成失败", tone: "danger" },
    });

    const toast = element.querySelector<HTMLElement>(".toast")!;
    const instance = Toast.getInstance(toast) as unknown as ToastInstance;

    expect(instance._config.autohide).toBe(false);
    expect(element.querySelector('button[aria-label="关闭"]')).not.toBeNull();
  });

  it("keeps success notifications on the existing timed dismissal", async () => {
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-app-toast", {
      toast: { id: 2, message: "生成成功", tone: "success" },
    });

    const toast = element.querySelector<HTMLElement>(".toast")!;
    const instance = Toast.getInstance(toast) as unknown as ToastInstance;

    expect(instance._config.autohide).toBe(true);
    expect(instance._config.delay).toBe(3600);
  });
});

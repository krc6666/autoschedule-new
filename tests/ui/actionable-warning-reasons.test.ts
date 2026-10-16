// @vitest-environment happy-dom
import { expect, it } from "vitest";
import "../../src/ui/components/schedule-feedback";
import "../../src/ui/components/app-toast";
import { mountElement } from "./lit-test-helpers";
import { createDefaultState } from "../../src/defaults";
import { feedbackItem } from "../../src/domain/feedback/schedule-feedback-model";
import Toast from "bootstrap/js/dist/toast";
import type { AppToastElement } from "../../src/ui/components/app-toast";

it("keeps feedback concise and exposes every recorded rule in collapsed evidence", async () => {
  const evidence =
    "空岗：严格跨工作日恢复 3 人；跨航班优先 1 人\n人员甲：2026-10-15 TR121/H02 21:55–23:55\n人员乙：KE166/H03 09:15–11:15";
  const item = feedbackItem(
    "flight-staff",
    "coverage",
    "人员覆盖",
    "attention",
    evidence
  );
  const element = await mountElement("autoschedule-schedule-feedback", {
    model: createDefaultState(),
    view: { feedback: [item] },
    date: "2026-10-17",
  });
  const detail = element.querySelector<HTMLDetailsElement>("details")!;
  expect(item.text).toBe(evidence.split("\n")[0]);
  expect(detail.open).toBe(false);
  expect(detail.textContent).toContain("TR121/H02 21:55–23:55");
  expect(detail.textContent).toContain("KE166/H03 09:15–11:15");
  detail.querySelector("summary")!.click();
  expect(detail.open).toBe(true);
});

it("shows the manual result first and keeps full reasons in the yellow notification", async () => {
  const message =
    "人工调整已保留，突破以下限制：\n人员甲不在G18资质名单\n人员甲与KE166/H03 09:15–11:15时间冲突";
  const element = await mountElement<AppToastElement>(
    "autoschedule-app-toast",
    {
      toast: { id: 41, tone: "warning", message },
    }
  );
  const detail = element.querySelector<HTMLDetailsElement>("details")!;
  expect(detail.open).toBe(false);
  expect(detail.textContent).toContain("不在G18资质名单");
  expect(detail.textContent).toContain("KE166/H03 09:15–11:15");
  expect(element.textContent).toContain("人工调整已保留");
  const instance = Toast.getInstance(
    element.querySelector<HTMLElement>(".toast")!
  ) as unknown as { _config: { autohide: boolean } };
  expect(instance._config.autohide).toBe(false);
  detail.querySelector("summary")!.click();
  expect(detail.open).toBe(true);
  element.toast = { id: 42, tone: "warning", message };
  await element.updateComplete;
  expect(element.querySelector<HTMLDetailsElement>("details")!.open).toBe(
    false
  );
});

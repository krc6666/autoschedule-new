import { expect, it } from "vitest";
import { presentScheduleFailure } from "../../src/app/schedule-failure-presentation";
import { ScheduleGuardError } from "../../src/domain/kernel/schedule-guard";
import { ScheduleController } from "../../src/app/controllers/schedule-controller";
import {
  createTestApplicationCoordinator,
  createTestAutoscheduleStore,
  setTestScheduleRunner,
} from "../helpers/application";
import { vi } from "vitest";

function visible(error: unknown): string {
  const result = presentScheduleFailure(error);
  return [
    result.summary,
    result.details.reason,
    ...result.details.facts,
    ...result.details.steps,
  ].join(" ");
}

it.each([
  {
    ruleId: "minimum-flight-transition",
    message: "人员甲与上一航班间隔只有 30 分钟，少于要求的 90 分钟。",
    expected: "至少留90分钟",
  },
  {
    ruleId: "position-transition",
    message: "人员甲安排TEST100/H01违反严格岗位衔接规则internal-policy-id",
    expected: "人员甲被安排到TEST100/H01",
  },
  {
    ruleId: "same-flight-staff-exclusion",
    message: "人员甲与人员乙不能同时安排在TEST100，自动排班拒绝提交",
    expected: "不能一起做这个航班",
  },
  {
    ruleId: "strict-next-workday-recovery",
    message:
      "人员甲上一工作班晚班后不得安排TEST100/H01，违反严格跨工作日恢复目标",
    expected: "人员甲上一班做了",
  },
  {
    ruleId: "mobile-supervisor",
    message: "TEST100/H05的督导补位关联缺少来源，拒绝提交",
    expected: "找不到对应的督导岗位",
  },
  {
    ruleId: "half-rest",
    message: "半休时段硬约束：上午半休人员不得安排12点前岗位",
    expected: "却被安排到12点前",
  },
  {
    ruleId: "unknown-internal-rule",
    message: "internal-model-broken",
    expected: "还不能",
  },
])("explains $ruleId using recorded evidence", ({ expected, ...violation }) => {
  const error = new ScheduleGuardError([violation]);
  expect(visible(error)).toContain(expected);
  expect(visible(error)).not.toMatch(/internal|硬约束|守卫|拒绝提交/);
  expect(presentScheduleFailure(error).details.diagnosticMessages).toEqual([
    error.message,
  ]);
});

it("keeps all reported problems, including an ordinary check beside KE166 details", () => {
  const details = {
    code: "ke166-distinct-staff-capacity" as const,
    reason: "人员甲没有其他工作",
    facts: ["柜台时间09:15—11:15"],
    steps: ["核对实际情况"],
  };
  const error = new ScheduleGuardError([
    { ruleId: "ke166-supervisor", message: "内部错误", details },
    {
      ruleId: "mobile-supervisor",
      message: "TEST100/H05的督导补位关联缺少来源，拒绝提交",
    },
    {
      ruleId: "ke166-supervisor",
      message: "另一处内部错误",
      details: {
        ...details,
        reason: "还有另一处柜台问题",
        facts: ["另一个柜台时间10:00—12:00"],
      },
    },
  ]);
  expect(visible(error)).toContain(details.reason);
  expect(visible(error)).toContain("找不到对应的督导岗位");
  expect(visible(error)).toContain("还有另一处柜台问题");
  expect(visible(error)).not.toContain("拒绝提交");
  expect(presentScheduleFailure(error).details.diagnosticMessages).toEqual([
    error.message,
  ]);
});

it.each([
  {
    message:
      "当天无法生成完整班表。人员甲选择了上午半休，只能安排下午岗位；但当前下午没有人员甲能上的岗位（资质或其他条件不符合），会导致全天没有航班，因此本次重新排班未采用。",
    expected: "人员甲选择了上午半休",
  },
  {
    message:
      "当天无法生成完整班表。TEST100/H01：基础合格的 2 人全部被上一班末班重点岗位避让排除；局部岗位允许留空。",
    expected: "基础合格的 2 人全部被上一班末班重点岗位避让排除",
  },
  {
    message:
      "当天无法生成完整班表。TEST100/H01、TEST200/H01：只有人员甲可用，合计 10.00 小时会超过每日 8 小时上限；局部岗位允许留空。",
    expected: "合计 10.00 小时会超过每日 8 小时上限",
  },
  {
    message: "最终安全复核未通过：TEST100/H01必须且只能保留一个排班结果",
    expected: "TEST100/H01在新班表中缺失或出现了重复记录",
  },
  {
    message: "最终安全复核未通过：TEST100/H01的人员不存在",
    expected: "在当前人员名单中找不到的人",
  },
  {
    message: "最终安全复核未通过：TEST100/H01人员甲 将超过每日 8 小时上限",
    expected: "会超过8小时",
  },
  {
    message: "Worker 创建失败：SecurityError: script blocked",
    expected: "本次还没有开始计算",
  },
  {
    message: "Worker 数据发送失败：DataCloneError: failed",
    expected: "没能把本次数据交给后台排班程序",
  },
  {
    message: "当天班表未采用：关键排班规则未全部完成",
    expected: "没有通过最后检查",
  },
])(
  "explains the known calculation error: $message",
  ({ message, expected }) => {
    const error = new Error(
      message.startsWith("Worker") ? message : `Worker 运行失败：${message}`
    );
    expect(visible(error)).toContain(expected);
    expect(visible(error)).not.toMatch(/Worker|硬约束|候选|严格恢复|安全复核/);
  }
);

it.each([new Error("WASM RuntimeError: unreachable"), "unknown failure", null])(
  "does not invent a cause for unknown errors: %s",
  (error) => {
    expect(visible(error)).toContain("还不能确定");
    expect(presentScheduleFailure(error).details.code).toBe("program-error");
    expect(visible(error)).not.toMatch(
      /WASM|RuntimeError|unreachable|unknown failure/
    );
  }
);

it("also explains errors from the direct main-thread generate path without changing data", async () => {
  const coordinator = createTestApplicationCoordinator(
    createTestAutoscheduleStore(),
    {
      preferences: {
        loadScheduleDate: () => "2026-10-14",
        saveScheduleDate: () => undefined,
        loadScheduleZoom: () => null,
        saveScheduleZoom: () => undefined,
      },
    }
  );
  const original = structuredClone(coordinator.model());
  setTestScheduleRunner(coordinator, {
    calculate: vi
      .fn()
      .mockRejectedValue(
        new Error("当天排班计算超过允许时间（最长5分钟），请重试")
      ),
    isRunning: () => false,
  });
  await new ScheduleController(coordinator).generate("2026-10-14");
  expect(coordinator.model()).toEqual(original);
  expect(coordinator.view().toast?.details).toMatchObject({
    code: "calculation-timeout",
    date: "2026-10-14",
  });
});

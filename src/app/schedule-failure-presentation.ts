import { conciseAssignmentWarningReason } from "../domain/reviews/schedule-warning-message";
import { guardExplanation } from "../domain/shared/schedule-issue-explanation";
import { ScheduleGuardError } from "../domain/kernel/schedule-guard";
import type { ScheduleFailureDetails } from "../domain/shared/schedule-failure-details";

const preserved = "本次没有采用新班表，原班表和原数据已保留。";
const checkInputs =
  "核对准备窗口中的人员状态、半休选择和航班时间；再核对配置中的岗位可选人员、夜班能力和规则页的相关设置。只按实际情况修正，不要为了生成班表随意改资质或关闭安全规则。";
const report =
  "如果这些信息都正确，请导出下面的诊断记录交给开发人员检查。记录会保留程序原始报错，方便查找原因。";

function guardSummary(ruleId: string): string {
  switch (ruleId) {
    case "daily-primary-position-unique":
      return "同一个人被安排了两次一号岗位";
    case "half-rest":
      return "半休人员的上班安排不符合要求";
    case "minimum-flight-transition":
      return "有人两个航班之间的间隔太短";
    case "same-flight-staff-exclusion":
      return "不能一起做同一航班的人员被排到了一起";
    case "mobile-supervisor":
      return "督导补位安排没有正确对应";
    case "duty-position":
      return "必须保留的值班安排发生了变化";
    default:
      return "新班表中的人员安排没有通过检查";
  }
}

function calculationFacts(message: string): string[] {
  const separator = message.indexOf("\u3002");
  const diagnostics = separator >= 0 ? message.slice(separator + 1) : "";
  return [conciseAssignmentWarningReason(diagnostics ? [diagnostics] : [])];
}

export function presentScheduleFailure(error: unknown): {
  summary: string;
  details: ScheduleFailureDetails;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const diagnosticMessages = [raw];
  if (error instanceof ScheduleGuardError) {
    const primary = error.violations.find((item) => item.details);
    if (primary?.details)
      return {
        summary:
          primary.details.code === "ke166-distinct-staff-capacity"
            ? "KE166的人手安排未通过检查"
            : guardSummary(primary.ruleId),
        details: {
          ...primary.details,
          facts: error.violations.flatMap((item) =>
            item === primary
              ? primary.details!.facts
              : item.details
                ? [item.details.reason, ...item.details.facts]
                : [guardExplanation(item)]
          ),
          steps: [
            ...new Set(
              error.violations.flatMap(
                (item) =>
                  item.details?.steps ?? [preserved, checkInputs, report]
              )
            ),
          ],
          diagnosticMessages,
        },
      };
    return {
      summary: guardSummary(error.violations[0]?.ruleId ?? ""),
      details: {
        code: "schedule-check",
        reason:
          "系统算出的新班表里有不符合要求的安排，因此没有采用。检查发现的问题如下；还需要核对是输入信息不符，还是程序安排出了问题。",
        facts: error.violations.length
          ? error.violations.map(guardExplanation)
          : ["系统没有提供具体的检查问题，当前信息不足以确定原因。"],
        steps: [preserved, checkInputs, report],
        diagnosticMessages,
      },
    };
  }
  const message = raw.replace(/^Worker (?:运行|创建|数据发送)失败：/, "");
  if (
    raw.startsWith("Worker 创建失败：") ||
    raw.startsWith("Worker 数据发送失败：")
  )
    return {
      summary: "后台排班没有正常启动",
      details: {
        code: "program-error",
        reason: raw.startsWith("Worker 创建失败：")
          ? "页面没能启动后台排班程序，本次还没有开始计算。"
          : "页面没能把本次数据交给后台排班程序，本次无法继续计算。",
        facts: [
          "当前报错还不能确定具体原因；不能据此认定是人员配置错误或网络故障。",
        ],
        steps: [
          preserved,
          "请重试一次；若仍失败，先导出诊断记录。刷新页面前可先导出配置，方便保留当前工作。",
          report,
        ],
        diagnosticMessages,
      },
    };
  if (/^当天(?:整体)?排班计算超过允许时间/.test(message))
    return {
      summary: "计算时间太长，尚未完成排班",
      details: {
        code: "calculation-timeout",
        reason: "计算到了本次允许的时间上限，还没有得到可以采用的完整班表。",
        facts: ["单凭超时不能判断是网络问题，也不能确定哪项配置有问题。"],
        steps: [
          preserved,
          "先用相同条件重试一次。如果一直超时，请导出诊断记录，让开发人员检查为什么这组安排计算不完。",
        ],
        diagnosticMessages,
      },
    };
  if (message.startsWith("当天无法生成完整班表"))
    return {
      summary: "当前条件下没有找到符合要求的班表",
      details: {
        code: "no-safe-schedule",
        reason: "这次无法同时满足全部排班要求，因此没有采用新班表。",
        facts: calculationFacts(message),
        steps: [
          preserved,
          checkInputs,
          ...(message.includes("严格")
            ? [
                "核对规则页“次班重点岗位避让”中的航班、岗位和模式，以及上一班晚班记录。局部缺人允许留空，不能仅凭局部限制断言整班无解；请保留诊断记录检查。",
              ]
            : []),
          report,
        ],
        diagnosticMessages,
      },
    };
  if (
    message.startsWith("最终安全复核未通过") ||
    message.includes("关键排班规则未全部完成") ||
    message.includes("安全凭证")
  )
    return {
      summary: "新班表没有通过最后检查",
      details: {
        code: "schedule-check",
        reason: "程序算出的班表还没有满足全部要求，这份结果不能采用。",
        facts: [safetyExplanation(message)],
        steps: [preserved, checkInputs, report],
        diagnosticMessages,
      },
    };
  if (message === "当天排班计算未完成，请重试")
    return {
      summary: "本次计算没有完成",
      details: {
        code: "calculation-incomplete",
        reason: "计算结束时没有返回可采用的班表；当前信息还不能确定原因。",
        facts: [],
        steps: [
          preserved,
          "请重试一次；如果仍然失败，请导出诊断记录交给开发人员检查。",
        ],
        diagnosticMessages,
      },
    };
  return {
    summary: "计算过程中程序出了异常",
    details: {
      code: "program-error",
      reason:
        "排班程序没有正常完成。仅凭这条报错，还不能确定是配置、页面运行环境还是程序本身的问题。",
      facts: [],
      steps: [
        preserved,
        "请重试一次；若仍失败，先导出诊断记录。刷新页面前可先导出配置，方便保留当前工作。",
        report,
      ],
      diagnosticMessages,
    },
  };
}

function safetyExplanation(message: string): string {
  if (message.includes("缺少安全凭证"))
    return "这份新班表没有附上完成最后检查的记录，系统不能直接采用。";
  if (message.includes("安全凭证无效"))
    return "这份新班表与它附带的检查记录对不上，不能确认现在的结果已经检查过。";
  if (message.includes("已锁定岗位"))
    return "本来必须保留的岗位，在后续安排中被改动或丢失了。";
  const result =
    /^最终安全复核未通过：(.+?)(必须且只能保留一个排班结果|没有形成有效自动排班结果|的人员不存在|违反严格跨工作日恢复目标)$/.exec(
      message
    );
  if (result) {
    const reasons: Record<string, string> = {
      必须且只能保留一个排班结果:
        "在新班表中缺失或出现了重复记录，一个岗位应该只有一条安排",
      没有形成有效自动排班结果: "没有形成可用的人员安排",
      的人员不存在: "安排了一名在当前人员名单中找不到的人",
      违反严格跨工作日恢复目标:
        "安排了设置要求在上一班晚班后必须避开这里的人员",
    };
    return `${result[1]}${reasons[result[2]!]}。`;
  }
  if (message.includes("半休"))
    return guardExplanation({ ruleId: "half-rest", message });
  const eligibility =
    /^最终安全复核未通过：(.+) (不具备该岗位资质|不可上夜班|在该时段已有排班|将超过每日 ([\d.]+) 小时上限|不满足该岗位的最小衔接间隔)$/.exec(
      message
    );
  if (eligibility) {
    const reason = eligibility[2]!.startsWith("将超过每日")
      ? `做这个岗位后，每天工作时间会超过${eligibility[3]}小时的上限`
      : (
          {
            不具备该岗位资质: "这个人没有被配置为可以做这个岗位",
            不可上夜班: "这个人不能做夜班",
            在该时段已有排班: "这个人在同一时间已经有其他工作",
            不满足该岗位的最小衔接间隔: "这个人前后岗位之间留出的时间不足",
          } as Record<string, string>
        )[eligibility[2]!];
    return `检查发现：${eligibility[1]}，${reason}。`;
  }
  if (
    message.startsWith("最终安全复核未通过：") &&
    /岗位资质|时间冲突|每日工时上限|衔接|当前状态|夜班/.test(message)
  )
    return `检查发现：${message.slice("最终安全复核未通过：".length)}`;
  return "最后检查发现班表中仍有不符合要求的安排，或缺少完成检查的记录。当前信息不足以确定具体人员或岗位；原始报错已保留在诊断文件中。";
}

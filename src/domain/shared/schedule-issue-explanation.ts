import type { ScheduleGuardViolation } from "../kernel/schedule-guard";

/** Explains evidence already produced by the checks; never evaluates a rule. */
export function guardExplanation(violation: ScheduleGuardViolation): string {
  const message = violation.message;
  switch (violation.ruleId) {
    case "daily-primary-position-unique": {
      const match =
        /^(.+)在(.+)和(.+)重复承担非督导一号岗位，自动排班拒绝提交$/.exec(
          message
        );
      return match
        ? `${match[1]}被安排到${match[2]}和${match[3]}，两处都是排在最前面的一号岗位。同一张班表中，一个人只能做一次一号岗位，督导除外。`
        : "同一个人被安排了两次一号岗位。一号岗位就是航班最前面的岗位，督导除外。";
    }
    case "same-flight-staff-exclusion": {
      const match = /^(.+)不能同时安排在(.+?)(?:，.*)?$/.exec(message);
      return match
        ? `${match[1]}被排到了${match[2]}，但设置规定他们不能一起做这个航班。`
        : "设置中不能一起做同一航班的两个人，被安排到了同一航班。";
    }
    case "half-rest":
      return message.includes("上午半休")
        ? "有人选择了上午休息，却被安排到12点前开始的岗位。"
        : "有人选择了下午休息，却被安排到12点后开始的岗位。";
    case "minimum-flight-transition": {
      const match =
        /^(.+)与(上一航班|下一航班)间隔只有 ([\d.]+) 分钟，少于要求的 ([\d.]+) 分钟。$/.exec(
          message
        );
      return match
        ? `${match[1]}做完一个航班后，到另一个航班之间只留了${match[3]}分钟，设置要求至少留${match[4]}分钟。`
        : "有人做完一个航班后，到下一个航班开始的间隔太短，没有达到设置要求。";
    }
    case "strict-next-workday-recovery": {
      const match =
        /^(.+)上一工作班晚班后不得安排(.+)，违反严格跨工作日恢复目标$/.exec(
          message
        );
      return match
        ? `${match[1]}上一班做了需要休息保护的晚班岗位，这一班却又被安排到${match[2]}。设置规定这些岗位必须避开。`
        : "上一班做了需要休息保护的晚班岗位的人，这一班又被安排到了设置规定必须避开的岗位。";
    }
    case "position-transition": {
      const match = /^(.+)安排(.+)违反严格岗位衔接规则.+$/.exec(message);
      return match
        ? `${match[1]}被安排到${match[2]}，但前后岗位的搭配或间隔不符合规则页的“岗位衔接”设置。`
        : "同一个人的前后岗位搭配或间隔不符合规则页的“岗位衔接”设置。";
    }
    case "mobile-supervisor": {
      const target = /^([^，]+?)的督导补位关联缺少来源/.exec(message)?.[1];
      if (target)
        return `${target}写成了由督导补位，但班表里找不到对应的督导岗位，不能确认是谁来补。`;
      if (message.includes("必须保持同一人员"))
        return "督导和他兼做的柜台写成了两个人，不能把这份安排当成督导补位。";
      if (message.includes("工时与疲劳必须去重"))
        return "督导补位的柜台被重复计入工时或疲劳，计算结果不正确。";
      if (message.includes("不允许机动督导兼任"))
        return "督导被安排兼做柜台，但这个柜台或本次安排不符合设置中的兼任条件。";
      return "督导与补位柜台没有正确对应起来，最后检查无法确认这份兼任安排符合设置。";
    }
    case "duty-position":
      return "原本必须保留的值班岗位，在最后的班表中缺失或被改动了。";
    case "ke166-supervisor":
      return "KE166仍有普通人员可以做柜台，不能让督导同时兼做这个柜台。";
    case "staff-unavailable":
      return "安排的人员今天不在岗，或人员资料中已找不到这个人。";
    case "position-qualification":
      return "安排的人员不在这个岗位的合格人员名单中。";
    case "staff-type":
    case "admin-support-disabled":
      return "安排的人员类型或当前支援设置不允许做这个岗位。";
    case "night-shift":
      return "安排的人员不能承担这段时间的夜班工作。";
    case "time-conflict":
      return "这个人在同一时间还被安排了其他工作，不能同时做这两个岗位。";
    case "daily-hours":
      return "这个人当天的总工作时间超过了配置中的上限。";
    case "guide-source":
      return "引导岗位原来借用的常规人员已不在这个航班，需要另找人员。";
    case "invalid-assignment":
      return "这个岗位没有形成可以确认的人员安排。";
    default:
      return "新班表中有安排没有通过最后检查。当前记录还不能用来确定具体原因，请导出诊断记录检查。";
  }
}

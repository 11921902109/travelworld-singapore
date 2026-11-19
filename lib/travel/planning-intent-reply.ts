import type { SingaporeIntentResult } from "@/lib/travel/singapore-intent";
import { evaluatePlaceDiscoveryReadiness } from "@/lib/travel/planning-state";
import { foreignBudgetNotice } from "./cny-price";

const fieldLabels: Record<string, string> = {
  startDate: "出发日期", endDate: "结束日期", durationDays: "旅行天数",
  "travelers.total": "同行人数", "travelers.adults": "成人数",
  "travelers.children": "儿童数", "travelers.seniors": "长者人数",
  "accommodation.areaName": "住宿区域", "accommodation.hotelName": "意向酒店",
  dailyStartTime: "每日出发时间", dailyEndTime: "最晚返回时间",
  preferredReturnTime: "首选返回时间", latestReturnTime: "最晚返回时间",
  pace: "旅行节奏", interests: "兴趣", mustVisit: "必去地点", avoid: "避开内容",
  originCity: "出发城市", budget: "预算", budgetDetails: "预算",
};

function changedFields(result: SingaporeIntentResult): string[] {
  return [...new Set(result.acceptedChanges.map((change) =>
    fieldLabels[change.field] || fieldLabels[change.field.split(".")[0]] || change.field,
  ))].slice(0, 6);
}

/** The planning flow starts with places; the legacy intent reply still assumes hotel-first. */
export function presentPlanningIntentResult(result: SingaporeIntentResult): SingaporeIntentResult {
  const readiness = evaluatePlaceDiscoveryReadiness(result);
  const changed = changedFields(result);
  const prefix = changed.length ? `已更新${changed.join("、")}。` : "已记录本轮描述。";
  const reply = readiness.ready
    ? `${prefix}目前已具备进入详细规划的条件。下一步先挑选真实地点并分配到每天，再确认航班、住宿和路线；具体酒店可以稍后选择。`
    : `${prefix}接下来请确认：${readiness.issues.slice(0, 3).join("；")}${readiness.issues.length > 3 ? `；另有 ${readiness.issues.length - 3} 项见右侧` : ""}。`;
  const currencyNotice = foreignBudgetNotice(result.intent.budgetDetails);
  return { ...result, reply: `${reply}${currencyNotice ? ` ${currencyNotice}可先挑地点，稍后在住宿阶段填写。` : ""}`.slice(0, 1_000) };
}

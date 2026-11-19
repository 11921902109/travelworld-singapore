export const planningHelpStages = ["places", "day_allocation", "flights", "stays", "route"] as const;
export type PlanningHelpStage = typeof planningHelpStages[number];

export const planningHelpStageLabels: Record<PlanningHelpStage, string> = {
  places: "挑地点", day_allocation: "分天", flights: "航班", stays: "住宿", route: "时间核算",
};

export type PlanningHelpContext = {
  handoffId: string;
  stage: PlanningHelpStage;
  day?: number;
  locked?: boolean;
  hasFailure?: boolean;
};

export function planningHelpQuestions(context: PlanningHelpContext): [string, string, string] {
  const stage = context.stage;
  if (stage === "places") return ["这些地点是按什么偏好推荐的？", "我已经选了哪些地点？", "选好地点后要做什么？"];
  if (stage === "day_allocation") return ["还有哪些地点没安排到某一天？", "哪一天安排的地点最多？", "有一天想留空，应该怎么做？"];
  if (stage === "flights") return ["我现在确认了哪些航班信息？", "抵达时间会怎样影响首日安排？", "我已经买了机票，在哪里填写？"];
  if (stage === "stays") return ["每一段住宿分别是哪几晚？", "哪些住宿段还没有选定酒店？", "已选酒店怎么影响每天的路线？"];
  const day = context.day ? `Day ${context.day}` : "这一天";
  return [
    "当前这一天还能安排多少时间？",
    context.locked ? "这一天可以修改哪些时间？" : `在哪里修改 ${day} 的出发时间？`,
    context.hasFailure ? `为什么 ${day} 没保存成功？` : "保存本日会修改其他天吗？",
  ];
}

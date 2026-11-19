export type HotelNightBudget = { amount: number; currency: string } | null | undefined;
type HotelReferenceCommerce = {
  kind?: string;
  status: string;
  price?: { amount: number; currency: string; unit?: string };
} | null | undefined;

export type HotelBudgetAssessment = {
  status: "no_budget" | "within_budget" | "over_budget" | "price_unknown" | "currency_uncomparable";
  message: string;
  difference?: number;
};

function nightlyUnit(unit: string | undefined): boolean {
  if (!unit || /每人|人均|per\s*person|total|总价|全程/i.test(unit)) return false;
  return /每(?:房每)?晚|\/\s*晚|per\s*night|\/\s*night/i.test(unit);
}

export function formatBudgetAmount(amount: number, currency: string): string {
  return `${currency === "SGD" ? "S$" : currency === "CNY" ? "¥" : `${currency} `}${Number(amount.toFixed(2))}`;
}

/** Compare only known, same-currency nightly reference prices. Never invent an exchange rate. */
export function assessHotelBudget(budget: HotelNightBudget, commerce: HotelReferenceCommerce): HotelBudgetAssessment {
  if (!budget || !Number.isFinite(budget.amount) || budget.amount <= 0) return { status: "no_budget", message: "未设置每晚预算上限" };
  if (budget.currency !== "CNY") return { status: "currency_uncomparable", message: `原预算 ${budget.amount} ${budget.currency} 已保留，请重新填写人民币预算，或明确不设置预算；不自动换汇。` };
  const price = commerce?.price;
  if (!commerce || commerce.status !== "available" || commerce.kind && commerce.kind !== "hotel" ||
      !price || !Number.isFinite(price.amount) || price.amount <= 0 || !nightlyUnit(price.unit)) {
    return { status: "price_unknown", message: "暂无法核对预算：缺少可比较的每晚参考报价" };
  }
  if (price.currency !== budget.currency) return {
    status: "currency_uncomparable", message: "暂无可核实的人民币每晚参考价，暂无法核对预算；价格以预订页为准。",
  };
  const difference = Math.round((price.amount - budget.amount) * 100) / 100;
  if (difference <= 0) return { status: "within_budget", message: "参考每晚起价在预算上限内" };
  return { status: "over_budget", difference,
    message: `参考每晚起价超出上限 ${formatBudgetAmount(difference, budget.currency)}` };
}

/** An acknowledgement is valid only for this budget, quote and stay date range. */
export function hotelBudgetAcknowledgementKey(input: {
  budgetPerNight?: HotelNightBudget;
  checkInDate: string;
  checkOutDate: string;
}, candidate: { placeId: string; commerce?: HotelReferenceCommerce }): string {
  return JSON.stringify([candidate.placeId, input.checkInDate, input.checkOutDate, input.budgetPerNight || null,
    candidate.commerce?.price || null]);
}

export function hotelBudgetGroups<T extends { commerce?: HotelReferenceCommerce }>(budget: HotelNightBudget, candidates: T[]) {
  const assessed = candidates.map((hotel) => ({ hotel, assessment: assessHotelBudget(budget, hotel.commerce) }));
  return {
    primary: assessed.filter(({ assessment }) => assessment.status === "no_budget" || assessment.status === "within_budget"),
    alternatives: assessed.filter(({ assessment }) => assessment.status !== "no_budget" && assessment.status !== "within_budget"),
    overBudgetCount: assessed.filter(({ assessment }) => assessment.status === "over_budget").length,
    unknownCount: assessed.filter(({ assessment }) => assessment.status === "price_unknown" || assessment.status === "currency_uncomparable").length,
  };
}

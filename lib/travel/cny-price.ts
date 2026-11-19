export type ReferencePrice = { amount?: number; currency?: string | null; display?: string; unit?: string } | null | undefined;

export const CNY_PRICE_UNVERIFIED = "暂无可核实的人民币参考价，价格以预订页为准";

/** Render only a verified CNY amount. Supplier display strings are not currency evidence. */
export function cnyPriceLabel(price: ReferencePrice): string | null {
  if (price?.currency !== "CNY" || typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount <= 0) return null;
  return `¥${Number(price.amount.toFixed(2))}`;
}

export function cnyReferenceLabel(price: ReferencePrice): string {
  const amount = cnyPriceLabel(price);
  return amount ? `${amount}${price?.unit ? ` · ${price.unit}` : ""}` : CNY_PRICE_UNVERIFIED;
}

export function foreignBudgetNotice(budget: { amount?: number | null; currency?: string | null } | null | undefined): string | null {
  if (!budget?.amount || !budget.currency || budget.currency === "CNY") return null;
  return `原预算 ${budget.amount} ${budget.currency} 已保留，当前仅以人民币核对预算，不自动换汇。请重新填写人民币预算，或明确不设置预算。`;
}

import { CircleAlert } from "lucide-react";
import type { TripStop } from "@/lib/travel/types";

export function tripStopPeriodLabel(time: string, kind: TripStop["kind"], isFirst: boolean, isLast: boolean) {
  if (kind === "hotel" && isFirst) return "出发";
  if (kind === "hotel" && isLast) return "返店";
  if (!/^\d{2}:[0-5]\d$/.test(time)) return "时段待定";
  const hour = Number(time.slice(0, 2));
  const localHour = hour % 24;
  const period = localHour < 12 ? "上午" : localHour < 18 ? "下午" : "傍晚／夜间";
  return hour >= 24 ? `次日 ${period}` : period;
}

export function TripPlaceAdvice({ advice }: { advice?: TripStop["aiAdvice"] }) {
  if (!advice?.pros || !advice.cons) return null;
  return (
    <span className="tw-trip-advice">
      <b className="tw-trip-advice-heading">AI 建议</b>
      <span><b>优点</b> {advice.pros}</span>
      <span><b>留意</b> {advice.cons}</span>
    </span>
  );
}

type TripPlaceCardContentProps = {
  name: string;
  categoryLabel?: string;
  period?: string;
  area?: string;
  duration?: string;
  openingLabel?: string;
  description?: string;
  descriptionTitle?: string;
  warning?: string;
  aiAdvice?: TripStop["aiAdvice"];
};

export function TripPlaceCardContent({
  name, categoryLabel, period, area, duration, openingLabel, description, descriptionTitle, warning, aiAdvice,
}: TripPlaceCardContentProps) {
  const durationLabel = duration && duration !== period && (/小时|分钟/.test(duration) ? `停留 ${duration}` : duration);
  const subtitle = [area, durationLabel].filter(Boolean).join(" · ");
  return (
    <span className="tw-item-copy">
      <span className="tw-item-name"><strong>{name}</strong>{categoryLabel && <i>{categoryLabel}</i>}</span>
      {(period || subtitle) && <span className="tw-place-card-meta">{period && <b>{period}</b>}{subtitle && <small>{subtitle}</small>}</span>}
      {openingLabel && <small>{openingLabel}</small>}
      {description && <em title={descriptionTitle}>{description}</em>}
      {warning && <mark><CircleAlert size={13} />{warning}</mark>}
      <TripPlaceAdvice advice={aiAdvice} />
    </span>
  );
}

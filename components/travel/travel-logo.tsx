/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages */

export function TravelLogo({ compact = false }: { compact?: boolean }) {
  return (
    <a className="tw-logo" href="/travel" aria-label="travelworld 首页">
      <span className="tw-logo-mark" aria-hidden="true">
        <span className="tw-logo-dot tw-logo-dot--start" />
        <span className="tw-logo-route" />
        <span className="tw-logo-dot tw-logo-dot--end" />
      </span>
      {!compact && <span>travelworld</span>}
    </a>
  );
}

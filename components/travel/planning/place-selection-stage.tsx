"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, MapPin, Search, ShieldCheck } from "lucide-react";
import type { PlanningPlace } from "./place-day-stage";
import type { SceneDiscoveryJob } from "@/lib/travel/planning-scene-jobs";
import shared from "./planning-journey.module.css";
import styles from "./place-selection-stage.module.css";

type Props = {
  candidates: PlanningPlace[];
  selectedPlaceIds: string[];
  selectionReason?: string;
  busy: boolean;
  searchBusy?: boolean;
  error?: string;
  searchMatches?: PlanningPlace[];
  onSearch: (query: string) => void;
  onAddMatch: (placeId: string) => void;
  onToggle: (placeId: string) => void;
  onConfirm: () => void;
  onGenerate?: () => void;
  discoveryJob?: SceneDiscoveryJob;
  onResumeDiscovery?: () => void;
  unconfirmed?: boolean;
  hasUnavailableSelection?: boolean;
  onDiscardUnavailable?: () => void;
};

export function PlaceSelectionStage({ candidates, selectedPlaceIds, selectionReason, busy, searchBusy = false,
  error, searchMatches = [], onSearch, onAddMatch, onToggle, onConfirm, onGenerate, discoveryJob, onResumeDiscovery, unconfirmed = false, hasUnavailableSelection = false, onDiscardUnavailable }: Props) {
  const [query, setQuery] = useState("");
  const selected = new Set(selectedPlaceIds);
  const areas = [...new Set(candidates.map((item) => item.area).filter(Boolean))].slice(0, 3).join("、");
  const discovering = discoveryJob?.status === "queued" || discoveryJob?.status === "running";
  const reason = selectionReason || (candidates.length
    ? `这些已核实地点分布在${areas || "新加坡不同区域"}。先挑出想去的地方，下一步再把所选地点分配到每天。`
    : discovering ? "正在根据你的旅行条件整理地点。你也可以搜索具体名称，加入想去的地点。" : "可按旅行偏好查找地点，或搜索具体名称加入清单。");

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2 || busy || searchBusy) return;
    onSearch(query.trim());
  }

  return <section className={shared.stage} aria-label="挑选想去的真实地点">
    <div className={shared.stageHeading}>
      <div><small>01 · CHOOSE PLACES</small><h2>先选想去的地方</h2><p>选好地点后，再一起决定每天怎么安排。</p></div>
      <span className={shared.sourceBadge}><ShieldCheck size={15} />Google 核实地点</span>
    </div>
    <p className={styles.reason}>{reason}</p>
    {discoveryJob && discoveryJob.status !== "superseded" && <div className={styles.discoveryStatus} role="status" aria-live="polite">
      <span>{discoveryJob.message}{discoveryJob.verifiedCount > 0 && ` 已核实 ${discoveryJob.verifiedCount} 处。`}</span>
      {!discovering && discoveryJob.canResume && onResumeDiscovery && <button type="button" disabled={busy || searchBusy} onClick={onResumeDiscovery}>继续读取本次结果</button>}
    </div>}
    <form className={shared.searchRow} onSubmit={submitSearch}>
      <label className={shared.srOnly} htmlFor="planning-selection-search">搜索想去的地点</label>
      <Search size={17} /><input id="planning-selection-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索景点、餐厅或想去的地点" />
      <button type="submit" disabled={busy || searchBusy || query.trim().length < 2}>搜索地点</button>
    </form>
    {searchBusy && <p className={shared.status} role="status">正在查找匹配地点…</p>}
    {searchMatches.length > 0 && <div className={shared.searchMatches} aria-label="地点搜索结果">
      {searchMatches.map((place) => <article key={place.googlePlaceId || place.candidateId}>
        <div><strong>{place.name}</strong><small>{place.category} · {place.area || place.address || "新加坡"}</small></div>
        <button type="button" disabled={busy || searchBusy} onClick={() => onAddMatch(place.googlePlaceId || place.candidateId)}>加入我的清单</button>
      </article>)}
    </div>}
    <div className={styles.toolbar}><span>已选 {selected.size} 处{unconfirmed ? " · 尚未确认" : ""}</span>{onGenerate && <button type="button" disabled={busy || searchBusy || discovering} onClick={onGenerate}>{discovering ? "正在整理本次地点…" : candidates.length >= 40 ? "更新未选推荐" : candidates.length ? "查找更多地点" : discoveryJob ? "重新整理一批" : "查找真实地点"}</button>}</div>
    {!candidates.length && <p className={shared.empty}>{discovering ? "地点整理中；只会显示经 Google 核实的结果。" : "候选清单为空。可搜索具体名称，或按旅行偏好查找推荐地点。"}</p>}
    <div className={styles.grid}>
      {candidates.map((place) => {
        const id = place.googlePlaceId || place.candidateId;
        const checked = selected.has(id);
        return <article className={`${styles.card} ${checked ? styles.selected : ""}`} key={id}>
          <div className={styles.cardTop}><span className={shared.category}>{place.category}</span></div>
          <label className={styles.choice}><input type="checkbox" checked={checked} disabled={busy} onChange={() => onToggle(id)} /><span><strong>{place.name}</strong><small><MapPin size={12} />{place.area || "新加坡"}</small></span></label>
          {place.reason && <p className={styles.placeReason}>{place.reason}</p>}
          {place.fallbackReason && <p className={styles.fallback}>热门补充 · {place.fallbackReason}</p>}
          <details className={styles.details}><summary>查看详情</summary><small>AI 体验建议</small><p><b>优点</b><span>{place.pros?.filter(Boolean).join("；") || "可结合你的兴趣进一步了解。"}</span></p><p><b>留意</b><span>{place.cons?.filter(Boolean).join("；") || "开放信息与当日状况请在出发前复核。"}</span></p></details>
        </article>;
      })}
    </div>
    {error && <p className={shared.error} role="alert">{error}</p>}
    {hasUnavailableSelection && <button type="button" className={shared.secondaryAction} disabled={busy} onClick={onDiscardUnavailable}>移除失效选择</button>}
    <button type="button" className={shared.primaryAction} disabled={busy || searchBusy || hasUnavailableSelection || !selected.size} onClick={onConfirm}>{busy ? "正在处理…" : `确认 ${selected.size} 个地点，开始分天`}<ArrowRight size={16} /></button>
    <p className={styles.note}>地点身份来自 Google Places；推荐理由、优点和留意为 AI 建议。餐厅不查询飞猪餐饮商品。</p>
  </section>;
}

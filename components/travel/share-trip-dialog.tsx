"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SharedTripViewer } from "@/components/travel/shared-trip-viewer";
import { prepareSharedTripInput, type SharedTripSnapshot } from "@/lib/travel/shared-trip";
import type { DemoTrip } from "@/lib/travel/types";

type ShareResult = { snapshot: SharedTripSnapshot; url?: string; expiresAt?: string };

export function ShareTripDialog({ trip, onClose }: { trip: DemoTrip; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [includeAccommodation, setIncludeAccommodation] = useState(false);
  const [result, setResult] = useState<ShareResult>();
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const payload = useMemo(() => {
    try {
      return prepareSharedTripInput(trip);
    } catch {
      return null;
    }
  }, [trip]);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function requestSnapshot(preview: boolean, signal?: AbortSignal): Promise<ShareResult> {
    const response = await fetch(preview ? "/api/travel/share?preview=1" : "/api/travel/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trip: payload, includeAccommodation }),
      signal,
    });
    const data = await response.json().catch(() => null) as (ShareResult & { error?: { message?: string } }) | null;
    if (!response.ok || !data?.snapshot || (!preview && !data.url)) {
      throw new Error(data?.error?.message || "当前无法准备分享行程，请稍后重试。");
    }
    if (!preview && data.url) {
      const path = new URL(data.url, window.location.origin).pathname;
      if (!/^\/travel\/shared\/[a-f0-9]{32}$/.test(path)) throw new Error("分享链接格式无效。");
      data.url = new URL(path, window.location.origin).toString();
    }
    return data;
  }

  useEffect(() => {
    if (!payload) return;
    const controller = new AbortController();
    void requestSnapshot(true, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResult(data);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "暂时无法预览。");
    });
    return () => controller.abort();
    // Preview requests are keyed by the captured trip and selected scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, includeAccommodation, previewRetry]);

  async function generate() {
    if (!result || !payload || saving || result.url) return;
    setSaving(true);
    setError("");
    try {
      setResult(await requestSnapshot(false));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "暂时无法生成分享链接。");
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopyStatus("链接已复制。");
    } catch {
      setCopyStatus("请选中上方链接手动复制。");
    }
  }

  return (
    <dialog ref={dialog} className="tw-share-dialog" aria-labelledby="share-trip-heading" onCancel={(event) => {
      event.preventDefault();
      if (!saving) onClose();
    }}>
      <div className="tw-share-dialog-shell">
        <header className="tw-share-dialog-header">
          <h2 id="share-trip-heading">分享行程</h2>
          <button type="button" className="tw-share-secondary" onClick={onClose} disabled={saving}>关闭</button>
        </header>
        <p className="tw-share-dialog-description">预览接收者看到的行程。链接有效期为 30 天，持有链接的人可查看这份只读快照。</p>
        <label className="tw-share-option"><input type="checkbox" checked={includeAccommodation} disabled={saving || Boolean(result?.url)}
          onChange={(event) => {
            setResult(undefined);
            setError("");
            setIncludeAccommodation(event.target.checked);
          }} />包含住宿信息和相关路线</label>
        {result?.url && <div className="tw-share-link-result">
          <label>只读分享链接<input readOnly value={result.url} onFocus={(event) => event.currentTarget.select()} /></label>
          <div className="tw-share-dialog-actions">
            <button type="button" className="tw-share-primary" onClick={() => void copyLink()}>复制链接</button>
            <a href={result.url} target="_blank" rel="noreferrer">打开访客页</a>
          </div>
          {copyStatus && <p className="tw-share-dialog-status" role="status">{copyStatus}</p>}
        </div>}
        {result ? <SharedTripViewer snapshot={result.snapshot} previewTrip={trip} /> : !error && payload && <p role="status">正在准备分享预览…</p>}
        {(!payload || error) && <p role="alert">{error || "当前行程数据有缺失，暂时无法准备分享。"}</p>}
        {!result && error && payload && <button type="button" className="tw-share-secondary" onClick={() => {
          setError("");
          setPreviewRetry((value) => value + 1);
        }}>重试预览</button>}
        {!result?.url && <div className="tw-share-dialog-actions">
          <button type="button" className="tw-share-primary" disabled={!result || saving} onClick={() => void generate()}>
            {saving ? "正在生成链接…" : "生成只读链接"}
          </button>
        </div>}
      </div>
    </dialog>
  );
}

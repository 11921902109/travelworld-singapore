"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import { planningHelpQuestions, planningHelpStageLabels, type PlanningHelpContext } from "@/lib/travel/planning-help-questions";

type HelpTurn = { question: string; answer?: string; error?: string; scope: string };

export function PlanningHelpReplies({ turns, busy, scope, onRetry }: {
  turns: HelpTurn[]; busy: boolean; scope: string; onRetry: (question: string) => void;
}) {
  const latest = turns.at(-1);
  const older = turns.slice(0, -1);

  function renderTurn(turn: HelpTurn, index: number) {
    return <div key={index} className="tw-planning-help-turn">
      <small>{turn.scope}</small><strong>{turn.question}</strong>
      {turn.answer ? <p>{turn.answer}</p> : turn.error ? <>
        <p className="tw-planning-help-error">{turn.error}</p>
        {scope === turn.scope && <button type="button" disabled={busy} onClick={() => onRetry(turn.question)}>重试</button>}
      </> : <p>正在查看当前规划…</p>}
    </div>;
  }

  return <>
    <div aria-live="polite" aria-atomic="true">{latest && renderTurn(latest, turns.length - 1)}</div>
    {older.length > 0 && <details className="tw-planning-help-history">
      <summary>查看帮助历史（{older.length}）</summary>
      <div className="tw-planning-help-turns">{older.map(renderTurn)}</div>
    </details>}
  </>;
}

export function PlanningHelpPanel({ context, open }: { context: PlanningHelpContext; open: boolean }) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<HelpTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const scope = planningHelpStageLabels[context.stage] + (context.day ? ` · Day ${context.day}` : "");
  useEffect(() => () => active.current?.abort(), []);

  async function ask(raw: string) {
    const question = raw.trim();
    if (question.length < 2 || question.length > 500 || active.current) return;
    const task = new AbortController();
    active.current = task;
    const timeout = setTimeout(() => task.abort(), 90_000);
    const pending = { question, scope };
    setTurns((previous) => [...previous.slice(-29), pending]);
    setBusy(true);
    setInput("");
    try {
      const history = turns.flatMap((turn) => turn.answer ? [{ question: turn.question, answer: turn.answer }] : []).slice(-4);
      const response = await fetch("/api/travel/singapore/planning/help", {
        method: "POST", signal: task.signal,
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ handoffId: context.handoffId, stage: context.stage, day: context.day, question, history }),
      });
      const payload = await response.json().catch(() => null) as { answer?: string; error?: { message?: string } } | null;
      if (!response.ok || !payload?.answer) throw new Error(payload?.error?.message || "暂时无法回答，请稍后重试。");
      setTurns((previous) => previous.map((turn) => turn === pending ? { ...turn, answer: payload.answer } : turn));
    } catch (error) {
      const message = task.signal.aborted ? "这次答疑等待超时，可以重试。右侧规划不受影响。" : error instanceof Error ? error.message : "暂时无法回答，可以重试。";
      setTurns((previous) => previous.map((turn) => turn === pending ? { ...turn, error: message } : turn));
    } finally {
      clearTimeout(timeout);
      if (active.current === task) { active.current = null; setBusy(false); }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(input);
  }

  return <section id="planning-help-panel" className="tw-planning-help" hidden={!open} aria-label="只读规划答疑">
    <p className="tw-planning-help-note">仅解释当前规划，不会修改行程。<strong>{scope}</strong></p>
    <div className="tw-planning-help-questions" aria-label="推荐问题">
      {planningHelpQuestions(context).map((question) => <button type="button" key={question} disabled={busy} onClick={() => void ask(question)}>{question}</button>)}
    </div>
    <PlanningHelpReplies turns={turns} busy={busy} scope={scope} onRetry={(question) => void ask(question)} />
    <form className="tw-planner-composer" onSubmit={submit}>
      <label htmlFor="planning-help-question" className="tw-sr-only">询问当前规划</label>
      <textarea id="planning-help-question" rows={2} maxLength={500} value={input} onChange={(event) => setInput(event.target.value)} placeholder="也可以输入自己的问题…" />
      <button type="submit" disabled={busy || input.trim().length < 2} aria-label="发送帮助问题"><Send size={17} /></button>
    </form>
  </section>;
}

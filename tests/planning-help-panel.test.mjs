import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const vite = await createServer({
  configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false },
  resolve: { alias: { '@': process.cwd() } }, optimizeDeps: { noDiscovery: true }, logLevel: 'error',
});
after(() => vite.close());
const { planningHelpStages, planningHelpQuestions } = await vite.ssrLoadModule('/lib/travel/planning-help-questions.ts');
const { PlanningHelpPanel, PlanningHelpReplies } = await vite.ssrLoadModule('/components/travel/planning/planning-help-panel.tsx');
const sample = { handoffId: 'sample', stage: 'route', day: 2 };

test('every supported planning stage renders exactly three click-to-ask suggestions', () => {
  for (const stage of planningHelpStages) {
    const context = { ...sample, stage };
    const questions = planningHelpQuestions(context);
    assert.equal(new Set(questions).size, 3, stage);
    const markup = renderToStaticMarkup(createElement(PlanningHelpPanel, { context, open: true }));
    const group = markup.match(/aria-label="推荐问题">([\s\S]*?)<\/div>/)[1];
    assert.equal((group.match(/<button/g) || []).length, 3, stage);
    for (const question of questions) assert.ok(group.includes(question));
    assert.match(markup, /仅解释当前规划，不会修改行程/);
  }
});

test('active day and known constraints vary only the relevant prompts', () => {
  assert.match(planningHelpQuestions(sample)[1], /Day 2/);
  assert.equal(planningHelpQuestions({ ...sample, locked: true })[1], "这一天可以修改哪些时间？");
  assert.match(planningHelpQuestions({ ...sample, hasFailure: true })[2], /Day 2 没保存/);
  const closed = renderToStaticMarkup(createElement(PlanningHelpPanel, { context: sample, open: false }));
  assert.match(closed, /<section id="planning-help-panel"[^>]* hidden=""/);
});

test('only earlier help turns are collapsed, and the latest reply or retry stays visible', () => {
  const older = { scope: '分天', question: '前一个问题', answer: '先前的回答' };
  const latest = { scope: '时间核算 · Day 2', question: '最新问题', answer: '当前回答' };
  const render = (turns, busy = false) => renderToStaticMarkup(
    createElement(PlanningHelpReplies, { turns, busy, scope: latest.scope, onRetry() {} }),
  );
  const markup = render([older, latest]);
  const [visible, history] = markup.split('<details class="tw-planning-help-history">');
  assert.match(visible, /当前回答/);
  assert.doesNotMatch(visible, /先前的回答/);
  assert.match(history, /查看帮助历史（1）/);
  assert.match(history, /先前的回答/);
  assert.doesNotMatch(render([latest]), /<details/);
  assert.match(render([older, { ...latest, answer: undefined }], true).split('<details')[0], /正在查看当前规划/);
  assert.match(render([older, { ...latest, answer: undefined, error: '请重试' }]).split('<details')[0], /请重试.*>重试<\/button>/);
});

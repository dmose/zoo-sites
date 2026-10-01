import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderHtmlReport } from './html-report.mjs';
import { analyzeToolUse } from './tool-analysis.mjs';

const event = (tool, status = 'completed', server = 'firefox') => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server, tool, status, result: { content: [{ type: 'text', text: '<private reply>' }] } } });

test('counts recorded browser tools once and links explicit-error follow-ups to tasks', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'tool-analysis-'));
  try {
    mkdirSync(join(runDir, 'transcripts'));
    writeFileSync(join(runDir, 'transcripts', 'first--one--a1.jsonl'), [
      event('navigate_page'), event('shell_read', 'completed', 'other'), event('take_snapshot', 'failed'), event('evaluate_script'),
    ].map((item) => JSON.stringify(item)).join('\n'));
    writeFileSync(join(runDir, 'transcripts', 'first--two--a1.jsonl'), [
      event('take_snapshot', 'failed'), event('evaluate_script'),
    ].map((item) => JSON.stringify(item)).join('\n'));
    const rows = [
      { task: 'one', condition: 'first', success: false, transcript: 'first--one--a1.jsonl', tools: { navigate_page: { calls: 1, errors: 0 }, take_snapshot: { calls: 1, errors: 1 }, evaluate_script: { calls: 1, errors: 0 } } },
      { task: 'two', condition: 'first', success: true, transcript: 'first--two--a1.jsonl' },
      { task: 'three', condition: 'first', success: true, tools: { click_by_uid: { calls: 4, errors: 1 } } },
      { task: 'one', condition: 'second', success: true, tools: { browser_navigate: { calls: 2, errors: 0 } } },
    ];
    const diagnoses = { run: 'run', items: [
      { task: 'one', kind: 'pair', diagnosis: { tool_behaviours: [{ arm: 'first', tool: 'take_snapshot', behaviour: 'cut-text', effect: 'Needed <private> text.' }] } },
      { task: 'two', kind: 'pair', diagnosis: { tool_behaviours: [{ arm: 'first', tool: 'take_snapshot', behaviour: 'cut-text', effect: 'Read again.', unsupported: true }] } },
    ] };
    const analysis = analyzeToolUse(rows, { runDir, diagnoses });
    assert.deepEqual(analysis.arms[0].tools.map(({ name, calls, errors }) => [name, calls, errors]), [
      ['click_by_uid', 4, 1], ['evaluate_script', 2, 0], ['take_snapshot', 2, 2], ['navigate_page', 1, 0],
    ]);
    assert.equal(analysis.arms[0].recorded, 3);
    assert.equal(analysis.arms[0].traced, 2);
    assert.deepEqual(analysis.arms[0].afterErrors.map(({ from, to, calls, tasks }) => ({ from, to, calls, tasks })), [
      { from: 'take_snapshot', to: 'evaluate_script', calls: 2, tasks: ['one', 'two'] },
    ]);
    assert.equal(analysis.arms[1].traced, 0);
    assert.equal(analysis.observations[0].tasks.length, 2);
    assert.equal(analysis.observations[0].limited, true);
    const html = renderHtmlReport({ results: rows }, 'run', { runDir, diagnoses });
    assert.match(html, /aria-label="Tool analysis"/);
    assert.match(html, /take_snapshot → evaluate_script/);
    assert.match(html, /2 calls · 2 tasks · <a href="#task-one">example<\/a>/);
    assert.match(html, /Needed &lt;private&gt; text\./);
    assert.ok(!html.includes('<private reply>'));
    assert.ok(!html.includes('shell_read →'));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('does not invent tool activity for runs without telemetry', () => {
  const rows = [{ task: 'one', condition: 'first', success: true }];
  assert.deepEqual(analyzeToolUse(rows).arms[0].tools, []);
  assert.ok(!renderHtmlReport({ results: rows }, 'run').includes('aria-label="Tool analysis"'));
});

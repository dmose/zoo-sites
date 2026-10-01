import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { combineRuns } from './combine-runs.mjs';

function writeSource(dir, condition, version) {
  mkdirSync(dir);
  const name = `${condition}--title--a1.jsonl`;
  const meta = {
    date: '2026-09-25T01:00:00Z', backend: 'codex', models: { codex: 'gpt-6-luna' }, effort: 'medium',
    suite: 'all', serving: 'origins', seed: 'same', conditions: condition, tasks: ['title'],
    taskHashes: { title: 'abcdef0123456789' }, env: { [condition]: { firefox: version, build: { version } } },
    surfaces: { [condition]: { version: '0.1' } }, builds: [],
    isolation: { browserTag: { mechanism: { [condition]: 'tag' }, verified: { [condition]: true } } },
  };
  const row = { condition, backend: 'codex', task: 'title', success: true, input_tokens: 100, output_tokens: 10,
    transcript: name, rollout: `rollouts/${name}`, state_file: `states/${name}.gz` };
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ meta, results: [row] }));
  for (const folder of ['transcripts', 'rollouts', 'states', 'tool-calls']) {
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, folder === 'states' ? `${name}.gz` : name), condition);
  }
}

test('combines separate arms with source provenance and their own traces', () => {
  const root = mkdtempSync(join(tmpdir(), 'combine-runs-'));
  try {
    const firefox = join(root, 'firefox-run');
    const playwright = join(root, 'playwright-run');
    const combined = join(root, 'combined');
    writeSource(firefox, 'firefox-devtools-mcp', '156.0.1');
    writeSource(playwright, 'playwright-mcp', '152.0.4');
    combineRuns(firefox, playwright, combined);
    const run = JSON.parse(readFileSync(join(combined, 'results.json'), 'utf8'));
    assert.deepEqual(run.results.map((row) => row.condition), ['firefox-devtools-mcp', 'playwright-mcp']);
    assert.deepEqual(run.meta.combinedFrom.map((source) => source.run), ['firefox-run', 'playwright-run']);
    assert.equal(run.meta.env['firefox-devtools-mcp'].build.version, '156.0.1');
    assert.equal(run.meta.env['playwright-mcp'].build.version, '152.0.4');
    assert.equal(run.totals['playwright-mcp'].output_tokens, 10);
    assert.equal(readFileSync(join(combined, 'rows.jsonl'), 'utf8').trim().split('\n').length, 2);
    for (const folder of ['transcripts', 'rollouts', 'states', 'tool-calls']) {
      for (const condition of ['firefox-devtools-mcp', 'playwright-mcp']) {
        const suffix = folder === 'states' ? '.jsonl.gz' : '.jsonl';
        assert.ok(existsSync(join(combined, folder, `${condition}--title--a1${suffix}`)));
      }
    }
    assert.throws(() => combineRuns(firefox, playwright, combined), /refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a pair with different task definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'combine-runs-'));
  try {
    const firefox = join(root, 'firefox-run');
    const playwright = join(root, 'playwright-run');
    writeSource(firefox, 'firefox-devtools-mcp', '156.0.1');
    writeSource(playwright, 'playwright-mcp', '152.0.4');
    const file = join(playwright, 'results.json');
    const run = JSON.parse(readFileSync(file, 'utf8'));
    run.meta.taskHashes.title = 'fedcba9876543210';
    writeFileSync(file, JSON.stringify(run));
    assert.throws(() => combineRuns(firefox, playwright, join(root, 'combined')), /taskHashes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('takes only Playwright data from an earlier paired run', () => {
  const root = mkdtempSync(join(tmpdir(), 'combine-runs-'));
  try {
    const firefox = join(root, 'firefox-run');
    const previous = join(root, 'previous-pair');
    const combined = join(root, 'combined');
    writeSource(firefox, 'firefox-devtools-mcp', '156.0.1');
    writeSource(previous, 'playwright-mcp', '152.0.4');
    const file = join(previous, 'results.json');
    const run = JSON.parse(readFileSync(file, 'utf8'));
    run.meta.conditions = 'firefox-devtools-mcp,playwright-mcp';
    run.meta.env['firefox-devtools-mcp'] = { firefox: '152.0', build: { version: '152.0.4' } };
    run.meta.surfaces['firefox-devtools-mcp'] = { version: 'old' };
    run.meta.builds = [{ condition: 'firefox-devtools-mcp', version: 'old' }];
    run.results.push({ ...run.results[0], condition: 'firefox-devtools-mcp', output_tokens: 99 });
    writeFileSync(file, JSON.stringify(run));
    writeFileSync(join(previous, 'transcripts', 'firefox-devtools-mcp--title--a1.jsonl'), 'old Firefox');
    combineRuns(firefox, previous, combined);
    const result = JSON.parse(readFileSync(join(combined, 'results.json'), 'utf8'));
    assert.equal(result.results.length, 2);
    assert.equal(result.meta.env['firefox-devtools-mcp'].build.version, '156.0.1');
    assert.equal(result.meta.surfaces['firefox-devtools-mcp'].version, '0.1');
    assert.deepEqual(result.meta.builds, []);
    assert.equal(readFileSync(join(combined, 'transcripts', 'firefox-devtools-mcp--title--a1.jsonl'), 'utf8'), 'firefox-devtools-mcp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

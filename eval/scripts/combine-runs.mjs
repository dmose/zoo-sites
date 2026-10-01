import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totalsByCondition } from '../report.mjs';
import { readRun } from '../run-files.mjs';

const ARTIFACTS = ['transcripts', 'rollouts', 'states', 'tool-calls'];
const MATCH = ['backend', 'models', 'effort', 'suite', 'serving', 'seed', 'tasks', 'taskHashes', 'repeat', 'modes', 'wallTiers', 'maxWall', 'maxOutput', 'extractor', 'sdks', 'envPins'];

function source(dir, condition) {
  if (!existsSync(join(dir, 'results.json'))) throw new Error(`${dir} is not a finished run`);
  const run = readRun(dir);
  if (!String(run.meta.conditions).split(',').includes(condition)) throw new Error(`${dir} has no ${condition}`);
  const results = run.results.filter((row) => row.condition === condition);
  if (!Array.isArray(run.meta.tasks) || results.length !== run.meta.tasks.length ||
      new Set(results.map((row) => row.task)).size !== run.meta.tasks.length ||
      results.some((row) => !run.meta.tasks.includes(row.task))) {
    throw new Error(`${dir} must contain one result for every selected task`);
  }
  return { ...run, results };
}

export function combineRuns(firefoxDir, playwrightDir, outDir) {
  const firefox = source(firefoxDir, 'firefox-devtools-mcp');
  const playwright = source(playwrightDir, 'playwright-mcp');
  for (const key of MATCH) {
    if (JSON.stringify(firefox.meta[key]) !== JSON.stringify(playwright.meta[key])) {
      throw new Error(`source runs disagree on ${key}`);
    }
  }
  const rowsByTask = new Map(playwright.results.map((row) => [row.task, row]));
  if (firefox.meta.tasks.some((task) => !rowsByTask.has(task))) throw new Error('Playwright run is missing selected tasks');
  const results = firefox.meta.tasks.flatMap((task) => [firefox.results.find((row) => row.task === task), rowsByTask.get(task)]);
  const meta = {
    ...firefox.meta,
    conditions: 'firefox-devtools-mcp,playwright-mcp',
    env: { 'firefox-devtools-mcp': firefox.meta.env?.['firefox-devtools-mcp'], 'playwright-mcp': playwright.meta.env?.['playwright-mcp'] },
    surfaces: { 'firefox-devtools-mcp': firefox.meta.surfaces?.['firefox-devtools-mcp'], 'playwright-mcp': playwright.meta.surfaces?.['playwright-mcp'] },
    builds: [...(firefox.meta.builds ?? []).filter((build) => build.condition === 'firefox-devtools-mcp'),
      ...(playwright.meta.builds ?? []).filter((build) => build.condition === 'playwright-mcp')],
    isolation: {
      ...firefox.meta.isolation,
      browserTag: {
        ...firefox.meta.isolation?.browserTag,
        ...Object.fromEntries(['mechanism', 'verified'].map((key) => [key, {
          'firefox-devtools-mcp': firefox.meta.isolation?.browserTag?.[key]?.['firefox-devtools-mcp'],
          'playwright-mcp': playwright.meta.isolation?.browserTag?.[key]?.['playwright-mcp'],
        }])),
      },
      foreignBrowser: {
        ...firefox.meta.isolation?.foreignBrowser,
        rule: {
        ...firefox.meta.isolation?.foreignBrowser?.rule,
          'playwright-mcp': playwright.meta.isolation?.foreignBrowser?.rule?.['playwright-mcp'],
        },
      },
    },
    parallel: undefined,
    interleave: undefined,
    combinedFrom: [
      { condition: 'firefox-devtools-mcp', run: basename(resolve(firefoxDir)), date: firefox.meta.date, git: firefox.meta.git?.commit },
      { condition: 'playwright-mcp', run: basename(resolve(playwrightDir)), date: playwright.meta.date, git: playwright.meta.git?.commit },
    ],
  };
  if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  for (const [dir, condition] of [[firefoxDir, 'firefox-devtools-mcp'], [playwrightDir, 'playwright-mcp']]) {
    for (const folder of ARTIFACTS) {
      const from = join(dir, folder);
      if (!existsSync(from)) continue;
      const to = join(outDir, folder);
      mkdirSync(to, { recursive: true });
      for (const file of readdirSync(from).filter((name) => name.startsWith(`${condition}--`))) {
        copyFileSync(join(from, file), join(to, file));
      }
    }
  }
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(join(outDir, 'rows.jsonl'), results.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ meta, results, totals: totalsByCondition(results) }, null, 2));
  return outDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [firefoxDir, playwrightDir, outDir] = process.argv.slice(2);
  if (!outDir || process.argv.length !== 5) {
    console.error('usage: node eval/scripts/combine-runs.mjs <firefox-run> <playwright-run> <new-run-dir>');
    process.exitCode = 1;
  } else {
    try {
      console.log(`combined results: ${combineRuns(firefoxDir, playwrightDir, outDir)}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

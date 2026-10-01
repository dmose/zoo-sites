import { NO_SUCH_TOOL } from '../mcp-tap.mjs';
import { rowEvents, SURFACE_SERVER, toolCalls } from './events.mjs';

const ranked = (entries) => [...entries].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));

export function analyzeToolUse(rows, { runDir = null, diagnoses = null, conditionOf = (row) => row.condition } = {}) {
  const arms = new Map();
  for (const row of rows) {
    const condition = conditionOf(row);
    if (!arms.has(condition)) arms.set(condition, { condition, attempts: 0, recorded: 0, traced: 0, tools: new Map(), handoffs: new Map(), afterErrors: new Map() });
    const arm = arms.get(condition);
    arm.attempts++;
    const events = rowEvents(runDir, row);
    const calls = events ? toolCalls(events).filter((call) => call.server === SURFACE_SERVER && !(call.isError && NO_SUCH_TOOL.test(call.text))) : [];
    if (events) arm.traced++;
    const stats = row.tools ?? calls.reduce((tools, call) => {
      const tool = (tools[call.tool] ??= { calls: 0, errors: 0 });
      tool.calls++;
      tool.errors += Number(call.isError);
      return tools;
    }, Object.create(null));
    if (Object.keys(stats).length) arm.recorded++;
    for (const [name, data] of Object.entries(stats)) {
      if (!data.calls) continue;
      const tool = arm.tools.get(name) ?? { name, calls: 0, errors: 0, attempts: 0 };
      tool.calls += data.calls ?? 0;
      tool.errors += data.errors ?? 0;
      tool.attempts++;
      arm.tools.set(name, tool);
    }
    for (let index = 0; index < calls.length - 1; index++) {
      const current = calls[index];
      const next = calls[index + 1];
      for (const [selected, map] of [[current.tool !== next.tool, arm.handoffs], [current.isError, arm.afterErrors]]) {
        if (!selected) continue;
        const key = JSON.stringify([current.tool, next.tool]);
        const path = map.get(key) ?? { from: current.tool, to: next.tool, calls: 0, tasks: new Set() };
        path.calls++;
        path.tasks.add(row.task);
        map.set(key, path);
      }
    }
  }
  const output = [...arms.values()].map((arm) => ({
    condition: arm.condition,
    attempts: arm.attempts,
    recorded: arm.recorded,
    traced: arm.traced,
    tools: ranked(arm.tools.values()),
    handoffs: ranked([...arm.handoffs.values()].map((path) => ({ ...path, name: `${path.from} → ${path.to}`, tasks: [...path.tasks] }))),
    afterErrors: ranked([...arm.afterErrors.values()].map((path) => ({ ...path, name: `${path.from} → ${path.to}`, tasks: [...path.tasks] }))),
  }));
  const observations = new Map();
  for (const item of diagnoses?.items ?? []) {
    if (!['pair', 'row'].includes(item.kind)) continue;
    for (const note of item.diagnosis?.tool_behaviours ?? []) {
      const condition = output.find((arm) => arm.condition === note.arm);
      if (!condition || !note.tool || !note.behaviour) continue;
      const key = JSON.stringify([note.arm, note.tool, note.behaviour]);
      const group = observations.get(key) ?? { arm: note.arm, tool: note.tool, behaviour: note.behaviour, tasks: new Set(), example: note.effect, limited: !!note.unsupported };
      group.tasks.add(item.task);
      group.limited ||= !!note.unsupported;
      observations.set(key, group);
    }
  }
  return {
    arms: output,
    observations: [...observations.values()].map((group) => ({ ...group, tasks: [...group.tasks] })).sort((left, right) => right.tasks.length - left.tasks.length || left.tool.localeCompare(right.tool)),
  };
}

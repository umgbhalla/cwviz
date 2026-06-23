#!/usr/bin/env bun
// claude-workflow-viz — browse Claude Code workflows two ways:
//   Workflows: static yuku analysis of .claude/workflows/*.js (the blueprints)
//   Runs:      live + historical executions read from session journals
//
//   bun src/index.ts [baseDir]          TUI (Tab toggles Workflows/Runs)
//   bun src/index.ts --list  [baseDir]  one-line summary per workflow script
//   bun src/index.ts --runs  [n]        one-line summary per run (newest n)
//   bun src/index.ts --json  [baseDir]  full static analysis as JSON
import { discover } from "./discover.ts";
import { discoverRuns } from "./runs.ts";
import { discoverSessions } from "./sessions.ts";

const args = process.argv.slice(2);
const mode = args.find((a) => a === "--list" || a === "--json" || a === "--runs");
const positional = args.find((a) => !a.startsWith("--"));
// Default to the current folder so `cwviz` works in any repo with .claude/workflows.
const base = (positional ?? process.cwd()).replace(/\/$/, "");

if (mode === "--runs") {
  const runs = discoverRuns();
  const n = Number(positional) || 40;
  console.log(`${runs.length} runs · ${runs.filter((r) => r.live).length} live · showing newest ${Math.min(n, runs.length)}\n`);
  for (const r of runs.slice(0, n)) {
    const g = { completed: "✓", running: "●", killed: "⊘", failed: "✗" }[r.status] ?? "?";
    console.log(`${g} ${r.project.padEnd(22)} ${r.name.padEnd(30)} ${String(r.agentCount).padStart(3)}a ${String(Math.round((r.totalTokens ?? 0) / 1000)).padStart(5)}k ${r.phases.length}◷  ${r.status}`);
  }
} else if (mode === "--json") {
  console.log(JSON.stringify(await discover(base), null, 2));
} else if (mode === "--list") {
  const graphs = await discover(base);
  const repos = new Set(graphs.map((g) => g.repo)).size;
  console.log(`${graphs.length} workflows · ${repos} repos · ${graphs.reduce((a, g) => a + g.stats.agents, 0)} agent calls\n`);
  for (const g of graphs) {
    const s = g.stats;
    console.log(`${g.error ? "⚠ " : ""}${g.repo.padEnd(22)} ${g.name.padEnd(34)} ${String(s.agents).padStart(3)}a ${s.parallel}∥ ${s.pipeline}⇶ ${g.declaredPhases.length}◷ ${s.loops ? "↻" : " "}`);
  }
} else {
  const [workflows, runs, sessions] = [await discover(base), discoverRuns(), discoverSessions()];
  if (workflows.length === 0 && runs.length === 0 && sessions.length === 0) {
    console.error(`Nothing found under ${base} or ~/.claude/projects.`);
    process.exit(1);
  }
  const { launchUI } = await import("./ui.ts");
  await launchUI({ workflows, runs, sessions, reloadRuns: () => discoverRuns() });
}

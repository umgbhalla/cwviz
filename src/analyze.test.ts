// ponytail: one runnable check on the non-trivial extraction logic.
// Runs against the real ax2 workflow corpus. `bun test` or `bun src/analyze.test.ts`.
import { analyzeWorkflow } from "./analyze.ts";
import { readFileSync } from "node:fs";

const assert = (c: unknown, m: string) => { if (!c) throw new Error("FAIL: " + m); };

// Synthetic file exercises every primitive + loop detection.
const SRC = `
export const meta = {
  name: 'demo-flow',
  description: 'a ' + 'two-part desc',
  phases: [ { title: 'Probe', detail: 'look' }, { title: 'Verify' } ],
};
phase('Probe');
const r = await parallel([ () => agent('find bugs', { label: 'a', schema: BUGS, agentType: 'Explore' }), () => agent('find perf', { schema: BUGS }) ]);
phase('Verify');
for (let i = 0; i < 3; i++) {
  await agent('refute it', { phase: 'Verify', model: 'opus' });
}
await pipeline(items, x => agent('s1'), y => agent('s2'));
await workflow('child-wf');
log('done');
`;

const g = analyzeWorkflow("/tmp/demo.workflow.js", SRC, "test", "demo.workflow.js");
assert(!g.error, "no error: " + g.error);
assert(g.name === "demo-flow", "name from meta, got " + g.name);
assert(g.description === "a two-part desc", "string-concat desc resolved, got " + g.description);
assert(g.declaredPhases.length === 2, "2 declared phases");
assert(g.stats.agents === 5, "5 agent calls, got " + g.stats.agents);
assert(g.stats.parallel === 1, "1 parallel");
assert(g.stats.pipeline === 1, "1 pipeline");
assert(g.stats.loops >= 1, "loop detected, got " + g.stats.loops);
assert(g.stats.agentTypes["Explore"] === 1, "Explore agentType counted");
assert(g.stats.schemas.includes("BUGS"), "BUGS schema captured");
assert(g.stats.models.includes("opus"), "opus model captured");
const probe = g.phases.find((p) => p.title === "Probe")!;
assert(probe && probe.parallel === 1, "Probe phase has the parallel fan");
const verify = g.phases.find((p) => p.title === "Verify")!;
assert(verify.agents.some((a) => a.looped), "Verify has a looped agent");

// Real corpus: must analyze a known ax2 file cleanly.
const realPath = "/Users/umang/hub/ax2/.claude/workflows/stuck-analysis.js";
const real = analyzeWorkflow(realPath, readFileSync(realPath, "utf8"), "ax2", "stuck-analysis.js");
assert(!real.error, "real file no error: " + real.error);
assert(real.name === "stuck-analysis", "real name, got " + real.name);
assert(real.declaredPhases.length === 3, "real 3 declared phases, got " + real.declaredPhases.length);
assert(real.stats.agents >= 3, "real >=3 agents, got " + real.stats.agents);

console.log("ok — analyze.test passed (synthetic + real ax2 corpus)");

// ponytail: one runnable check on run-journal parsing — writes a synthetic
// journal into a temp project tree and asserts discoverRuns reads it back.
import { discoverRuns } from "./runs.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assert = (c: unknown, m: string) => { if (!c) throw new Error("FAIL: " + m); };

const root = mkdtempSync(join(tmpdir(), "cwviz-runs-"));
const wfDir = join(root, "-Users-x-proj", "sess1234abcd", "workflows");
mkdirSync(wfDir, { recursive: true });
mkdirSync(join(wfDir, "scripts"), { recursive: true });

const journal = {
  runId: "wf_abc", workflowName: "demo-run", status: "completed",
  startTime: Date.now() - 60000, durationMs: 60000, agentCount: 2, totalTokens: 50000, totalToolCalls: 12,
  script: "export const meta = {\n  name: 'demo-run',\n  description: 'a runnable demo',\n};",
  phases: [{ title: "Probe", detail: "look" }, { title: "Verify" }],
  logs: ["found 2 things"],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Probe" },
    { type: "workflow_phase", index: 2, title: "Verify" },
    { type: "workflow_agent", index: 1, label: "finder", phaseIndex: 1, phaseTitle: "Probe", state: "done", tokens: 30000, toolCalls: 8, durationMs: 40000 },
    { type: "workflow_agent", index: 2, label: "checker", phaseIndex: 2, phaseTitle: "Verify", state: "progress", lastToolName: "Read", tokens: 20000, toolCalls: 4 },
  ],
};
writeFileSync(join(wfDir, "wf_abc.json"), JSON.stringify(journal));
// an in-flight orphan: script with no journal, freshly touched
writeFileSync(join(wfDir, "scripts", "live-thing-wf_xyz.js"), "export const meta={name:'live-thing'}");

const runs = discoverRuns(root);
const r = runs.find((x) => x.runId === "wf_abc")!;
assert(r, "journal run discovered");
assert(r.name === "demo-run", "name from journal");
assert(r.description === "a runnable demo", "description scraped from script");
assert(r.agentCount === 2 && r.totalTokens === 50000, "stats parsed");
assert(r.phases.length === 2, "2 phases, got " + r.phases.length);
const probe = r.phases.find((p) => p.title === "Probe")!;
assert(probe.agents[0]?.label === "finder", "agent assigned to its phase");
assert(r.phases.find((p) => p.title === "Verify")!.agents[0].state === "progress", "live agent state preserved");

const orphan = runs.find((x) => x.runId === "wf_xyz");
assert(orphan && orphan.status === "running" && orphan.live, "fresh orphan script surfaced as running/live");

// in-flight run reconstructed from live subagent transcripts (no journal yet)
const liveDir = join(root, "-Users-x-proj", "sess1234abcd", "subagents", "workflows", "wf_live");
mkdirSync(liveDir, { recursive: true });
writeFileSync(join(wfDir, "scripts", "deep-audit-wf_live.js"), "export const meta={name:'deep-audit'}");
writeFileSync(join(liveDir, "agent-a1b2c3d4e5.meta.json"), JSON.stringify({ agentType: "Explore" }));
writeFileSync(join(liveDir, "agent-a1b2c3d4e5.jsonl"), [
  { type: "user", message: { role: "user", content: "audit the auth path" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Grep", input: { pattern: "token" } }] } },
].map((l) => JSON.stringify(l)).join("\n") + "\n");

const runs2 = discoverRuns(root);
const liveRun = runs2.find((x) => x.runId === "wf_live")!;
assert(liveRun && liveRun.status === "running", "in-flight run surfaced");
assert(liveRun.agentCount === 1, "live agent reconstructed, got " + liveRun.agentCount);
const la = liveRun.phases[0]?.agents[0];
assert(la?.agentType === "Explore" && la?.lastToolName === "Grep" && la?.state === "progress", "live agent: type+lastTool+progress from fresh transcript");

console.log("ok — runs.test passed (journal + orphan + live in-flight discovery)");

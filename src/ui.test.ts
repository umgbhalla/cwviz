// ponytail: one headless render check — mounts the real scene on a test
// renderer and asserts the captured cell-grid shows the workflow + detail.
// Catches render crashes tsc can't see. `bun src/ui.test.ts`.
import { createTestRenderer } from "@opentui/core/testing";
import { buildScene } from "./ui.ts";
import { analyzeWorkflow } from "./analyze.ts";
import type { WorkflowGraph } from "./model.ts";
import type { RunGraph } from "./runs-model.ts";

const assert = (c: unknown, m: string) => { if (!c) throw new Error("FAIL: " + m); };

const SRC = `
export const meta = { name: 'demo-flow', description: 'visualise me', phases: [{ title: 'Probe', detail: 'look' }] };
phase('Probe');
await parallel([ () => agent('find bugs', { label: 'finder', agentType: 'Explore', schema: BUGS }) ]);
`;
const graphs: WorkflowGraph[] = [analyzeWorkflow("/tmp/demo.workflow.js", SRC, "demo-repo", "demo.workflow.js")];

// a synthetic run with a live agent to exercise the Runs renderer
const run: RunGraph = {
  runId: "wf_test", name: "demo-flow", status: "running", project: "demo/repo", session: "abcd1234",
  startTime: Date.now() - 5000, mtime: Date.now(), agentCount: 1, totalTokens: 1234, totalToolCalls: 3,
  live: true, logs: ["spawned finder"], phases: [
    { index: 1, title: "Probe", detail: "look", agents: [
      { index: 1, label: "finder", state: "progress", lastToolName: "Grep", lastToolSummary: "search bugs", tokens: 1234, toolCalls: 3 },
    ] },
  ],
};

const { renderer, renderOnce, captureCharFrame, mockInput } = await createTestRenderer({ width: 120, height: 40 });
buildScene(renderer, { workflows: graphs, runs: [run], sessions: [] });
await renderOnce();
let frame = captureCharFrame();

// Workflows mode (default)
assert(frame.includes("claude-workflow-viz"), "header rendered");
assert(frame.includes("[Workflows]"), "workflows tab active");
assert(frame.includes("demo-flow"), "workflow name in list/detail");
assert(frame.includes("PHASES"), "phase section rendered");
assert(frame.includes("Probe"), "phase title rendered");
assert(frame.includes("finder"), "agent label rendered in detail");
assert(frame.includes("Explore"), "agentType rendered");

// Tab → Runs mode
mockInput.pressTab();
await renderOnce();
frame = captureCharFrame();
assert(frame.includes("[Runs]"), "runs tab active after Tab");
assert(frame.includes("LIVE"), "live marker rendered for running run");
assert(frame.includes("Grep"), "live agent's last tool rendered");

renderer.destroy();
console.log("ok — ui.test passed (workflows + runs headless render)");

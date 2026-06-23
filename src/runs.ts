// Discover workflow RUNS from Claude Code session journals.
// Layout:  ~/.claude/projects/<project>/<session-uuid>/workflows/wf_*.json
//          ~/.claude/projects/<project>/<session-uuid>/workflows/scripts/<name>-<runId>.js
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentState, RunAgent, RunGraph, RunPhase, RunStatus } from "./runs-model.ts";

export const PROJECTS_ROOT = `${process.env.HOME}/.claude/projects`;
const LIVE_WINDOW_MS = 30_000; // running, or finished this recently, counts as "live"

function cleanProject(dir: string): string {
  return dir.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/") || dir;
}

function buildPhases(progress: any[], metaPhases: any[]): { phases: RunPhase[]; agents: RunAgent[] } {
  const phaseMap = new Map<number, RunPhase>();
  const order: number[] = [];
  const ensure = (index: number, title: string, detail?: string): RunPhase => {
    let p = phaseMap.get(index);
    if (!p) { p = { index, title, detail, agents: [] }; phaseMap.set(index, p); order.push(index); }
    else if (detail && !p.detail) p.detail = detail;
    return p;
  };
  (metaPhases || []).forEach((m, i) => ensure(i + 1, m?.title ?? `phase ${i + 1}`, m?.detail));
  const agents: RunAgent[] = [];
  for (const e of progress || []) {
    if (e.type === "workflow_phase") ensure(e.index, e.title ?? `phase ${e.index}`);
    else if (e.type === "workflow_agent") {
      const a: RunAgent = {
        index: e.index, label: e.label ?? `agent ${e.index}`, phaseIndex: e.phaseIndex, phaseTitle: e.phaseTitle,
        agentId: e.agentId, model: e.model, state: (e.state as AgentState) ?? "done",
        lastToolName: e.lastToolName, lastToolSummary: e.lastToolSummary, promptPreview: e.promptPreview,
        resultPreview: e.resultPreview, tokens: e.tokens, toolCalls: e.toolCalls, durationMs: e.durationMs,
        startedAt: e.startedAt, attempt: e.attempt,
      };
      agents.push(a);
      const pIdx = e.phaseIndex ?? 0;
      ensure(pIdx, e.phaseTitle ?? "(unphased)").agents.push(a);
    }
  }
  return { phases: order.map((i) => phaseMap.get(i)!).filter((p) => p.title !== "(start)"), agents };
}

function fromJournal(file: string, project: string, session: string): RunGraph | null {
  let o: any;
  try { o = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const mtime = statSync(file).mtimeMs;
  const start = o.startTime ?? (o.timestamp ? Date.parse(o.timestamp) : mtime); // avoid Date.parse("")===NaN
  const { phases, agents } = buildPhases(o.workflowProgress ?? [], o.phases ?? []);
  const status: RunStatus = (o.status as RunStatus) ?? "completed";
  const logs = (o.logs ?? []).map((l: any) => (typeof l === "string" ? l : JSON.stringify(l)));
  const summary = typeof o.summary === "string" ? o.summary : o.result?.brief?.stateSummary;
  const desc = (() => {
    const m = /name:\s*['"`][^'"`]*['"`][\s\S]*?description:\s*\n?\s*['"`]([^'"`]+)['"`]/.exec(o.script ?? "");
    return m?.[1];
  })();
  const finished = status !== "running";
  return {
    runId: o.runId ?? o.taskId ?? file, name: o.workflowName ?? o.runId ?? "run", status, project, session: session.slice(0, 8),
    startTime: start, mtime, durationMs: o.durationMs, agentCount: o.agentCount ?? agents.length,
    totalTokens: o.totalTokens, totalToolCalls: o.totalToolCalls, summary, description: desc,
    logs, phases, scriptPath: o.scriptPath,
    live: !finished || Date.now() - (start + (o.durationMs ?? 0)) < LIVE_WINDOW_MS,
  };
}

// Reconstruct a RUNNING workflow's agents live by tailing their subagent
// transcripts at <project>/<session>/subagents/workflows/<runId>/agent-*.jsonl
// (appended in real time). The journal isn't on disk until the run ends, so
// this is the only mid-run source. Returns [] if the dir isn't found.
const FRESH_MS = 20_000; // appended this recently => still working
function liveAgentsForRun(runId: string, root: string): RunAgent[] {
  // find the subagents dir for this runId across projects/sessions (cheap stat probe)
  let dir: string | null = null;
  try {
    outer: for (const p of readdirSync(root)) {
      const pdir = join(root, p);
      let sessions: string[];
      try { if (!statSync(pdir).isDirectory()) continue; sessions = readdirSync(pdir); } catch { continue; }
      for (const s of sessions) {
        const cand = join(pdir, s, "subagents", "workflows", runId);
        if (existsSync(cand)) { dir = cand; break outer; }
      }
    }
  } catch { /* */ }
  if (!dir) return [];
  const agents: RunAgent[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const f of entries.filter((x) => x.endsWith(".jsonl"))) {
    const full = join(dir, f);
    const id = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    let agentType: string | undefined;
    try { agentType = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8")).agentType; } catch { /* */ }
    let lines: string[] = [], mtime = 0;
    try { lines = readFileSync(full, "utf8").trim().split("\n"); mtime = statSync(full).mtimeMs; } catch { continue; }
    let lastTool: string | undefined, lastText: string | undefined, tools = 0, prompt: string | undefined, done = false;
    for (const line of lines) {
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "user" && typeof o.message?.content === "string" && !prompt) prompt = o.message.content.replace(/\s+/g, " ").slice(0, 120);
      else if (o.type === "assistant") for (const part of o.message?.content ?? []) {
        if (part.type === "tool_use") { tools++; lastTool = part.name; if (part.name === "StructuredOutput") done = true; }
        else if (part.type === "text" && part.text?.trim()) lastText = part.text.replace(/\s+/g, " ").slice(0, 120);
      }
    }
    const fresh = Date.now() - mtime < FRESH_MS;
    agents.push({
      index: agents.length + 1, label: agentType ? `${agentType}:${id.slice(0, 6)}` : id.slice(0, 10),
      agentType, state: done ? "done" : fresh ? "progress" : "start",
      lastToolName: lastTool, lastToolSummary: lastText, promptPreview: prompt, toolCalls: tools, startedAt: mtime,
    });
  }
  return agents;
}

// In-flight: a script whose runId has no journal yet. The script mtime is set
// once at START, so liveness is judged by FRESH subagent transcripts, not the
// script age (a long run would otherwise look stale). A run with no live agents
// and an old script is a crash — skipped.
function orphanRuns(wfDir: string, project: string, session: string, journalIds: Set<string>, root: string): RunGraph[] {
  const sdir = join(wfDir, "scripts");
  if (!existsSync(sdir)) return [];
  const out: RunGraph[] = [];
  for (const f of readdirSync(sdir)) {
    const m = /^(.*)-(wf_[a-z0-9-]+)\.js$/.exec(f);
    if (!m) continue;
    const [, name, runId] = m;
    if (journalIds.has(runId)) continue;
    const full = join(sdir, f);
    const scriptMtime = statSync(full).mtimeMs;
    const agents = liveAgentsForRun(runId, root);
    const working = agents.some((a) => a.state === "progress");
    const scriptFresh = Date.now() - scriptMtime < LIVE_WINDOW_MS;
    if (!working && !scriptFresh) continue; // crashed/stale orphan, no live agents
    const mtime = Math.max(scriptMtime, ...agents.map((a) => a.startedAt ?? 0));
    const phases = agents.length ? [{ index: 1, title: "(live agents)", agents }] : [];
    out.push({
      runId, name, status: "running", project, session: session.slice(0, 8), startTime: scriptMtime, mtime,
      agentCount: agents.length, totalToolCalls: agents.reduce((a, x) => a + (x.toolCalls ?? 0), 0),
      logs: [], phases, scriptPath: full, live: true,
    });
  }
  return out;
}

// Completed journals are immutable once written, so cache parsed runs by
// path+mtime: the 1.5s poll then only stats files instead of re-parsing 700+
// JSON blobs each tick. `live` is wall-clock-relative, so recompute it on read.
const journalCache = new Map<string, { mtime: number; run: RunGraph }>();
const recomputeLive = (g: RunGraph): boolean =>
  g.status === "running" || Date.now() - (g.startTime + (g.durationMs ?? 0)) < LIVE_WINDOW_MS;

export function discoverRuns(root: string = PROJECTS_ROOT): RunGraph[] {
  const out: RunGraph[] = [];
  let projects: string[];
  try { projects = readdirSync(root); } catch { return out; }
  for (const p of projects) {
    const pdir = join(root, p);
    let sessions: string[];
    try { if (!statSync(pdir).isDirectory()) continue; sessions = readdirSync(pdir); } catch { continue; }
    const proj = cleanProject(p);
    for (const s of sessions) {
      const wfDir = join(pdir, s, "workflows");
      if (!existsSync(wfDir)) continue;
      const journalIds = new Set<string>();
      let entries: string[];
      try { entries = readdirSync(wfDir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".json")) continue;
        const full = join(wfDir, f);
        let mtime: number;
        try { mtime = statSync(full).mtimeMs; } catch { continue; }
        const hit = journalCache.get(full);
        let g: RunGraph | null;
        if (hit && hit.mtime === mtime) { g = hit.run; g.live = recomputeLive(g); }
        else { g = fromJournal(full, proj, s); if (g) journalCache.set(full, { mtime, run: g }); }
        if (g) { out.push(g); journalIds.add(g.runId); }
      }
      out.push(...orphanRuns(wfDir, proj, s, journalIds, root));
    }
  }
  out.sort((a, b) => Number(b.live) - Number(a.live) || b.startTime - a.startTime);
  return out;
}

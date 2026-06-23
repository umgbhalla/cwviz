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
  const start = o.startTime ?? Date.parse(o.timestamp ?? "") ?? mtime;
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

// In-flight: a script whose runId has no journal yet (running, or crashed).
// Only surfaced when recently touched, to avoid stale-crash noise.
function orphanRuns(wfDir: string, project: string, session: string, journalIds: Set<string>): RunGraph[] {
  const sdir = join(wfDir, "scripts");
  if (!existsSync(sdir)) return [];
  const out: RunGraph[] = [];
  for (const f of readdirSync(sdir)) {
    const m = /^(.*)-(wf_[a-z0-9-]+)\.js$/.exec(f);
    if (!m) continue;
    const [, name, runId] = m;
    if (journalIds.has(runId)) continue;
    const full = join(sdir, f);
    const mtime = statSync(full).mtimeMs;
    if (Date.now() - mtime > LIVE_WINDOW_MS) continue; // stale orphan, skip
    out.push({
      runId, name, status: "running", project, session: session.slice(0, 8), startTime: mtime, mtime,
      agentCount: 0, logs: [], phases: [], scriptPath: full, live: true,
    });
  }
  return out;
}

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
        const g = fromJournal(join(wfDir, f), proj, s);
        if (g) { out.push(g); journalIds.add(g.runId); }
      }
      out.push(...orphanRuns(wfDir, proj, s, journalIds));
    }
  }
  out.sort((a, b) => Number(b.live) - Number(a.live) || b.startTime - a.startTime);
  return out;
}

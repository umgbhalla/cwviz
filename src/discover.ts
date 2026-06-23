// Find Claude Code workflow scripts under a base dir: any `*.js` inside a
// `.claude/workflows/` directory. Skips node_modules / .git. Groups by repo.
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyzeWorkflow } from "./analyze.ts";
import type { WorkflowGraph } from "./model.ts";

const SKIP = /(^|\/)(node_modules|\.git|worktrees|\.deploy)\//;

// repo = the path segment that owns the .claude dir (dir right before /.claude/).
// When that's the base dir itself, label it with the base's folder name.
function repoOf(abs: string, base: string): { repo: string; rel: string } {
  const i = abs.indexOf("/.claude/workflows/");
  const repoPath = i >= 0 ? abs.slice(0, i) : abs;
  const sub = repoPath.startsWith(base) ? repoPath.slice(base.length).replace(/^\//, "") : repoPath.split("/").pop()!;
  const rel = abs.slice(i >= 0 ? i + "/.claude/workflows/".length : 0);
  return { repo: sub || basename(base) || ".", rel };
}

export async function discover(base: string): Promise<WorkflowGraph[]> {
  const glob = new Glob("**/.claude/workflows/**/*.js");
  const out: WorkflowGraph[] = [];
  for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true })) {
    if (SKIP.test("/" + rel)) continue;
    const abs = `${base}/${rel}`;
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const { repo, rel: wfRel } = repoOf(abs, base);
    out.push(analyzeWorkflow(abs, source, repo, wfRel));
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  return out;
}

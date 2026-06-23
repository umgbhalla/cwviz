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

// Bounded-depth scan: probe `.claude/workflows` at the base and up to MAX_DEPTH
// dirs below it, rather than a single `**/.claude/...` glob — that descends into
// every repo's src/vendor/node_modules and takes ~minutes on a big tree. Bounding
// the prefix keeps it tens of ms even from a parent-of-many-repos. `.claude` dirs
// found at deeper nesting (rare) are missed by design; run cwviz inside that repo.
const MAX_DEPTH = 4;

export async function discover(base: string): Promise<WorkflowGraph[]> {
  const seen = new Set<string>();
  const out: WorkflowGraph[] = [];
  for (let d = 0; d <= MAX_DEPTH; d++) {
    const prefix = "*/".repeat(d);
    const glob = new Glob(`${prefix}.claude/workflows/**/*.js`);
    for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true })) {
      if (SKIP.test("/" + rel) || seen.has(rel)) continue;
      seen.add(rel);
      const abs = `${base}/${rel}`;
      let source: string;
      try { source = readFileSync(abs, "utf8"); } catch { continue; }
      const { repo, rel: wfRel } = repoOf(abs, base);
      out.push(analyzeWorkflow(abs, source, repo, wfRel));
    }
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  return out;
}

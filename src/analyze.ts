// The yuku-powered analyser: parse a workflow .js with yuku-analyzer and
// statically extract its orchestration graph (meta + agent/parallel/pipeline
// /phase/workflow calls) without executing it.
import { Analyzer } from "yuku-analyzer";
import { basename } from "node:path";
import type { DeclaredPhase, Op, PhaseGroup, Stats, WorkflowGraph } from "./model.ts";

// --- static value resolution (no eval) -------------------------------------

// Resolve a node to a string when it's statically knowable: string literal,
// no-expression template, or `+` concat of resolvable parts. Else null.
function staticString(node: any): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q: any) => q.value.cooked ?? q.value.raw).join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticString(node.left);
    const r = staticString(node.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

// Best-effort human-readable snippet of an agent prompt (often a template
// literal with `${...}` holes). Collapse whitespace, mark holes with ·, cap len.
function snippet(node: any, max = 160): string | undefined {
  if (!node) return undefined;
  let s: string | null = staticString(node);
  if (s === null && node.type === "TemplateLiteral") {
    s = node.quasis.map((q: any, i: number) => (q.value.cooked ?? q.value.raw) + (i < node.expressions.length ? " · " : "")).join("");
  }
  if (s === null && node.type === "Identifier") s = `<${node.name}>`;
  if (s === null) return undefined;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const LOOP_TYPES = new Set(["ForStatement", "WhileStatement", "DoWhileStatement", "ForOfStatement", "ForInStatement"]);

// callee name for a CallExpression, handling `foo(...)` and `x.foo(...)`
function calleeName(node: any): string | null {
  const c = node.callee;
  if (c?.type === "Identifier") return c.name;
  if (c?.type === "MemberExpression") return c.property?.name ?? null;
  return null;
}

// --- meta extraction --------------------------------------------------------

function extractMeta(ast: any): { name: string; description?: string; phases: DeclaredPhase[] } {
  const out = { name: "", description: undefined as string | undefined, phases: [] as DeclaredPhase[] };
  for (const stmt of ast.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt.type === "VariableDeclaration" ? stmt : null;
    if (decl?.type !== "VariableDeclaration") continue;
    const d = decl.declarations.find((x: any) => x.id?.name === "meta");
    if (!d || d.init?.type !== "ObjectExpression") continue;
    for (const p of d.init.properties) {
      const key = p.key?.name ?? p.key?.value;
      if (key === "name") out.name = staticString(p.value) ?? "";
      else if (key === "description") out.description = staticString(p.value) ?? undefined;
      else if (key === "phases" && p.value.type === "ArrayExpression") {
        for (const el of p.value.elements) {
          if (el?.type !== "ObjectExpression") continue;
          const title = staticString(el.properties.find((x: any) => (x.key?.name ?? x.key?.value) === "title")?.value);
          const detail = staticString(el.properties.find((x: any) => (x.key?.name ?? x.key?.value) === "detail")?.value);
          if (title !== null) out.phases.push({ title, detail: detail ?? undefined });
        }
      }
    }
    return out;
  }
  return out;
}

// --- op extraction (walk in source order) -----------------------------------

const TRACKED = new Set(["agent", "parallel", "pipeline", "phase", "workflow", "log"]);

function extractOps(m: any): Op[] {
  const ops: Op[] = [];
  m.walk({
    CallExpression(node: any, ctx: any) {
      const name = calleeName(node);
      if (!name || !TRACKED.has(name)) return;
      // only count the bare orchestration primitives, not `x.parallel`/`x.log`
      if (node.callee.type !== "Identifier") return;
      const line = m.locOf(node)?.start?.line ?? 0;
      const looped = ctx.ancestors().some((a: any) => LOOP_TYPES.has(a.type));
      const op: Op = { kind: name as Op["kind"], line, looped };
      const args = node.arguments;
      if (name === "agent") {
        op.prompt = snippet(args[0]);
        const opts = args[1];
        if (opts?.type === "ObjectExpression") {
          for (const p of opts.properties) {
            const k = p.key?.name ?? p.key?.value;
            if (k === "label") op.label = staticString(p.value) ?? snippet(p.value, 40);
            else if (k === "phase") op.phase = staticString(p.value) ?? undefined;
            else if (k === "agentType") op.agentType = staticString(p.value) ?? undefined;
            else if (k === "model") op.model = staticString(p.value) ?? undefined;
            else if (k === "schema") op.schema = p.value.type === "Identifier" ? p.value.name : "inline";
          }
        }
      } else if (name === "parallel") {
        op.fan = args[0]?.type === "ArrayExpression" ? args[0].elements.length : null;
      } else if (name === "pipeline") {
        op.stages = Math.max(0, args.length - 1);
      } else if (name === "phase" || name === "workflow") {
        op.title = staticString(args[0]) ?? snippet(args[0], 40);
      }
      ops.push(op);
    },
  });
  return ops;
}

// --- assemble phases + stats -------------------------------------------------

function buildPhases(declared: DeclaredPhase[], ops: Op[]): PhaseGroup[] {
  const groups = new Map<string, PhaseGroup>();
  const order: string[] = [];
  const ensure = (title: string, declaredFlag: boolean, detail?: string): PhaseGroup => {
    let g = groups.get(title);
    if (!g) {
      g = { title, detail, declared: declaredFlag, agents: [], parallel: 0, pipeline: 0 };
      groups.set(title, g);
      order.push(title);
    } else if (detail && !g.detail) g.detail = detail;
    return g;
  };
  for (const p of declared) ensure(p.title, true, p.detail);

  let current = "(start)";
  for (const op of ops) {
    if (op.kind === "phase" && op.title) {
      current = op.title;
      ensure(current, declared.some((d) => d.title === current));
      continue;
    }
    const phaseTitle = op.phase ?? current;
    const g = ensure(phaseTitle, declared.some((d) => d.title === phaseTitle));
    if (op.kind === "agent") g.agents.push(op);
    else if (op.kind === "parallel") g.parallel++;
    else if (op.kind === "pipeline") g.pipeline++;
  }
  // drop the synthetic "(start)" bucket if it stayed empty
  return order
    .map((t) => groups.get(t)!)
    .filter((g) => !(g.title === "(start)" && g.agents.length === 0 && g.parallel === 0 && g.pipeline === 0));
}

function buildStats(ops: Op[], source: string): Stats {
  const s: Stats = { agents: 0, parallel: 0, pipeline: 0, phases: 0, workflows: 0, loops: 0, lines: source.split("\n").length, agentTypes: {}, schemas: [], models: [] };
  const schemas = new Set<string>();
  const models = new Set<string>();
  for (const op of ops) {
    if (op.looped) s.loops++;
    if (op.kind === "agent") {
      s.agents++;
      const at = op.agentType ?? "(default)";
      s.agentTypes[at] = (s.agentTypes[at] ?? 0) + 1;
      if (op.schema) schemas.add(op.schema);
      if (op.model) models.add(op.model);
    } else if (op.kind === "parallel") s.parallel++;
    else if (op.kind === "pipeline") s.pipeline++;
    else if (op.kind === "phase") s.phases++;
    else if (op.kind === "workflow") s.workflows++;
  }
  s.schemas = [...schemas].sort();
  s.models = [...models].sort();
  return s;
}

// --- public entrypoint -------------------------------------------------------

export function analyzeWorkflow(file: string, source: string, repo: string, rel: string): WorkflowGraph {
  const base: WorkflowGraph = {
    file, repo, rel, name: basename(file).replace(/\.workflow\.js$|\.js$/, ""),
    declaredPhases: [], ops: [], phases: [],
    stats: { agents: 0, parallel: 0, pipeline: 0, phases: 0, workflows: 0, loops: 0, lines: source.split("\n").length, agentTypes: {}, schemas: [], models: [] },
  };
  try {
    const a = new Analyzer();
    const m = a.addFile(basename(file), source);
    const ast = m.ast;
    const meta = extractMeta(ast);
    const ops = extractOps(m);
    return {
      ...base,
      name: meta.name || base.name,
      description: meta.description,
      declaredPhases: meta.phases,
      ops,
      phases: buildPhases(meta.phases, ops),
      stats: buildStats(ops, source),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

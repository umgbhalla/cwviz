// Data model for an analyzed Claude Code workflow script.
// A workflow file is `export const meta = {...}` + a body that orchestrates
// subagents via agent()/parallel()/pipeline()/phase()/workflow()/log().

export type OpKind = "agent" | "parallel" | "pipeline" | "phase" | "workflow" | "log";

export interface Op {
  kind: OpKind;
  line: number;
  looped: boolean; // inside a for/while loop
  // agent
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  schema?: string; // identifier name, "inline", or undefined
  prompt?: string; // best-effort snippet
  // parallel: static fan count (null = dynamic, e.g. arr.map(...))
  fan?: number | null;
  // pipeline: number of stages
  stages?: number;
  // phase / workflow
  title?: string; // phase title or workflow name
}

export interface DeclaredPhase {
  title: string;
  detail?: string;
}

export interface PhaseGroup {
  title: string;
  detail?: string;
  declared: boolean; // came from meta.phases
  agents: Op[];
  parallel: number;
  pipeline: number;
}

export interface Stats {
  agents: number;
  parallel: number;
  pipeline: number;
  phases: number;
  workflows: number;
  loops: number; // ops inside loops
  lines: number;
  agentTypes: Record<string, number>;
  schemas: string[];
  models: string[];
}

export interface WorkflowGraph {
  file: string; // absolute path
  repo: string; // owning repo dir name
  rel: string; // path relative to repo
  name: string;
  description?: string;
  declaredPhases: DeclaredPhase[];
  ops: Op[]; // in source order
  phases: PhaseGroup[]; // declared + discovered, agents assigned
  stats: Stats;
  error?: string; // parse/analyze failure
}

// Data model for a workflow RUN — one execution of a workflow script, read
// from a Claude Code session's `workflows/wf_*.json` journal (and in-flight
// `workflows/scripts/*.js` that have no journal yet).

export type RunStatus = "completed" | "killed" | "failed" | "running";
export type AgentState = "done" | "progress" | "error" | "start";

export interface RunAgent {
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  agentType?: string;
  state: AgentState;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
  attempt?: number;
}

export interface RunPhase {
  index: number;
  title: string;
  detail?: string;
  agents: RunAgent[];
}

export interface RunGraph {
  runId: string;
  name: string;
  status: RunStatus;
  project: string; // cleaned project path
  session: string; // session uuid (short)
  startTime: number; // ms epoch
  mtime: number; // journal/script mtime ms
  durationMs?: number;
  agentCount: number;
  totalTokens?: number;
  totalToolCalls?: number;
  summary?: string;
  description?: string;
  logs: string[];
  phases: RunPhase[];
  scriptPath?: string;
  live: boolean; // running, or finished within the live window
}

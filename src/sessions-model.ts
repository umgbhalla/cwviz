// Data model for Claude Code chat sessions, read from the top-level session
// transcript `~/.claude/projects/<project>/<session-uuid>.jsonl`.
// (Same line schema is used by subagent transcripts, so the parser is reusable.)

export type MsgKind = "user" | "text" | "thinking" | "tool" | "result";

export interface ChatMsg {
  kind: MsgKind;
  text: string;
  tool?: string; // tool name (kind === "tool")
  ts?: number;
}

export interface SessionMeta {
  id: string; // session uuid
  short: string; // first 8
  title: string; // ai title or first prompt
  project: string;
  cwd?: string;
  gitBranch?: string;
  mtime: number;
  sizeBytes: number;
  filePath: string;
}

export interface SessionTranscript {
  meta: SessionMeta;
  messages: ChatMsg[];
  userCount: number;
  assistantCount: number;
  toolCount: number;
  models: string[];
}

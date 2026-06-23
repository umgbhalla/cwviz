// ponytail: one runnable check on session discovery + transcript parsing.
import { discoverSessions, loadTranscript } from "./sessions.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assert = (c: unknown, m: string) => { if (!c) throw new Error("FAIL: " + m); };

const root = mkdtempSync(join(tmpdir(), "cwviz-ses-"));
const proj = join(root, "-Users-x-myrepo");
mkdirSync(proj, { recursive: true });

const lines = [
  { type: "ai-title", aiTitle: "Build the thing", sessionId: "s1" },
  { type: "user", message: { role: "user", content: "make me a parser" }, timestamp: "2026-06-23T10:00:00Z", cwd: "/x/myrepo", gitBranch: "main" },
  { type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [
    { type: "thinking", thinking: "let me think about parsing" },
    { type: "text", text: "I'll write a parser." },
    { type: "tool_use", name: "Write", input: { file_path: "/x/parser.ts" } },
  ] }, timestamp: "2026-06-23T10:00:05Z" },
  { type: "user", message: { content: [{ type: "tool_result", content: "File created" }] } },
];
writeFileSync(join(proj, "s1session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const sessions = discoverSessions(root);
assert(sessions.length === 1, "one session discovered");
const s = sessions[0];
assert(s.title === "Build the thing", "ai-title used, got " + s.title);
assert(s.gitBranch === "main", "git branch captured");

const tr = loadTranscript(s);
assert(tr.userCount === 1, "1 user prompt, got " + tr.userCount);
assert(tr.toolCount === 1, "1 tool call, got " + tr.toolCount);
assert(tr.models.includes("claude-opus-4-8"), "model captured");
const kinds = tr.messages.map((m) => m.kind);
assert(kinds.includes("user") && kinds.includes("text") && kinds.includes("thinking") && kinds.includes("tool") && kinds.includes("result"), "all msg kinds parsed: " + kinds.join(","));
assert(tr.messages.find((m) => m.kind === "tool")!.tool === "Write", "tool name parsed");

console.log("ok — sessions.test passed (discovery + transcript parse)");

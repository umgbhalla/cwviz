// Discover + parse Claude Code chat sessions. List metadata is cheap (stat +
// a small head read for a title); full transcripts are parsed lazily on demand.
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_ROOT } from "./runs.ts";
import type { ChatMsg, SessionMeta, SessionTranscript } from "./sessions-model.ts";

function cleanProject(dir: string): string {
  return dir.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/") || dir;
}

// Read the first `bytes` of a file without loading the whole thing.
function head(filePath: string, bytes = 65536): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally { closeSync(fd); }
}

// Pull the first usable title from the head: prefer an ai-title line, else the
// first real user prompt (skip command/hook noise).
function titleFromHead(text: string): string {
  let firstUser = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; } // last line may be truncated
    if (o.type === "ai-title" && o.aiTitle) return String(o.aiTitle).slice(0, 80);
    if (!firstUser && o.type === "user" && typeof o.message?.content === "string") {
      const c = o.message.content.trim();
      if (c && !c.startsWith("<") && !c.startsWith("Caveat:")) firstUser = c.replace(/\s+/g, " ").slice(0, 80);
    }
  }
  return firstUser || "(untitled session)";
}

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description ?? input.prompt;
  if (typeof pick === "string") return pick.replace(/\s+/g, " ").slice(0, 100);
  return Object.keys(input).slice(0, 3).join(",");
}

// Parse one transcript line into chat messages (0..n). Reused for sessions and
// subagent logs (identical schema).
function parseLine(o: any, out: ChatMsg[], counts: { u: number; a: number; t: number; models: Set<string> }): void {
  const ts = o.timestamp ? Date.parse(o.timestamp) : undefined;
  if (o.type === "user" && o.message) {
    const c = o.message.content;
    if (typeof c === "string") { const s = c.trim(); if (s && !s.startsWith("<")) { out.push({ kind: "user", text: s, ts }); counts.u++; } }
    else if (Array.isArray(c)) for (const part of c) {
      if (part.type === "text" && part.text?.trim()) { out.push({ kind: "user", text: part.text.trim(), ts }); counts.u++; }
      else if (part.type === "tool_result") {
        const r = typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((x: any) => x.text ?? "").join(" ") : "";
        if (r.trim()) out.push({ kind: "result", text: r.replace(/\s+/g, " ").trim(), ts });
      }
    }
  } else if (o.type === "assistant" && o.message) {
    if (o.message.model) counts.models.add(o.message.model);
    counts.a++;
    for (const part of o.message.content ?? []) {
      if (part.type === "text" && part.text?.trim()) out.push({ kind: "text", text: part.text.trim(), ts });
      else if (part.type === "thinking" && part.thinking?.trim()) out.push({ kind: "thinking", text: part.thinking.trim(), ts });
      else if (part.type === "tool_use") { out.push({ kind: "tool", tool: part.name, text: toolSummary(part.name, part.input), ts }); counts.t++; }
    }
  }
}

const TAIL_THRESHOLD = 1_500_000; // above this, read only the tail (avoid parsing a 15MB transcript on the render path)
const TAIL_BYTES = 800_000;

export function loadTranscript(meta: SessionMeta): SessionTranscript {
  const out: ChatMsg[] = [];
  const counts = { u: 0, a: 0, t: 0, models: new Set<string>() };
  let text = "", tailed = false;
  try {
    const size = statSync(meta.filePath).size;
    if (size > TAIL_THRESHOLD) {
      tailed = true;
      const fd = openSync(meta.filePath, "r");
      try {
        const buf = Buffer.alloc(TAIL_BYTES);
        const n = readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
        text = buf.toString("utf8", 0, n).replace(/^[^\n]*\n/, ""); // drop the partial first line
      } finally { closeSync(fd); }
    } else {
      text = readFileSync(meta.filePath, "utf8");
    }
  } catch { /* gone */ }
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { parseLine(JSON.parse(line), out, counts); } catch { /* skip */ } }
  return { meta, messages: out, userCount: counts.u, assistantCount: counts.a, toolCount: counts.t, models: [...counts.models], tailed };
}

export function discoverSessions(root: string = PROJECTS_ROOT): SessionMeta[] {
  const out: SessionMeta[] = [];
  let projects: string[];
  try { projects = readdirSync(root); } catch { return out; }
  for (const p of projects) {
    const pdir = join(root, p);
    let entries: string[];
    try { if (!statSync(pdir).isDirectory()) continue; entries = readdirSync(pdir); } catch { continue; }
    const proj = cleanProject(p);
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(pdir, f);
      let st;
      try { st = statSync(full); if (!st.isFile()) continue; } catch { continue; }
      const text = head(full);
      // grab a cwd/branch from the first object that has them
      let cwd: string | undefined, gitBranch: string | undefined;
      for (const line of text.split("\n")) { try { const o = JSON.parse(line); if (o.cwd) { cwd = o.cwd; gitBranch = o.gitBranch; break; } } catch { /* */ } }
      out.push({
        id: f.replace(".jsonl", ""), short: f.slice(0, 8), title: titleFromHead(text),
        project: proj, cwd, gitBranch, mtime: st.mtimeMs, sizeBytes: st.size, filePath: full,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

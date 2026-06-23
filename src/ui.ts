// opentui TUI with three modes (Tab cycles):
//   Workflows — static yuku analysis of .claude/workflows/*.js scripts (blueprints)
//   Runs      — live + historical executions from session journals
//   Sessions  — chat history of Claude Code sessions (lazy-loaded transcripts)
import {
  createCliRenderer, BoxRenderable, TextRenderable, ScrollBoxRenderable,
  SelectRenderable, SelectRenderableEvents, InputRenderable, InputRenderableEvents,
  t, fg, bold, type CliRenderer, type SelectOption, type KeyEvent,
} from "@opentui/core";
import type { WorkflowGraph } from "./model.ts";
import type { RunGraph, RunAgent } from "./runs-model.ts";
import type { SessionMeta, SessionTranscript } from "./sessions-model.ts";
import { loadTranscript } from "./sessions.ts";
import { watch, statSync, type FSWatcher } from "node:fs";

const C = {
  bg: "#0b0e14", panel: "#0e131b", border: "#2a3343", borderFocus: "#7aa2f7",
  repo: "#7aa2f7", name: "#c0caf5", dim: "#5c6370", desc: "#a9b1d6",
  phase: "#bb9af7", agent: "#9ece6a", schema: "#e0af68", model: "#f7768e",
  loop: "#ff9e64", fan: "#7dcfff", head: "#7dcfff", warn: "#f7768e",
  ok: "#9ece6a", run: "#7dcfff", kill: "#e0af68", fail: "#f7768e", live: "#7dcfff",
  user: "#7aa2f7", think: "#565f89", tool: "#7dcfff",
};

function wrap(s: string, width: number, max = 999): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    for (const w of para.split(/\s+/)) {
      if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    }
    out.push(cur);
    if (out.length >= max) return out.slice(0, max);
  }
  return out.slice(0, max);
}
const hist = (rec: Record<string, number>) =>
  Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ");
const fmtNum = (n?: number) => n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const fmtDur = (ms?: number) => ms == null ? "" : ms >= 3.6e6 ? (ms / 3.6e6).toFixed(1) + "h" : ms >= 6e4 ? (ms / 6e4).toFixed(1) + "m" : (ms / 1e3).toFixed(0) + "s";
const fmtKB = (b: number) => b >= 1e6 ? (b / 1e6).toFixed(1) + "MB" : (b / 1e3 | 0) + "KB";
const ago = (ms: number) => { const d = Date.now() - ms; return d < 6e4 ? Math.max(0, (d / 1e3) | 0) + "s" : d < 3.6e6 ? ((d / 6e4) | 0) + "m" : d < 8.64e7 ? ((d / 3.6e6) | 0) + "h" : ((d / 8.64e7) | 0) + "d"; };

const RUN_GLYPH: Record<string, [string, string]> = { completed: ["✓", C.ok], running: ["●", C.run], killed: ["⊘", C.kill], failed: ["✗", C.fail] };
const AGENT_GLYPH: Record<string, [string, string]> = { done: ["✓", C.ok], progress: ["●", C.run], error: ["✗", C.fail], start: ["◌", C.dim] };

type Mode = "workflows" | "runs" | "sessions";
const ORDER: Mode[] = ["workflows", "runs", "sessions"];

export interface SceneData {
  workflows: WorkflowGraph[];
  runs: RunGraph[];
  sessions: SessionMeta[];
  reloadRuns?: () => RunGraph[]; // present => live polling for Runs
}

export function buildScene(renderer: CliRenderer, data: SceneData): () => void {
  renderer.setBackgroundColor(C.bg);
  let runs = data.runs;
  const { workflows, sessions } = data;
  const tCache = new Map<string, SessionTranscript>();
  let mode: Mode = "workflows";

  const root = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "column", backgroundColor: C.bg });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, { id: "header", width: "100%", height: 3, flexDirection: "column", paddingLeft: 1, borderColor: C.border, border: ["bottom"], backgroundColor: C.panel });
  const headTitle = new TextRenderable(renderer, { content: "" });
  const headSub = new TextRenderable(renderer, { content: "" });
  header.add(headTitle); header.add(headSub);
  root.add(header);

  const body = new BoxRenderable(renderer, { id: "body", width: "100%", flexGrow: 1, flexDirection: "row", backgroundColor: C.bg });
  root.add(body);

  const left = new BoxRenderable(renderer, { id: "left", width: 48, height: "100%", flexDirection: "column", border: true, borderColor: C.border, title: " ", titleAlignment: "left", backgroundColor: C.panel });
  body.add(left);
  const filter = new InputRenderable(renderer, { id: "filter", width: "100%", placeholder: "/ to filter…", backgroundColor: C.panel, textColor: C.name, focusedBackgroundColor: "#151b26" });
  left.add(filter);
  const select = new SelectRenderable(renderer, {
    id: "sel", width: "100%", flexGrow: 1, options: [],
    backgroundColor: C.panel, focusedBackgroundColor: C.panel, textColor: C.name, focusedTextColor: C.name,
    selectedBackgroundColor: "#283457", selectedTextColor: "#ffffff",
    descriptionColor: C.dim, selectedDescriptionColor: C.repo,
    showScrollIndicator: true, showDescription: true, wrapSelection: false,
  });
  left.add(select);

  const right = new BoxRenderable(renderer, { id: "right", flexGrow: 1, height: "100%", border: true, borderColor: C.border, title: " detail ", titleAlignment: "left", backgroundColor: C.bg });
  body.add(right);
  const detail = new ScrollBoxRenderable(renderer, { id: "detail", width: "100%", height: "100%", backgroundColor: C.bg, paddingLeft: 1, paddingRight: 1 });
  right.add(detail);

  const footer = new BoxRenderable(renderer, { id: "footer", width: "100%", height: 1, paddingLeft: 1, backgroundColor: C.panel });
  footer.add(new TextRenderable(renderer, { content: t`${fg(C.dim)("tab mode · ↑↓/jk select · / or ⌃K search · esc clear · PgUp/Dn scroll · q quit")}` }));
  root.add(footer);

  const termW = () => Math.max(24, (renderer.terminalWidth ?? 120) - 48 - 6);

  // ── header ──
  function updateHeader() {
    const tab = (m: Mode, label: string) => mode === m ? bold(fg(C.head)(`[${label}]`)) : fg(C.dim)(` ${label} `);
    headTitle.content = t`${bold(fg(C.head)("claude-workflow-viz"))}   ${tab("workflows", "Workflows")}${tab("runs", "Runs")}${tab("sessions", "Sessions")}`;
    if (mode === "workflows") {
      const repos = new Set(workflows.map((g) => g.repo)).size;
      const agents = workflows.reduce((a, g) => a + g.stats.agents, 0);
      headSub.content = t`${fg(C.dim)(`${workflows.length} workflow scripts · ${repos} repos · ${agents} agent calls (static)`)}`;
    } else if (mode === "runs") {
      const liveN = runs.filter((r) => r.live).length;
      const tok = runs.reduce((a, r) => a + (r.totalTokens ?? 0), 0);
      headSub.content = t`${fg(C.dim)(`${runs.length} runs · `)}${liveN ? fg(C.live)(`${liveN} live ● · `) : fg(C.dim)("")}${fg(C.dim)(`${fmtNum(tok)} tokens (auto-refresh)`)}`;
    } else {
      const projs = new Set(sessions.map((s) => s.project)).size;
      headSub.content = t`${fg(C.dim)(`${sessions.length} chat sessions · ${projs} projects`)}`;
    }
  }

  // ── option builders ──
  const wfOption = (g: WorkflowGraph): SelectOption => ({ name: g.error ? `⚠ ${g.name}` : g.name, description: `${g.repo} · ${g.stats.agents}a ${g.stats.parallel}∥ ${g.declaredPhases.length}◷` });
  const runOption = (r: RunGraph): SelectOption => ({ name: `${(RUN_GLYPH[r.status] ?? ["?"])[0]} ${r.name}`, description: `${r.project} · ${r.agentCount}a · ${fmtNum(r.totalTokens)}tok · ${ago(r.mtime)}` });
  const sesOption = (s: SessionMeta): SelectOption => ({ name: s.title, description: `${s.project} · ${fmtKB(s.sizeBytes)} · ${ago(s.mtime)}` });

  // ── detail renderers ──
  function renderWorkflow(line: (c: any) => void, g: WorkflowGraph, w: number) {
    line(t`${bold(fg(C.name)(g.name))}`);
    line(t`${fg(C.repo)(g.repo)}${fg(C.dim)(" / " + g.rel)}`);
    if (g.error) { line(t` `); line(t`${fg(C.warn)("parse error: " + g.error)}`); return; }
    line(t` `);
    if (g.description) for (const l of wrap(g.description, w)) line(t`${fg(C.desc)(l)}`);
    line(t` `);
    const s = g.stats;
    line(t`${fg(C.agent)(`⛓ ${s.agents} agents`)}${fg(C.dim)(" · ")}${fg(C.fan)(`${s.parallel}∥ ${s.pipeline}⇶`)}${fg(C.dim)(" · ")}${fg(C.phase)(`${g.phases.length} phases`)}${fg(C.dim)(" · ")}${fg(C.loop)(`↻${s.loops}`)}${fg(C.dim)(` · ${s.lines} loc`)}`);
    line(t` `);
    line(t`${bold(fg(C.head)("PHASES"))}`);
    for (const p of g.phases) {
      line(t`${fg(C.phase)("▸ " + p.title)}${p.declared ? "" : fg(C.dim)(" *")}${p.detail ? fg(C.dim)("  — " + p.detail) : ""}`);
      for (const a of p.agents) {
        const lbl = a.label ?? a.prompt ?? "agent";
        line(t`   ${fg(C.agent)("•")} ${fg(C.name)(lbl)} ${a.agentType ? fg(C.dim)(`[${a.agentType}]`) : ""}${a.schema ? fg(C.schema)(` →${a.schema}`) : ""}${a.model ? fg(C.model)(` @${a.model}`) : ""}${a.looped ? fg(C.loop)(" ↻") : ""}`);
      }
      if (p.parallel) line(t`   ${fg(C.fan)(`⇉ parallel ×${p.parallel}`)}`);
      if (p.pipeline) line(t`   ${fg(C.fan)(`⇶ pipeline ×${p.pipeline}`)}`);
    }
    line(t` `);
    line(t`${bold(fg(C.head)("INVENTORY"))}`);
    line(t`${fg(C.dim)("agent types: ")}${fg(C.name)(hist(s.agentTypes) || "—")}`);
    line(t`${fg(C.dim)("schemas: ")}${fg(C.schema)(s.schemas.join(", ") || "—")}`);
    line(t`${fg(C.dim)("models: ")}${fg(C.model)(s.models.join(", ") || "—")}`);
  }

  function renderAgentRow(line: (c: any) => void, a: RunAgent, w: number) {
    const [gl, gc] = AGENT_GLYPH[a.state] ?? ["•", C.agent];
    const tail = `${a.tokens ? fmtNum(a.tokens) + "tok " : ""}${a.toolCalls ? a.toolCalls + "🔧 " : ""}${a.durationMs ? fmtDur(a.durationMs) : ""}`.trim();
    line(t`   ${fg(gc)(gl)} ${fg(C.name)(a.label)}${a.attempt && a.attempt > 1 ? fg(C.kill)(` ⟳${a.attempt}`) : ""} ${fg(C.dim)(tail)}`);
    if (a.state === "progress" && a.lastToolName) line(t`      ${fg(C.run)("→ " + a.lastToolName)} ${fg(C.dim)((a.lastToolSummary ?? "").slice(0, w - 12))}`);
    else if (a.resultPreview) line(t`      ${fg(C.dim)("↳ " + a.resultPreview.slice(0, w - 10))}`);
  }

  function renderRun(line: (c: any) => void, r: RunGraph, w: number) {
    const [gl, gc] = RUN_GLYPH[r.status] ?? ["?", C.dim];
    line(t`${fg(gc)(gl + " ")}${bold(fg(C.name)(r.name))}${r.live ? fg(C.live)("  ● LIVE") : ""}`);
    line(t`${fg(C.repo)(r.project)}${fg(C.dim)(" · " + r.session + " · " + r.runId)}`);
    line(t` `);
    if (r.description) { for (const l of wrap(r.description, w, 4)) line(t`${fg(C.desc)(l)}`); line(t` `); }
    line(t`${fg(gc)(r.status)}${fg(C.dim)(" · ")}${fg(C.agent)(`${r.agentCount} agents`)}${fg(C.dim)(" · ")}${fg(C.schema)(`${fmtNum(r.totalTokens)} tok`)}${fg(C.dim)(" · ")}${fg(C.fan)(`${r.totalToolCalls ?? "—"} tools`)}${fg(C.dim)(" · ")}${fg(C.model)(fmtDur(r.durationMs) || "—")}${fg(C.dim)(` · ${ago(r.mtime)} ago`)}`);
    line(t` `);
    if (r.summary) { line(t`${bold(fg(C.head)("SUMMARY"))}`); for (const l of wrap(r.summary, w, 6)) line(t`${fg(C.desc)(l)}`); line(t` `); }
    line(t`${bold(fg(C.head)("PHASES"))}`);
    if (!r.phases.length) line(t`${fg(C.dim)(r.status === "running" ? "  (spawning… no progress yet)" : "  (no per-agent progress recorded)")}`);
    for (const p of r.phases) {
      const running = p.agents.filter((a) => a.state === "progress").length;
      line(t`${fg(C.phase)("▸ " + p.title)}${fg(C.dim)(`  (${p.agents.length})`)}${running ? fg(C.live)(` ${running}●`) : ""}${p.detail ? fg(C.dim)("  — " + p.detail.slice(0, w - p.title.length - 12)) : ""}`);
      for (const a of p.agents) renderAgentRow(line, a, w);
    }
    if (r.logs.length) { line(t` `); line(t`${bold(fg(C.head)("LOG"))}`); for (const l of r.logs.slice(-10)) line(t`${fg(C.dim)("· " + l.slice(0, w - 2))}`); }
  }

  function renderSession(line: (c: any) => void, s: SessionMeta, w: number) {
    try { const st = statSync(s.filePath); s.mtime = st.mtimeMs; s.sizeBytes = st.size; } catch { /* gone */ }
    let tr = tCache.get(s.id);
    if (!tr) { tr = loadTranscript(s); tCache.set(s.id, tr); if (tCache.size > 40) tCache.delete(tCache.keys().next().value!); }
    const liveNow = Date.now() - s.mtime < 60_000;
    line(t`${bold(fg(C.name)(s.title))}${liveNow ? fg(C.live)("  ● LIVE") : ""}`);
    line(t`${fg(C.repo)(s.project)}${fg(C.dim)(" · " + s.short + (s.gitBranch ? " · " + s.gitBranch : ""))}`);
    line(t` `);
    line(t`${fg(C.user)(`${tr.userCount} prompts`)}${fg(C.dim)(" · ")}${fg(C.agent)(`${tr.assistantCount} replies`)}${fg(C.dim)(" · ")}${fg(C.tool)(`${tr.toolCount} tools`)}${fg(C.dim)(" · ")}${fg(C.model)(tr.models.join(", ") || "—")}${fg(C.dim)(` · ${fmtKB(s.sizeBytes)} · ${ago(s.mtime)} ago`)}`);
    line(t` `);
    line(t`${bold(fg(C.head)("TRANSCRIPT"))}`);
    const MAX = 300;
    const msgs = tr.messages.length > MAX ? tr.messages.slice(-MAX) : tr.messages;
    if (tr.messages.length > MAX) line(t`${fg(C.dim)(`… ${tr.messages.length - MAX} earlier messages hidden — showing latest ${MAX}`)}`);
    for (const m of msgs) {
      if (m.kind === "user") { line(t` `); for (const l of wrap(m.text, w - 2, 14)) line(t`${fg(C.user)("❯ ")}${fg(C.name)(l)}`); }
      else if (m.kind === "text") for (const l of wrap(m.text, w, 16)) line(t`${fg(C.desc)(l)}`);
      else if (m.kind === "thinking") line(t`${fg(C.think)("  💭 " + m.text.replace(/\s+/g, " ").slice(0, w - 6))}`);
      else if (m.kind === "tool") line(t`${fg(C.tool)("  🔧 " + (m.tool ?? "tool"))}${fg(C.dim)(m.text ? "  " + m.text.slice(0, w - 10) : "")}`);
      else if (m.kind === "result") line(t`${fg(C.dim)("  ↳ " + m.text.slice(0, w - 6))}`);
    }
  }

  // ── list + detail wiring ──
  let view: any[] = workflows;
  let content: BoxRenderable | null = null;
  function items(): any[] { return mode === "workflows" ? workflows : mode === "runs" ? runs : sessions; }
  function optionFor(x: any): SelectOption { return mode === "workflows" ? wfOption(x) : mode === "runs" ? runOption(x) : sesOption(x); }
  function matches(x: any, q: string): boolean {
    const hay = (mode === "workflows" ? `${x.name} ${x.repo} ${x.rel}` : mode === "runs" ? `${x.name} ${x.project} ${x.summary ?? ""}` : `${x.title} ${x.project} ${x.gitBranch ?? ""}`).toLowerCase();
    return hay.includes(q);
  }

  // fs.watch the selected session's transcript → live re-render on append.
  // (session .jsonl is appended per-message, so this is true real-time, no polling.)
  let sesWatcher: FSWatcher | null = null;
  let sesDebounce: ReturnType<typeof setTimeout> | null = null;
  function closeSesWatcher() { if (sesWatcher) { sesWatcher.close(); sesWatcher = null; } if (sesDebounce) { clearTimeout(sesDebounce); sesDebounce = null; } }

  function buildDetail(item: any, toBottom = false) {
    if (content) { detail.remove(content.id); content.destroyRecursively(); content = null; }
    detail.scrollTop = 0;
    if (!item) return;
    content = new BoxRenderable(renderer, { id: "detail-content", width: "100%", flexDirection: "column", backgroundColor: C.bg });
    detail.add(content);
    const line = (c: any) => content!.add(new TextRenderable(renderer, { content: c }));
    if (item.empty) { line(t`${fg(C.dim)("No matches.")}`); return; }
    if (mode === "workflows") renderWorkflow(line, item, termW());
    else if (mode === "runs") renderRun(line, item, termW());
    else renderSession(line, item, termW());
    if (toBottom) detail.scrollTop = Number.MAX_SAFE_INTEGER; // live tail jumps to newest
  }

  function showDetail(item: any) {
    closeSesWatcher();
    buildDetail(item);
    if (mode === "sessions" && item?.filePath) {
      try {
        sesWatcher = watch(item.filePath, () => {
          if (sesDebounce) clearTimeout(sesDebounce);
          sesDebounce = setTimeout(() => {
            if (mode !== "sessions" || view[selIdx] !== item) return; // selection moved
            tCache.delete(item.id);
            buildDetail(item, true);
          }, 200);
        });
      } catch { /* file vanished */ }
    }
  }

  function applyFilter(q: string, keepId?: string) {
    const needle = q.trim().toLowerCase();
    view = needle ? items().filter((x) => matches(x, needle)) : items();
    select.options = view.map(optionFor);
    left.title = ` ${mode} (${view.length}) `;
    const idx = keepId ? Math.max(0, view.findIndex((x) => (x.runId ?? x.id ?? x.file) === keepId)) : 0;
    selIdx = idx;
    try { select.selectedIndex = idx; } catch { /* older opentui */ }
    showDetail(view[idx] ?? { empty: true }); // explicit empty-state when no matches
  }

  function setMode(m: Mode) { mode = m; filter.value = ""; updateHeader(); applyFilter(""); }

  let selIdx = 0;
  let swallow = false; // eat the "/" that leaks into the input when "/" opens search
  select.on(SelectRenderableEvents.SELECTION_CHANGED, (i: number) => { selIdx = i; showDetail(view[i]); });
  filter.on(InputRenderableEvents.INPUT, (v: string) => {
    if (swallow) { swallow = false; const real = v.replace(/^\//, ""); if (real !== v) { filter.value = real; applyFilter(real); return; } }
    applyFilter(v);
  });

  updateHeader();
  applyFilter("");
  select.focus();

  // ── live polling (runs only) ──
  let timer: ReturnType<typeof setInterval> | null = null;
  if (data.reloadRuns) {
    timer = setInterval(() => {
      const next = data.reloadRuns!();
      const changed = next.length !== runs.length || next.some((r, i) => runs[i]?.runId !== r.runId || runs[i]?.mtime !== r.mtime);
      runs = next;
      if (mode === "runs") { updateHeader(); if (changed) applyFilter(filter.value, view[selIdx]?.runId); }
    }, 1500);
  }
  let quitting = false;
  const cleanup = () => { if (timer) { clearInterval(timer); timer = null; } closeSesWatcher(); };
  // Mirror opentui's own ctrl-c teardown: clear our handles, destroy (restores the
  // terminal, deferred until the frame unwinds), let the loop drain. No racing
  // process.exit — that skipped the deferred restore and left the terminal sticky.
  const quit = () => {
    if (quitting) return; quitting = true;
    cleanup();
    renderer.destroy();
    setTimeout(() => process.exit(0), 150); // fallback if something keeps the loop alive
  };

  // ── keys ──
  const focusList = (clearQuery: boolean) => {
    if (clearQuery && filter.value) { filter.value = ""; applyFilter(""); }
    filter.blur(); select.focus(); left.borderColor = C.border;
  };
  const openSearch = () => { swallow = true; select.blur(); filter.value = ""; filter.focus(); left.borderColor = C.borderFocus; applyFilter(""); };
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "c" && key.ctrl) return quit(); // explicit, in case exitOnCtrlC misses
    if (filter.focused) {
      if (key.name === "return") focusList(false);     // commit search, keep results
      else if (key.name === "escape") focusList(true);  // cancel search, restore full list
      return;
    }
    if (key.name === "q") quit();
    else if (key.name === "k" && key.ctrl) openSearch(); // Ctrl-K quick switcher
    else if (key.name === "tab") setMode(ORDER[(ORDER.indexOf(mode) + (key.shift ? ORDER.length - 1 : 1)) % ORDER.length]);
    else if (key.name === "/") openSearch();
    else if (key.name === "escape") focusList(true);
    else if (key.name === "pageup") detail.scrollTop = Math.max(0, detail.scrollTop - 12);
    else if (key.name === "pagedown") detail.scrollTop += 12;
  });

  return cleanup;
}

export async function launchUI(data: SceneData): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
  buildScene(renderer, data);
  renderer.start();
}

# Claude Code on-disk infra (as cwviz reads it)

Mapped by inspecting the Claude Code binary (`~/.local/share/claude/versions/<v>`, a Bun
standalone) with [bun-demincer](https://github.com/vicnaum/bun-demincer), plus empirical
verification of file write cadence. This is what cwviz reads and how the "live" behaviour works.

## Layout

```
~/.claude/projects/<sanitized-cwd>/
  <session-uuid>.jsonl                     # the chat transcript (one JSON object per line)
  <session-uuid>/
    workflows/
      wf_<id>.json                         # a workflow RUN journal (one per run)
      scripts/<name>-wf_<id>.js            # the workflow script, written at run START
    subagents/
      [<run-subdir>/]agent-<agentId>.jsonl # each spawned subagent's own transcript
    tool-results/<id>.txt                  # large tool outputs, spilled to disk
  memory/                                  # persistent memory files
```

The session path is `~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl`.
The binary builds the subagent path as `join(projectDir, session, "subagents", [runId,] "agent-<id>.jsonl")`.

## Transcript line schema (`<session>.jsonl`, `agent-*.jsonl` — identical)

One JSON object per line. Types seen: `user`, `assistant`, `attachment`, `system`,
`file-history-snapshot`, `ai-title`, `last-prompt`, `mode`, `permission-mode`, `queue-operation`.

- `user` — `{ message: { role, content }, timestamp, cwd, gitBranch, sessionId, … }`.
  `content` is a **string** (the prompt) or an **array** of `{type:"text"|"tool_result", …}`.
- `assistant` — `{ message: { role, model, content: [...] }, timestamp }`.
  `content` items: `{type:"thinking", thinking}`, `{type:"text", text}`, `{type:"tool_use", name, input}`.
- `ai-title` — `{ aiTitle }`, the generated session title.

## Workflow run journal (`workflows/wf_<id>.json`)

In memory the run is an object:
`{ prompt, summary, workflowName, title, phases, defaultModel, workflowRunId, workflowProgress:[],
progressVersion:0, agentCount:0, totalTokens:0, totalToolCalls:0, logs:[], abortController, agentControllers:Map }`.

`workflowProgress` is an event stream:
- `{ type:"workflow_phase", index, title }`
- `{ type:"workflow_agent", index, label, phaseIndex, phaseTitle, agentId, model, state, lastToolName,
   lastToolSummary, promptPreview, resultPreview, tokens, toolCalls, durationMs, startedAt, attempt }`
  — `state ∈ { start, progress, done, error }`.

`progressVersion` increments **in memory** on every update (`progressVersion + delta`). The persisted
JSON also carries `status` (`completed | killed | failed`), `durationMs`, `agentCount`, `totalTokens`,
`totalToolCalls`. Claude Code's own `/workflows` history dialog reads these same journals.

## Write cadence → the live story

Verified empirically (file mtimes vs message timestamps):

| Source | When written | Live? |
|--------|-------------|-------|
| `<session>.jsonl` | **appended per message**, continuously | ✅ `fs.watch(file)` = real-time chat |
| `subagents/agent-*.jsonl` | **appended across the whole run** (e.g. 446s, 961s spans) | ✅ tail = live per-agent activity |
| `workflows/wf_*.json` | **once, at completion** (mtime ≈ start + duration) | ❌ no mid-run snapshot on disk |
| `workflows/scripts/*.js` | at run **start** | ✅ presence ⇒ a run is in flight |

**Consequences for cwviz:**

1. **Live chat** — the active session's `.jsonl` grows in real time. cwviz `fs.watch`es the selected
   session file and re-renders on append (no polling). A session touched in the last minute is `● LIVE`.
2. **Live runs** — a running workflow has **no journal yet**, so mid-run state can't come from
   `wf_*.json`. The live signal is: a `scripts/<name>-wf_<id>.js` with no journal ⇒ in-flight, and its
   agents' `subagents/agent-*.jsonl` are appended live ⇒ tail them to reconstruct what each agent is
   doing right now. cwviz implements this: an in-flight run is reconstructed by tailing its
   `subagents/workflows/<runId>/agent-*.jsonl` (state from append-freshness, current tool + counts
   from the transcript tail, agent type from the sibling `.meta.json`), and the dir is polled for the
   completion journal that supersedes it.
3. **History** — completed journals appear atomically; watching the `workflows/` dir catches them.

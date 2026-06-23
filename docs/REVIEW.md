# cwviz Code Review

## Health verdict

Solid, well-commented small tool with a handful of real correctness bugs and a systemic "poll-everything-every-1.5s" performance pattern that won't scale past a few hundred journals; ship-able for personal use, not yet for big trees or shared output.

## Confirmed issues (ranked by severity)

| # | Title | Where | Problem | Fix |
|---|-------|-------|---------|-----|
| 1 | NaN startTime breaks live detection | `src/runs.ts:48` | `o.startTime ?? Date.parse(o.timestamp ?? "") ?? mtime` — when both fields are missing, `Date.parse("")` is `NaN`, and `??` does not treat `NaN` as nullish, so `start` becomes `NaN`. Downstream `Date.now() - (start+dur) < LIVE_WINDOW` is always false; finished runs never read as live. | `const start = o.startTime ?? (o.timestamp ? Date.parse(o.timestamp) : mtime) ?? mtime;` |
| 2 | Phase index 0 vs 1-indexed phases | `src/runs.ts:37-38` | Declared phases are 1-indexed (`ensure(i+1,...)` at line 24) but unphased agents default to index 0 (`e.phaseIndex ?? 0`). Creates an orphan phase 0 appended after real phases, mixing 0/1-based indexing in `order`. | Default to `1`, or track unphased agents separately without using index 0. |
| 3 | Full tree re-scan every 1.5s poll | `src/ui.ts:270-275`, `src/runs.ts:89-114` | Live polling calls `discoverRuns()` which does `readdirSync`/`readFileSync`/`statSync` across the whole `~/.claude/projects` tree plus `orphanRuns` scan every tick. O(n) per tick; 700+ journals = sustained FS load. | Quick: raise interval. Real: `fs.watch` top-level + mtime-indexed incremental rescan, merge deltas. |
| 4 | Absolute paths leak in `--json` | `src/index.ts:29`, `src/model.ts:54` | `WorkflowGraph.file` is an absolute path serialized straight to stdout, leaking home dir / FS layout. `repo`+`rel` already give context. | Omit/redact `file` via a `JSON.stringify` replacer or a serialization DTO. |
| 5 | Session transcript file paths stored absolute | `src/sessions.ts:100`, `src/sessions-model.ts:23` | `SessionMeta.filePath` holds the absolute `.jsonl` path; passed to `fs.watch`/`statSync`/`readFileSync` and prone to leaking via error traces. Reconstructable from root+project+id. | Store `(project,id)` only; rebuild path at use sites via a helper. (Not currently shown in UI, so lower real-world impact than #4.) |
| 6 | Unbounded transcript cache (memory leak) | `src/ui.ts:62,181,240` | `tCache` Map caches `SessionTranscript`s forever; entries only deleted on `fs.watch` of the active file. Browse 100 sessions, keep 100 transcripts in memory until exit. | Bounded LRU (e.g. 20-50) or time-based eviction. |
| 7 | `--runs 0` ignored | `src/index.ts:22` | `Number(positional) \|\| 40` treats `0` as falsy, so `--runs 0` shows 40. | `const n = positional !== undefined ? Number(positional) : 40;` |
| 8 | `loadTranscript` sync read blocks render on cache miss | `src/sessions.ts:71-78`, `src/ui.ts:182` | `readFileSync` + full parse on the detail render path; no size cap. First view of a large transcript stalls the TUI. The last-300 trim happens after the full parse. | Async read / streamed or tail-N parse; pair with #6 LRU. |
| 9 | Full transcripts rendered with no scrubbing | `src/sessions.ts:75-77`, `src/ui.ts:193-199` | Entire `.jsonl` (prompts, results, tool output, thinking) rendered verbatim; may contain secrets/PII. Risk is mainly on screenshare/record. | Optional `--scrub` regex redaction, or metadata-only mode. |
| 10 | Tool summaries leak paths/commands | `src/sessions.ts:39-43` | `toolSummary()` shows up to 100 chars of `command`/`file_path`/`path`/`query`/`prompt` in the TUI (e.g. a `Bash rm /…/.ssh/…`). | Per-tool sanitize: hide Bash command, basename-only for Read/Write. |
| 11 | Default reads ALL projects (no allowlist) | `src/index.ts:39-42` | `CWVIZ_PROJECTS` is opt-in; unset = empty `allow` = filter is a no-op, so every project in `~/.claude/projects` is indexed and shown. | Require the allowlist in TUI mode, confirm before indexing, or default to current-repo scope. |
| 12 | Redundant detail rebuild on every select/poll | `src/ui.ts:219-229,260,274` | `buildDetail` `destroyRecursively`s + recreates all `TextRenderable`s on every `SELECTION_CHANGED` and every 1.5s poll, even when the selected item is unchanged. | Track previous selection id; skip rebuild when unchanged. (Also addresses the related "fresh TextRenderables every rebuild" churn at `src/ui.ts:125-200`.) |
| 13 | Stale `selIdx` after polling refilter | `src/ui.ts:251,274` | `applyFilter` swaps `select.options` and `view` but never resyncs `select`'s internal index or `selIdx`; if the runs list shrinks, `view[selIdx]` can be undefined / point at the wrong item. | Have `applyFilter` set `select.select(idx)` and `selIdx = idx`. |
| 14 | Empty detail panel on zero filter results | `src/ui.ts:254` | Filtering to no matches calls `showDetail(undefined)`; `buildDetail` no-ops, leaving a blank pane with only `(0)` in the title — reads as frozen. | Render an explicit "No matches" empty state. |
| 15 | Unbounded pagedown scroll | `src/ui.ts:289` | `detail.scrollTop += 12` has no upper clamp (pageup at 288 correctly uses `Math.max(0,…)`). Scrolls indefinitely past content. | `Math.min(scrollTop+12, Math.max(0, scrollHeight - viewport.height))`. |
| 16 | `orphanRuns` rescans scripts dir every poll | `src/runs.ts:69-87` | `readdirSync` + per-file `statSync` of `scripts/` every tick, no change detection. Scales with session count. | Cache per `wfDir`, gate on dir mtime or `fs.watch`. |
| 17 | `discoverSessions` head-reads every session at startup | `src/sessions.ts:80-106` | Head-reads + JSON-parses title/cwd/branch for every `.jsonl`. Immutable metadata, but with 700+ sessions it's a slow boot. (Note: only at startup, not per-poll — finding's "every 1.5s" claim is wrong.) | Cache metadata keyed by `(project,id)`, invalidate on mtime delta. |

## Lower-confidence / style notes

- **`renderSession` synchronous `statSync` (`src/ui.ts:180`)** — flagged as a render-loop stall, but `buildDetail` only fires on navigation / debounced watch events, not per frame, and the fresh stat backs the live indicator. A single stat is cheap; not a real hot-path problem. Worth caching only if profiling says so.
- **Stale/deleted-file display (`src/ui.ts:180,236-242`)** — when a watched session file is deleted, stale mtime/size are shown and the transcript silently empties. Minor; show "(deleted)".
- **Word-wrap doesn't truncate long words (`src/ui.ts:25-37`)** and **negative slice indices in very narrow terminals (`src/ui.ts:156-198`)** — only bite below the `Math.max(24,…)` floor; clamp widths with `Math.max(0, …)` defensively.
- **No resize handling / `terminalWidth` fallback of 120 (`src/ui.ts:99,282-290`)** — wrapping uses stale width until next rebuild. Add a resize listener if opentui exposes one.
- **Empty-state messaging when Tab-ing to an empty mode (`src/ui.ts:264`)** — cosmetic; only the title count signals emptiness.
- **`el.properties?.find` null-guard (`src/analyze.ts:66-67`)** — defensive only; AST ObjectExpression always has `properties`. Harmless to add `?.`.

### Findings reviewed and rejected (false alarms)

- `fs.watch` recreated during polling (`ui.ts:236,274`) — guarded by `if (mode==="runs")`; watcher only built on manual sessions-mode navigation, and `closeSesWatcher` runs first.
- `sesDebounce` timeout accumulation — only one pending timeout (cleared at 237), and the `mode!=="sessions"` guard plus synchronous `watch.close()` make it safe.
- fs.watch stale-`item` race — sessions are never reloaded, so object identity is stable; the reference check is correct.
- `discover()` "unbounded glob" — it's a deliberate bounded-depth scan (MAX_DEPTH=4), called once at boot.
- `scriptPath` privacy leak (`runs.ts:83`) — set but never displayed, exported, or logged.
- `cwd` privacy leak — extracted into `SessionMeta` but never read/rendered/exported (dead field).
- Agent `prompt` snippets / run result+prompt previews "leak secrets" — sourced from the user's own local workflow source / journals; static analysis surfaces only what's already in those files. Not a tool-introduced exposure.

## Prioritized action list

1. **Fix the three correctness one-liners** — NaN start (`runs.ts:48`), phase index (`runs.ts:37`), `--runs 0` (`index.ts:22`). Cheap, high value.
2. **Redact absolute `file` from `--json`** (`index.ts:29`) — the one privacy issue with a real exfil path (stdout).
3. **Tame polling cost** — bound `tCache` (LRU), gate detail rebuilds on selection change, and stop full-tree rescans every 1.5s (mtime-index or `fs.watch`); together these fix #3/#6/#12/#16.
4. **Async/tail transcript loading** (`sessions.ts:71`) to kill the render stall on large sessions.
5. **UX clamps** — pagedown bound (`ui.ts:289`), `selIdx` resync after refilter (`ui.ts:274`), empty-state message (`ui.ts:254`).
6. **Decide the default-scope policy** — either require `CWVIZ_PROJECTS` in TUI mode or document the all-projects default; add optional transcript scrubbing if output is ever shared.

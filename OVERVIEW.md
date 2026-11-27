# Turnline

Turnline adds a **Turns** workspace panel (in the workspace tab bar, the explorer, and the Command Center as "Open turn inspector") that organizes agent activity into expandable turn cards on a live timeline.

## What it shows

- **Turn cards**: Groups each prompt, thinking block, tool call, and reply into one card with status, duration, token totals, cache hit rate, context usage, and cost.
- **Step details**: Expand any turn to inspect per-step token and cache metrics, then expand individual steps for full reasoning, diffs, shell commands with exit codes, file contents, and errors.
- **Prompt context**: Expand **Prompt context** inside a turn to view the active model, system prompt sections, tools, and full context messages on demand.
- **Live filtering and search**: Streams active turns with a pulsing indicator, filters by agent or status (running, failed), searches across prompts, tools, and files, toggles newest-first or oldest-first sorting per tab, and loads older history on demand.

## Requirements

- Paseo 0.15.4 or later.
- `sqlite3` on the daemon `PATH` when inspecting Devin CLI or Antigravity sessions.

## Provider support and data access

Turn structure comes from Paseo's canonical timeline for all providers. For the providers below, Turnline's daemon subprocess also reads local session files directly on the daemon host to show prompt context and per-step usage. Turnline makes no external network requests itself; prompts and tool results are still sent to each agent's configured provider during normal agent runs.

| Provider | Prompt replay | Tools | Per-step usage | Local store |
| --- | --- | --- | --- | --- |
| **Claude Code** | Historical | Declared or observed | Yes | `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`) |
| **Codex** | Historical | Observed | Yes | `~/.codex/sessions/` and `archived_sessions/` (or `CODEX_HOME`) |
| **pi** | Historical | Declared | Yes | `~/.pi/agent/sessions/` |
| **Devin CLI** | Historical | None | Yes | `~/.local/share/devin/cli/sessions.db` (or `XDG_DATA_HOME`) |
| **Antigravity** | Latest request only | Observed | Yes | `~/.gemini/antigravity-cli/conversations/<id>.db` |

Other providers fall back to Paseo's canonical timeline alone, without prompt context or per-step usage breakdown.

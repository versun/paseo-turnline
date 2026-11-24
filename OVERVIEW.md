# Turnline

Turnline adds a **Turns** panel to every workspace (available in the workspace tab bar, the explorer, and the Command Center as "Open turn inspector"). It organizes agent activity into expandable turn cards on a scrollable timeline.

## What it shows

Each turn card groups one prompt, thinking steps, tool calls with their inputs and outputs, and the assistant's reply. A summary line displays status, duration, token usage, cache hit rate, and cost when reported. Expanding a turn reveals every step in order with per-step token and cache metrics; individual steps expand again for full command output, diffs, file contents, and errors.

- Live updates stream in while an agent runs, with a pulsing status indicator on active turns.
- Search across turns, tool calls, and files; filter by agent or status (running, failed).
- Toggle newest-first or oldest-first sorting (saved per tab) and load older history on demand.
- Expand **Prompt context** inside a turn to inspect the active model, system prompt sections, tools, and full context messages on demand.

## Provider support and data access

Turn structure comes from Paseo's canonical timeline for all providers. For supported providers, Turnline also reads local session logs or databases directly on the daemon host to show prompt context and per-step usage (no external network requests are made):

- **pi**: `~/.pi/agent/sessions/` JSONL logs (historical prompt replay, declared tools, per-step usage).
- **Claude Code**: `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`) JSONL transcripts (historical prompt replay, declared or observed tools, per-step usage).
- **Codex**: `~/.codex/sessions/` and `archived_sessions/` (or `CODEX_HOME`) rollout JSONL logs (historical prompt replay, observed tools, per-step usage).
- **Devin CLI**: `sessions.db` under `$XDG_DATA_HOME/devin/cli/` or `~/.local/share/devin/cli/` (historical prompt replay, per-step usage).
- **Antigravity**: `~/.gemini/antigravity-cli/conversations/<id>.db` (latest recorded request only, observed tools, per-step usage).

Other providers fall back to Paseo's canonical timeline alone, without prompt context or per-step usage breakdown.

## Requirements

- Paseo 0.15.4 or later.
- `sqlite3` on the daemon `PATH` when inspecting Devin CLI or Antigravity sessions.

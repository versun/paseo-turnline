# Turnline

Turnline adds a "Turns" panel to every workspace tab bar, listing each agent turn as a card on a scrollable timeline.

## What it shows

Each card groups one turn: the prompt, thinking, tool calls with their inputs and outputs, and the assistant's reply. A meta row shows the turn's status, duration, token usage, and cost when the provider reports them. Cards expand in place to show every timeline item in order; individual items expand again for full command output, diffs, and file contents.

## Behavior

- Live updates stream in while an agent runs; running turns show a pulsing status dot.
- Sort toggles between newest-first and oldest-first; the choice persists per tab.
- With several agents in a workspace, filter chips switch between all agents merged and one agent.
- "Load earlier activity" pages older history in on demand.

The panel reads Paseo's canonical agent timeline for turn structure, and reaches into each provider's own store for the raw prompt and per-call usage: pi sessions are replayed from their JSONL logs (system sections, tool declarations, compaction checkpoints), Claude Code sessions are replayed from their `~/.claude/projects/` JSONL transcripts (request-journal system prompts, declared or observed tools, system attachments, and per-call usage), Codex sessions are replayed from their `~/.codex/sessions/` and `archived_sessions/` rollout JSONL logs (base/developer/user instructions, developer prompt messages, observed tools, compaction history, and per-call `token_count` usage), Devin CLI sessions are read from its `sessions.db` request trees, and Antigravity conversations are decoded from the latest serialized request in `conversations/<id>.db` (named prompt sections, model, messages, observed tool calls). Expanding a turn shows the provider prompt that was effective at that point for pi, Claude Code, Codex, and Devin (or the latest recorded request for Antigravity), plus the full serialized request context on demand. Other providers fall back to the canonical timeline alone — their per-request parameters are not shown.

Requires Paseo 0.15.4 or later.

---
id: sta-rkyxs
status: closed
deps: []
links: []
created: 2026-04-18T21:25:31Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Expose thinkingLevel in config and enable for main agent

The main agent currently hardcodes `thinkingLevel: "off"` in `src/agent/index.ts` (around line 490). This causes some models to narrate their reasoning as normal text in the reply. Expose the thinking level via config and default it to "low".

Changes:
- Add optional `thinkingLevel?: string` to the `Config` interface in `src/config.ts`.
- In `createAgent` (src/agent/index.ts), replace the hardcoded `"off"` with `config.thinkingLevel ?? "low"`. Pass the string through to the Pi Agent as-is; no validation, no enum, no capability check.
- Subagents: unchanged. Anywhere else that constructs an agent (e.g. subagent construction, compaction internals) stays at whatever it currently uses.
- Update `config.example.toml`: add a commented-out `thinkingLevel` entry near `model`, with a comment listing the known values ("off", "low", "medium", "high", "xhigh") and noting the default is "low" when omitted.

Non-goals:
- Do NOT upgrade the Pi library version.
- Do NOT change subagent thinking behavior.
- Do NOT validate the string at load time.
- Do NOT add any model-capability checks, warnings, or fallbacks.
- Do NOT change compaction, the coder, or any other subsystem.

## Acceptance Criteria

- A config.toml without `thinkingLevel` starts up and the main agent runs with "low".
- A config.toml with `thinkingLevel = "medium"` starts up and the main agent runs with "medium".
- Subagent thinking behavior is unchanged.
- config.example.toml documents the new field with a comment enumerating known values.


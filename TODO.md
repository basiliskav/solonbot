# TODO items

Work on these one at a time. Delete when the user confirms they're done:

- Fix fail-open behavior for dotted tool scopes on tools without an `action` parameter.
  Severity: high (policy bypass / unintended privilege grant).
  Introduced in 18e74cef (subagent tool action scoping).
  Root cause: `filterToolsForSubagent()` wraps tools for dotted entries but only enforces
  the restriction when `params.action` is a string. If the tool has no `action` parameter,
  the check is skipped and the call passes through to the original execute unfiltered.
  Relevant code:
    - `src/agent.ts:968-979` — parses dotted entries into `actionMap`.
    - `src/agent.ts:988-1006` — wrapper execute logic; line 997 checks
      `typeof action === "string"` and falls through when it is not.
  Why this fails open: tools like `execute_sql` (params: `query` only, `src/agent.ts:55-74`)
  and `run_plugin_tool` (params: `plugin`, `tool`, `parameters`, `src/plugin-tools.ts:335-365`)
  do not have an `action` parameter at all.
  Repro:
    1. Create a subagent with `allowed_tools: ["execute_sql.select"]`.
    2. Route a prompt to that subagent asking it to run destructive SQL via `execute_sql`.
    3. Observe the call executes successfully — the dotted scope had no effect.
  Fix direction:
    - Fail closed: if a tool was included via dotted entries but `action` is not a string
      in the params, reject the call rather than allowing it.
    - Better: reject invalid dotted scopes at agent create/update time so they never reach
      runtime.
    - Optionally restrict dotted syntax to a known allowlist of action-based tools.
  Tests to add:
    - Dotted entry on `execute_sql` is rejected at config time or denied at runtime.
    - Dotted entry on `run_plugin_tool` is rejected/denied.
    - Non-dotted entry still grants full tool access as before.

- Validate `allowed_tools` entries on `manage_agents` create/update.
  Severity: medium (misconfiguration can silently mask over-privileged or under-privileged access).
  Root cause: arbitrary strings are accepted and stored without validation. Invalid tool names,
  invalid actions, and malformed dotted entries are persisted silently.
  Relevant code:
    - `src/agents.ts:64` — `allowed_tools` declared as freeform `Type.Array(Type.String())`.
    - `src/agents.ts:108-109` (create path), `src/agents.ts:141-143` (update path) — stored directly.
    - `src/database.ts:285-294`, `src/database.ts:317-320` — persisted without checks.
  Repro:
    1. Create an agent with `allowed_tools: ["execute_sql.selct", "nonexistent_tool.run", ".list", "manage_interlocutors."]`.
    2. Agent creation succeeds without warning.
    3. At runtime, some entries silently do nothing (typos, unknown tools), and some may
       overgrant access (see fail-open issue above).
  Fix direction:
    - Validate each entry on create/update:
      - Tool name portion must match a known tool.
      - Dotted syntax must have non-empty tool and action segments.
      - Action portion must be a valid action for that tool (for action-based tools).
      - Reject unknown tool names or unknown actions with an explicit error message.
  Tests to add:
    - Invalid tool name rejected.
    - Empty-segment entries (`"."`, `"tool."`, `".action"`) rejected.
    - Unknown action for a known tool rejected.
    - Valid bare and valid dotted entries accepted.

- Make restricted action scope visible to the model (schema/description mismatch).
  Severity: low (usability / token waste, not a security issue).
  Root cause: the wrapped tool copies the original tool's `parameters` schema and `description`
  verbatim via `...tool` spread (`src/agent.ts:993-1008`). The model sees all actions
  (create, update, delete, list, help, etc.) in the schema even when only a subset is allowed.
  It discovers restrictions only by trial and error, wasting tokens and turns.
  Repro:
    1. Configure a subagent with `allowed_tools: ["manage_interlocutors.list"]`.
    2. Ask the subagent to manage interlocutors broadly.
    3. The model attempts create/update/delete because the schema still advertises them;
       it gets runtime denial messages repeatedly before converging on `list`.
  Fix direction:
    - At minimum, append a restriction notice to the wrapped tool's `description`
      (e.g. "Restricted to actions: list.").
    - Better: narrow the `action` union in the `parameters` schema to only the allowed
      literals so the model never attempts disallowed actions.
  Tests to add:
    - Wrapped tool description contains allowed action list.
    - If schema is narrowed: emitted schema only includes allowed action literals.

- Pre-existing: subagent with `manage_agents.update` can escalate its own permissions.
  Severity: high if that permission is ever granted to a subagent.
  Not introduced by 18e74cef; pre-existing since the agents system was added.
  Root cause: `manage_agents` update action blocks modification of agent 1 (the main agent)
  but does not prevent a subagent from editing its own `allowed_tools` or those of other
  non-main agents.
  Relevant code:
    - `src/agents.ts:118-160` — update action handler.
    - `src/agents.ts:126-132` — only blocks `id === 1`.
  Repro:
    1. Create a subagent with `allowed_tools: ["manage_agents.update"]`.
    2. Instruct the subagent to update its own `allowed_tools` to include `execute_sql`.
    3. The update succeeds; the subagent now has `execute_sql` access on next prompt.
  Fix direction:
    - Enforce that only the main agent (agent 1) can change `allowed_tools` on any agent.
    - Or disallow self-targeted `allowed_tools` updates from subagents.
    - Or split the update action: allow subagents to update safe fields (name, system_prompt)
      but require main-agent context for `allowed_tools` changes.
  Tests to add:
    - Subagent cannot update its own `allowed_tools`.
    - Subagent cannot update another subagent's `allowed_tools`.
    - Main agent can still perform all legitimate updates.

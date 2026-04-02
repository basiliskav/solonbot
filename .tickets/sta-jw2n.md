---
id: sta-jw2n
status: closed
deps: []
links: []
created: 2026-04-02T21:39:30Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Support API key + base URL auth for coder subprocess

When both apiKey and baseUrl are set in config.toml (top-level), pass ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL to the claude subprocess instead of doing the credentials.json OAuth setup/teardown. Strip trailing /v1 from baseUrl since Claude Code adds its own path segments. Only coder/server.py changes. No formatting/style changes to existing code.

## Acceptance Criteria

load_config() returns api_key and coder_base_url as optional values. run_coding_task() skips credential setup/teardown and injects env vars when both are present. No behavioral change when apiKey/baseUrl are absent.


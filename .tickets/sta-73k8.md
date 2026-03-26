---
id: sta-73k8
status: closed
deps: []
links: []
created: 2026-03-26T17:55:19Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Unify manage_files path scope to TEMP_ATTACHMENTS_DIR for all actions

Currently write and delete only accept flat filenames in FILES_DIR, while read accepts both flat filenames and absolute paths under TEMP_ATTACHMENTS_DIR. Unify all actions to use the same path resolution: flat filename resolves to FILES_DIR, absolute path must be under TEMP_ATTACHMENTS_DIR. Extract the path resolution logic from the read action into a shared helper (e.g. resolvePath) and use it in write, read, and delete. Update the help text to reflect the change.

## Acceptance Criteria

write and delete accept absolute paths under TEMP_ATTACHMENTS_DIR, same as read. All three use the same shared path resolution helper. Help text documents the unified behavior. Type-checks and tests pass.


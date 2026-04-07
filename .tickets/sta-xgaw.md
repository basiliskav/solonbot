---
id: sta-xgaw
status: open
deps: []
links: []
created: 2026-04-07T00:59:43Z
type: task
priority: 2
assignee: Stavros Korokithakis
parent: sta-9vbc
tags: [channels, architecture]
---
# Define channel interface contract

Define the TypeScript interface contract that all channels (built-in and external) must satisfy. This is the foundation for the entire channel extraction — everything else builds on this.

## Context

The app currently has four hardcoded channels (Telegram, Email, WhatsApp, Signal) deeply coupled throughout the codebase. The goal is a uniform interface where built-in channels (in-process adapters) and external channels (separate containers speaking HTTP) look the same to the app. See parent ticket sta-9vbc for full background.

## Proposed interface

### Outbound (app → channel)

Every channel adapter has:
- `name`: identifier string ('telegram', 'email', etc.)
- `send(recipient, message, attachments)`: platform-specific send

The unified `send` tool does shared logic (recipient resolution, subagent scope check, allowlist check) then dispatches to the adapter's send method. Shared logic stays in the app; the adapter only handles platform-specific sending.

### Inbound (external platform → app)

Three patterns, all converging at `enqueueMessage({ source, sender, message, attachments })`:

1. **Webhook adapters** (Telegram, Email): external platform POSTs to the app → app hands raw request to adapter → adapter validates auth, normalizes → returns structured messages → app enqueues. Adapter additionally exposes:
   - `webhookPath`: the route to register (e.g. '/telegram/webhook')
   - `handleWebhook(request, body)` → normalized messages

2. **Persistent connection adapters** (WhatsApp): adapter manages its own connection, pushes normalized messages into the queue when they arrive. Adapter additionally exposes:
   - `start(enqueueCallback)`: start connection, call callback when messages arrive
   - `stop()`: disconnect

3. **External channels** (Signal, future): don't implement the adapter interface at all. They're a send URL in config. The app wraps them in a generic HTTP adapter that POSTs for outbound. For inbound, the external container POSTs to `POST /chat` (existing endpoint, what Signal already does).

### Built-in vs external distinction

If a channel's config has a `sendUrl` field, it's external. The app creates a generic HTTP adapter. Otherwise, the app looks up a built-in adapter by name.

### App startup flow

1. Read config, find all `[channels.*]` sections.
2. For each built-in channel name, instantiate the adapter with its config.
3. For each external channel (has `sendUrl`), create a generic HTTP adapter.
4. Register webhook routes for webhook adapters.
5. Call `start()` on persistent connection adapters.
6. Build the unified send tool with the adapter registry.

### Config shape

```toml
[channels.telegram]
botToken = '...'

[channels.email]
webhookSecret = '...'
smtpHost = '...'
smtpPort = 587
smtpUser = '...'
smtpPassword = '...'
fromAddress = '...'

[channels.whatsapp]
# presence enables it, no secrets

[channels.signal]
sendUrl = 'http://signal-bridge:8081/send'
account = '+1234567890'

[owner.identities]
telegram = '12345'
signal = '+1234567890'
email = 'user@example.com'
whatsapp = '+1234567890'
```

## Open questions to resolve

1. Should webhook paths be hardcoded per adapter or configurable in config? Telegram's path matters externally (registered with Telegram API via publicHostname). Leaning hardcoded — no reason for users to configure this.

2. Owner identities restructuring: currently flat fields under `[owner]` (e.g. `owner.signal`, `owner.telegram`). Proposed: `[owner.identities]` sub-table with arbitrary channel names as keys. Straightforward, but needs to be validated against all the places owner identity is used (allowlist seeding, owner bypass in queue routing, isOwnerIdentity checks).

## Non-goals

- No dynamic channel loading or plugin-like adapter system. Built-in adapters are compiled into the app.
- No channel override mechanism yet (external replacing built-in). Architecture supports it but YAGNI.
- No changes to the allowlist matching semantics yet (glob unification is a separate task).
- No implementation. This ticket is about finalizing the interface contract only.

## Acceptance Criteria

Interface contract is defined as TypeScript types, open questions are resolved, and the design is recorded in the ticket notes. No code changes.


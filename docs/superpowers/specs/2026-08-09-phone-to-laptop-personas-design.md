# VoiceBridge: phone → laptop persona requests

**Date:** 2026-08-09
**Status:** approved, implementing

## Problem

VoiceBridge currently runs one direction: VoiceOS on the laptop drives the phone
(`find_my_phone`, `get_phone_location`, `send_to_phone`, `get_phone_status`). We want the
reverse — speak into the phone while away from the desk, and have VoiceOS perform actions
on the laptop.

The obstacle is that MCP is pull-only. An MCP server cannot push work into VoiceOS;
VoiceOS decides when to call a tool. Something must make it look.

## Approach

The phone is a **remote microphone** for VoiceOS. Personas are preset framings that shape
how the request is worded, so VoiceOS routes it to the right laptop tool. No LLM runs on
the phone.

Speech-to-text uses the **iOS keyboard's built-in dictation**. Expo Go cannot run any
on-device STT module, and cloud STT would add an API key, audio upload, and more failure
modes. Apple's mic key on the system keyboard transcribes for free, on-device, with zero
new dependencies.

VoiceOS learns about requests via a **long-poll tool**. The user says "listen to my phone"
once; VoiceOS calls `wait_for_phone_request`, which blocks until a request arrives, and its
agent loop calls again after acting.

## Data flow

1. Phone: pick persona chip → dictate into `TextInput` → send.
2. App writes to the `requests` table with the persona prefix already applied.
3. VoiceOS calls `wait_for_phone_request`; it long-polls Convex, claims the row, returns the
   framed text.
4. VoiceOS acts using its own laptop tools (`voiceos_claude_code`, `voiceos_applemail`, …).
5. Optional reply: VoiceOS calls the existing `send_to_phone` tool. No new return path.

## Schema

A **new `requests` table**, not a reuse of `commands`. `commands` means laptop→phone with
`pending`/`done`/`result` semantics; overloading it would make both directions harder to
read and would muddy the dashboard audit log used in the demo.

```ts
requests: defineTable({
  persona: v.string(),
  text: v.string(),                    // raw transcript
  framed: v.string(),                  // persona prefix + transcript
  status: v.string(),                  // "queued" | "delivered"
  createdAt: v.number(),
  deliveredAt: v.optional(v.number()),
}).index("by_status", ["status"])
```

## Personas

Pure data — name, emoji, prefix. Adding one is a two-line edit.

| Persona | Prefix |
|---|---|
| 💻 Coding Agent | "Using the coding agent on my laptop: " |
| ✉️ Email / Messages | "In my email or messages on my laptop: " |
| 🔎 Research | "Research this and reply to my phone: " |
| 📅 Calendar / Reminders | "On my laptop's calendar and reminders: " |

The prefix map lives in `App.tsx`, which owns the UI. The app stores both `persona` and the
computed `framed` string, so the MCP server stays dumb and there is no shared module across
the two npm projects.

## MCP tool

```
wait_for_phone_request  (no arguments)
  poll requests:nextQueued every 500ms, up to 25s
  hit     → markDelivered, return "[persona] framed text"
  timeout → return normal text: "No requests from your phone."
```

Timeout returns **text, not an error**. An error result risks halting VoiceOS's agent loop,
and that loop re-calling the tool is the entire mechanism. 25s rather than 55s because
supergateway and streamable HTTP impose their own unmeasured request timeouts; tune upward
once it works.

## Error handling

- **Double delivery.** `markDelivered` re-reads the row inside the mutation and returns null
  if it is no longer `queued`, so only one caller wins a race.
- **Long-poll timeout.** Returns friendly text so the agent can call again.
- **Phone offline.** Irrelevant in this direction — requests queue in Convex and wait.

## Testing

Same ladder that verified the existing direction:

1. Convex round trip via `npx convex run requests:enqueue` / `requests:nextQueued`.
2. MCP tool via `curl -X POST http://localhost:8787/mcp` with `tools/call`.
3. End to end: dictate on the phone, watch the gateway log and `npx convex logs`.

## Files touched

All additive. Nothing existing is refactored.

- `mobile/convex/schema.ts` — add `requests` table
- `mobile/convex/requests.ts` — new
- `mobile/App.tsx` — add persona sender; `CommandRunner` untouched
- `mcp-server/server.ts` — add one tool alongside the existing four

## Known risks

- **The agent loop is unverified.** Whether VoiceOS re-calls `wait_for_phone_request` after
  acting cannot be checked without building it. If it calls only once, the user re-triggers
  by saying "listen to my phone" again. A `get_pending_phone_requests` drain tool is the
  fallback, added only if needed.
- **"Confirm custom actions"** is enabled on the VoiceOS integration and may prompt before
  each tool call, which would break a hands-free loop. Turn it off when testing.

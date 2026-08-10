# VoiceBridge

A voice assistant on your laptop can't touch your phone. A phone in your pocket can't
drive your laptop. VoiceBridge makes them one system, in both directions.

Say "where's my phone?" at your desk and the phone across the room starts shouting. Tap
the orb on your phone from another floor and your laptop researches the answer, then
speaks it back to you.

---

## The problem

Voice assistants are trapped on the device that runs them. VoiceOS is a capable desktop
agent — it can drive Claude Code, Apple Mail, Calendar, Messages — but its reach stops at
the machine it's installed on. Meanwhile the device you actually carry is the one with
GPS, a battery, a speaker, and a vibration motor, and it has no idea what your laptop
agent is doing.

The gap isn't intelligence, it's **reach**. VoiceBridge closes it with three parts:

- **VoiceOS** turns speech into intent and decides which tool to call.
- **An MCP server** exposes phone capabilities as tools VoiceOS can invoke.
- **Convex** is the real-time bus that carries commands between laptop and phone, in
  both directions, over the internet — no same-network requirement, no push
  infrastructure, no polling loop to write.

---

## What it does

**Laptop → phone.** You speak to VoiceOS; your phone acts.

| Tool | Say | The phone does |
|---|---|---|
| `find_my_phone` | "Where's my phone?" | Max brightness, vibrates, shouts "I'm over here!" |
| `get_phone_location` | "Where did I leave my phone?" | GPS + reverse geocode, speaks the address |
| `send_to_phone` | "Send 'meet at table 3' to my phone" | Note appears on screen with haptic |
| `get_phone_status` | "How's my phone's battery?" | Battery % and charging state |

**Phone → laptop.** You speak to your phone; your laptop acts.

| Tool | How it's used |
|---|---|
| `wait_for_phone_request` | VoiceOS long-polls this for up to 4 minutes. When you speak into the app, it returns your transcript and VoiceOS carries it out on the laptop — then replies to your phone with `send_to_phone`. |

---

## Architecture

```
  ┌─ laptop ──────────────────────────┐        ┌─ Convex ───────────┐       ┌─ phone ─────────┐
  │  VoiceOS (agent mode)             │        │                    │       │                 │
  │        │ MCP over HTTP            │        │  commands  table   │       │  Expo app       │
  │        ▼                          │◄──────►│  requests  table   │◄─────►│  (Expo Go)      │
  │  supergateway  ──stdio──►  server │        │  file storage      │       │                 │
  │                            .ts    │        │  actions           │       │                 │
  └───────────────────────────────────┘        └────────────────────┘       └─────────────────┘
        tools/call                              reactive subscription          executes + replies
```

Neither side talks to the other directly. Every exchange is a row in Convex, which means
the two devices only need internet — not the same network — and every command is durable
and inspectable after the fact.

**Laptop → phone:** VoiceOS calls a tool → the server inserts a `commands` row → the phone
is subscribed via `useQuery` and executes within a second → it writes the result back →
the server, which has been polling, returns that result to VoiceOS.

**Phone → laptop:** you tap the orb and speak → audio uploads to Convex storage → a Convex
action transcribes it and inserts a `requests` row → VoiceOS's long-poll on
`wait_for_phone_request` claims it and acts.

---

## Why Convex

Convex is doing four distinct jobs here, and picking it collapsed what would otherwise be
a lot of infrastructure:

**Reactive queries replace push notifications.** The phone subscribes to
`commands.pending` with `useQuery`. When the laptop inserts a row, the phone re-renders
and executes — no APNs certificates, no socket server, no polling loop in the app. This
is the single biggest reason the project fits in a hackathon.

**Mutations and queries are the command bus.** `commands:create`, `commands:complete`,
`requests:enqueue`, `requests:markDelivered` — the whole protocol between two devices is
five functions and two tables. `markDelivered` re-reads inside the mutation and returns
null if the row was already claimed, so two concurrent pollers can't deliver the same
request twice.

**File storage handles the audio.** The app uploads recordings straight to Convex storage
with a one-time URL. No S3 bucket, no signed-upload service.

**Actions keep secrets off the phone.** Transcription runs in a Convex action, so the
OpenAI key lives in the deployment environment and never ships in the app bundle. The
phone sends a storage ID and gets back text.

And the audit trail is free: every voice command either device has ever issued is a row
you can browse in the dashboard, with timestamps and results.

---

## The mobile app

An Expo app (SDK 54) that runs in **Expo Go** — no custom build required.

It plays two roles at once. As an **executor**, it subscribes to `commands` and carries
out whatever VoiceOS asks: brightness, vibration, speech, GPS, battery. As a **remote
mic**, it records what you say, has it transcribed, and queues it for the laptop.

**Personas** shape how your words reach VoiceOS. Each is a label and a prefix prepended to
your transcript, which is what steers VoiceOS toward the right laptop tool:

| Persona | Prefix | Routes toward |
|---|---|---|
| 💻 Coding Agent | "Using the coding agent on my laptop: " | Claude Code, Codex |
| ✉️ Email / Messages | "In my email or messages on my laptop: " | Apple Mail, Messages |
| 🔎 Research | "Research this and reply to my phone: " | Web search, ChatGPT |
| 📅 Calendar / Reminders | "On my laptop's calendar and reminders: " | Calendar, Reminders |

Adding one is a two-line edit to the `PERSONAS` array in `App.tsx`.

**Voice capture** uses the iOS mic through `expo-audio` — tap the orb to start, tap again
to send. Expo Go has no on-device speech recognition, so transcription happens server-side
in Convex via OpenAI. Replies are spoken back on the phone with `expo-speech`.

---

## Connecting to VoiceOS

VoiceOS's custom integrations take an **MCP server URL and speak Streamable HTTP** — not a
stdio launch command. `server.ts` is a stdio MCP server, so
[supergateway](https://github.com/supercorp-ai/supergateway) bridges the two: it spawns
`server.ts` over stdio and exposes it over HTTP.

```bash
cd mcp-server
./start-gateway.sh
```

Then in VoiceOS: **Apps → Custom → Create**, and paste:

```
http://localhost:8787/mcp
```

It should report **5 tools discovered**. The script wraps supergateway in a restart loop —
if it dies, every phone tool goes offline and VoiceOS reports only that the tool is
unavailable, which is a confusing symptom to debug live.

> VoiceOS caches its tool list per session. After changing a tool, toggle the integration
> Off/On **and** start a new conversation, or the agent keeps using the stale list.

---

## Setup

**1. Convex**

```bash
cd mobile
npm install
npx convex dev          # sign in, creates a cloud deployment
```

Put the deployment URL it prints into `CONVEX_URL` at the top of `App.tsx`.

**2. OpenAI key** (only needed for voice input; typing works without it)

```bash
npx convex env set OPENAI_API_KEY sk-...
```

Server-side only — it is never bundled into the app.

**3. The phone**

```bash
npx expo start --tunnel
```

Scan the QR with the Camera app. `--tunnel` matters on any network with client isolation,
where the phone can't reach Metro over the LAN.

**4. The gateway**

```bash
cd ../mcp-server && npm install && ./start-gateway.sh
```

---

## Verifying it works

Every layer can be tested on its own, which is worth doing in order when something breaks:

```bash
# Convex round trip, no phone needed
npx convex run commands:create '{"action":"find_my_phone"}'

# The MCP server, no VoiceOS needed
curl -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# What's queued from the phone right now
npx convex run requests:recent
```

Logs, by layer:

| Question | Where to look |
|---|---|
| Did VoiceOS call the tool? | gateway terminal — `PHONE->LAPTOP VoiceOS started listening` |
| Did the phone send? | `npx convex logs` — `requests:enqueue` |
| Did a command reach the phone? | gateway terminal — `LAPTOP->PHONE … done in Nms` |
| What did the phone record? | `npx convex run audio:recentUploads` — size tells you if capture worked |

---

## Repo layout

```
mcp-server/
  server.ts           5 MCP tools; stdio; traces to stderr
  start-gateway.sh    supergateway wrapper with a restart loop
mobile/
  App.tsx             executor + voice UI + personas
  convex/
    schema.ts         commands (laptop→phone), requests (phone→laptop)
    commands.ts       create / pending / complete / get / history
    requests.ts       enqueue / nextQueued / markDelivered / recent
    audio.ts          upload URL + transcription action
docs/superpowers/specs/
                      design doc for the phone→laptop direction
```

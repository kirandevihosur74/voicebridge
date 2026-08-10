# VoiceBridge — give VoiceOS hands on your phone

Speak at your desktop, your phone acts. VoiceOS handles voice→intent, this MCP
server exposes phone capabilities as tools, and Convex is the real-time bridge.

```
VoiceOS (agent mode)
  → voicebridge MCP server (stdio, launched by VoiceOS)
    → Convex `commands` table (reactive sync)
      → Expo app on the phone executes → writes result back
  → VoiceOS speaks the answer
```

## Setup order (do it in this order, ~45 min total)

### 1. Convex + Expo app
```bash
npx create-expo-app mobile && cd mobile
npm install convex
npx expo install expo-location expo-battery expo-haptics expo-speech expo-brightness
npx convex dev        # sign in, creates a dev deployment, keeps schema synced
```
- Copy `convex/schema.ts` and `convex/commands.ts` from this repo into `mobile/convex/`.
- Replace `mobile/App.tsx` with the one in this repo.
- Put your deployment URL (shown by `npx convex dev`, like `https://xxx.convex.cloud`)
  into `CONVEX_URL` in `App.tsx`.
- `npx expo start`, open in Expo Go on your real phone. Accept location permission
  when first asked.

**Checkpoint:** in the Convex dashboard, manually insert a row into `commands`:
`{ action: "find_my_phone", status: "pending", createdAt: 0 }`.
Your phone should shout. If yes, the hard half is done.

### 2. MCP server
```bash
cd mcp-server
npm install
CONVEX_URL=https://xxx.convex.cloud npx tsx server.ts   # should start silently
```
Test without VoiceOS using the inspector:
```bash
npx @modelcontextprotocol/inspector -e CONVEX_URL=https://xxx.convex.cloud npx tsx server.ts
```
Call `find_my_phone` from the inspector UI — phone shouts again. 

### 3. Connect to VoiceOS
VoiceOS → **Settings → Integrations → Custom Integrations → Add**
- Name: `VoiceBridge`
- Launch command (absolute path, env inline):
```
env CONVEX_URL=https://xxx.convex.cloud npx tsx /Users/you/voicebridge/mcp-server/server.ts
```
Then say: **"Find my phone."**

## Tools
| Tool | Say | Phone does |
|---|---|---|
| `find_my_phone` | "Where's my phone?" | Max brightness, vibrates, shouts "I'm over here!" |
| `get_phone_location` | "Where did I leave my phone?" | GPS + reverse geocode, speaks the address |
| `send_to_phone` | "Send this address to my phone" | Note appears on phone screen with haptic |
| `get_phone_status` | "How's my phone's battery?" | Battery % and charging state |

## Demo script (90s)
1. Phone hidden with a teammate across the room, laptop on stage.
2. "Every AI assistant can talk. Ours reaches every device you own."
3. "Where's my phone?" → phone starts shouting from across the room. (The moment.)
4. "What's its battery?" → spoken answer.
5. "Send 'meet at demo table 3' to my phone" → teammate holds up the screen.
6. Show the Convex dashboard: full audit log of every voice command. "Real-time
   sync and the audit trail come from Convex; voice comes from VoiceOS. We built
   the bridge."

## Gotchas
- Expo Go must be foregrounded on the phone during the demo (keep it open; that's fine).
- `expo-brightness` permission prompt appears once — trigger it before the demo.
- iOS silent switch mutes `expo-speech` on some devices — flip ringer on.
- Rehearse on venue wifi; if flaky, hotspot from a teammate's phone (Convex only
  needs internet, not same network).
- Have the inspector fallback ready: if VoiceOS agent mode misfires live, drive
  the same tools from the inspector and narrate — the phone still obeys.

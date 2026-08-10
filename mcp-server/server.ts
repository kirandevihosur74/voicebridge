/**
 * VoiceBridge MCP Server
 * Gives VoiceOS hands on your phone. Each tool writes a command document to
 * Convex; the Expo app (subscribed reactively) executes it on the device and
 * writes the result back. This server polls Convex for the result and returns
 * it to VoiceOS, which speaks it.
 *
 * Run: CONVEX_URL=https://<your-deployment>.convex.cloud npx tsx server.ts
 * VoiceOS: Settings -> Integrations -> Custom Integrations -> Add
 *   launch command: npx tsx /absolute/path/to/server.ts
 *   (set CONVEX_URL in the command, e.g. via `env CONVEX_URL=... npx tsx ...`)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error("Missing CONVEX_URL env var (https://<deployment>.convex.cloud)");
  process.exit(1);
}
const convex = new ConvexHttpClient(CONVEX_URL);

/**
 * How long one wait_for_phone_request call blocks. Longer means fewer manual
 * "listen to my phone" triggers, but the client and HTTP transport each impose
 * their own request timeouts.
 */
const LISTEN_WINDOW_MS = Number(process.env.LISTEN_WINDOW_MS ?? 240000);

/** Trace to stderr. stdout carries JSON-RPC and must stay clean. */
const log = (msg: string) =>
  console.error(`[voicebridge ${new Date().toLocaleTimeString()}] ${msg}`);

/** Enqueue a command for the phone and wait for its result. */
async function dispatch(
  action: string,
  payload?: Record<string, unknown>,
  timeoutMs = 15000
): Promise<string> {
  const id = await convex.mutation("commands:create" as any, {
    action,
    payload: payload ? JSON.stringify(payload) : undefined,
  });
  log(`LAPTOP->PHONE  ${action} queued id=${id}`);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc: any = await convex.query("commands:get" as any, { id });
    if (doc?.status === "done") {
      log(`LAPTOP->PHONE  ${action} done in ${Date.now() - start}ms: ${doc.result}`);
      return doc.result ?? "Done.";
    }
    if (doc?.status === "error") {
      log(`LAPTOP->PHONE  ${action} FAILED on phone: ${doc.result}`);
      throw new Error(doc.result ?? "The phone reported an error.");
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  log(`LAPTOP->PHONE  ${action} TIMEOUT after ${timeoutMs}ms (phone offline?)`);
  throw new Error(
    "The phone didn't respond in time. Make sure the VoiceBridge app is open and online."
  );
}

const server = new McpServer({ name: "voicebridge", version: "1.0.0" });

server.tool(
  "find_my_phone",
  "Make the user's phone loudly announce itself, vibrate, and flash its screen so it can be found. Use when the user asks where their phone is or wants to find/ring it.",
  {},
  async () => ({
    content: [{ type: "text", text: await dispatch("find_my_phone") }],
  })
);

server.tool(
  "get_phone_location",
  "Get the phone's current GPS location as a human-readable description with coordinates. Use when the user asks where their phone is located or where they left it.",
  {},
  async () => ({
    content: [{ type: "text", text: await dispatch("get_location", undefined, 20000) }],
  })
);

server.tool(
  "send_to_phone",
  "Send a short note, link, or reminder from the desktop to the user's phone. It appears on the phone screen with a vibration. Use for handoffs like 'send this to my phone'.",
  { message: z.string().describe("The text or link to display on the phone") },
  async ({ message }) => ({
    content: [{ type: "text", text: await dispatch("send_note", { message }) }],
  })
);

server.tool(
  "get_phone_status",
  "Get the phone's battery level and charging state. Use when the user asks about their phone's battery or status.",
  {},
  async () => ({
    content: [{ type: "text", text: await dispatch("get_status") }],
  })
);

server.tool(
  "wait_for_phone_request",
  "Listen for a spoken request the user sends from their phone, and return it so you can carry it out on this laptop. Blocks for up to 25 seconds. Call this again after handling each request to keep listening. Use when the user asks you to listen to / watch their phone for requests.",
  {},
  async () => {
    const start = Date.now();
    log(`PHONE->LAPTOP  VoiceOS started listening (${LISTEN_WINDOW_MS / 1000}s window)`);
    while (Date.now() - start < LISTEN_WINDOW_MS) {
      const doc: any = await convex.query("requests:nextQueued" as any, {});
      if (doc) {
        log(`PHONE->LAPTOP  found queued id=${doc._id} [${doc.persona}] "${doc.text}"`);
        // markDelivered returns null if another caller already claimed it
        const claimed: any = await convex.mutation("requests:markDelivered" as any, {
          id: doc._id,
        });
        if (claimed) {
          log(`PHONE->LAPTOP  claimed after ${Date.now() - start}ms, handing to VoiceOS`);
          return {
            content: [
              {
                type: "text" as const,
                // The trailing nudge is what keeps the loop going: VoiceOS otherwise
                // handles one request and stops listening.
                text:
                  `[${claimed.persona}] ${claimed.framed}\n\n` +
                  `---\nWhen you have finished, ALWAYS call send_to_phone with the answer ` +
                  `or a short confirmation, so the user sees it on their phone — they are ` +
                  `not at the laptop. Then call wait_for_phone_request again to keep listening.`,
              },
            ],
          };
        }
        log(`PHONE->LAPTOP  id=${doc._id} already claimed by another call, skipping`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    log("PHONE->LAPTOP  window closed, nothing queued");
    // Deliberately not an error: an error result can halt the agent loop, and the
    // loop calling this tool again is the whole mechanism.
    return {
      content: [
        {
          type: "text" as const,
          text:
            "No requests from your phone yet. Call wait_for_phone_request again to keep listening.",
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

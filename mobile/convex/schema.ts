import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  commands: defineTable({
    action: v.string(), // "find_my_phone" | "get_location" | "send_note" | "get_status"
    payload: v.optional(v.string()), // JSON string of extra args
    status: v.string(), // "pending" | "done" | "error"
    result: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  // Phone -> laptop. The phone enqueues a spoken request; the MCP server long-polls
  // for it and hands it to VoiceOS, which acts on the laptop.
  requests: defineTable({
    persona: v.string(), // "Coding Agent" | "Email / Messages" | "Research" | "Calendar / Reminders"
    text: v.string(), // raw transcript
    framed: v.string(), // persona prefix + transcript
    status: v.string(), // "queued" | "delivered"
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
  }).index("by_status", ["status"]),
});

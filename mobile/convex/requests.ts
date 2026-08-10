import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Phone calls this after you dictate into a persona
export const enqueue = mutation({
  args: { persona: v.string(), text: v.string(), framed: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("requests", {
      persona: args.persona,
      text: args.text,
      framed: args.framed,
      status: "queued",
      createdAt: Date.now(),
    });
  },
});

// MCP server long-polls this, oldest first
export const nextQueued = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("requests")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .first();
  },
});

// Claims a request. Returns null if another caller already took it, so a race
// can never deliver the same request to VoiceOS twice.
export const markDelivered = mutation({
  args: { id: v.id("requests") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc || doc.status !== "queued") return null;
    await ctx.db.patch(args.id, { status: "delivered", deliveredAt: Date.now() });
    return { ...doc, status: "delivered" };
  },
});

// Phone shows its own send history
export const recent = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("requests").order("desc").take(20);
  },
});

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// MCP server calls this to enqueue a command for the phone
export const create = mutation({
  args: { action: v.string(), payload: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ctx.db.insert("commands", {
      action: args.action,
      payload: args.payload,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

// Phone subscribes to this — reactivity means new commands arrive instantly
export const pending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("commands")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
  },
});

// Phone calls this after executing a command
export const complete = mutation({
  args: {
    id: v.id("commands"),
    result: v.string(),
    status: v.optional(v.string()), // "done" (default) or "error"
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: args.status ?? "done",
      result: args.result,
    });
  },
});

// MCP server polls this to pick up the result
export const get = query({
  args: { id: v.id("commands") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Bonus for the demo: full audit log of everything the voice agent did
export const history = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("commands").order("desc").take(50);
  },
});

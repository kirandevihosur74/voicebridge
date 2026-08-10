import { action, mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

// Phone asks for a one-time upload URL, then POSTs the recording straight to storage.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Transcribes an uploaded recording and queues it as a request for the laptop.
 * The OpenAI key lives in the Convex deployment env, never in the app bundle.
 */
export const transcribeAndEnqueue = action({
  args: {
    storageId: v.id("_storage"),
    persona: v.string(),
    prefix: v.string(),
  },
  handler: async (ctx, args): Promise<{ text: string }> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set on the Convex deployment.");

    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("That recording is no longer in storage.");

    const form = new FormData();
    form.append("file", blob, "speech.m4a");
    form.append("model", "gpt-4o-mini-transcribe");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text();
      if (detail.includes("no credits") || detail.includes("insufficient_quota"))
        throw new Error("OpenAI has no credits left. Add billing, or type instead.");
      if (res.status === 401) throw new Error("OpenAI rejected the key. Re-run: npx convex env set OPENAI_API_KEY");
      throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 120)}`);
    }

    const json: any = await res.json();
    const text = String(json.text ?? "").trim();
    if (!text) throw new Error("Nothing was picked up. Hold the orb and speak again.");

    await ctx.runMutation(api.requests.enqueue, {
      persona: args.persona,
      text,
      framed: args.prefix + text,
    });

    // The transcript is what matters from here; drop the audio.
    await ctx.storage.delete(args.storageId);
    return { text };
  },
});

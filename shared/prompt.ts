import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const promptSectionSchema = z.object({
  /** Provider-assigned part name (pi section name, devin message role, ...). */
  name: z.string(),
  text: z.string(),
});

const contextMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  at: z.string().optional(),
});

export const providerPromptSchema = z.object({
  /** Time of the newest provider record that shaped this snapshot. */
  capturedAt: z.string().optional(),
  model: z.string().optional(),
  /** Named prompt parts in the order the provider applies them. */
  sections: z.array(promptSectionSchema),
  /** Tool names associated with this snapshot (declared for pi; observed calls when declarations are unavailable). */
  tools: z.array(z.string()).optional(),
  /** Whether `tools` are declared tool definitions or only tools observed in messages. */
  toolsKind: z.enum(["declared", "observed"]).optional(),
  /** True when the provider only keeps its latest request and ignores historical `at` timestamps. */
  latestOnly: z.boolean().optional(),
  /** Full context message list; present only when requested. */
  messages: z.array(contextMessageSchema).optional(),
  /** Total records on the provider's active context chain. */
  messageCount: z.number().optional(),
  source: z
    .object({
      kind: z.enum(["pi-session", "devin-db", "antigravity-db"]),
      path: z.string().optional(),
    })
    .optional(),
});

export const getAgentPrompt = defineRpc({
  name: "turnline.prompt.get",
  input: z.object({
    agentId: z.string(),
    /**
     * ISO timestamp. When set, the provider's records are replayed only up to
     * this point, yielding the prompt that was effective then. Omit for latest.
     */
    at: z.string().optional(),
    /** Include the full context message list (can be large). */
    includeMessages: z.boolean().optional(),
  }),
  output: z.object({
    provider: z.string(),
    status: z.enum(["ok", "unsupported", "unavailable"]),
    reason: z.string().optional(),
    prompt: providerPromptSchema.optional(),
  }),
});

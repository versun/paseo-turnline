import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const itemUsageSchema = z.object({
  /** Total input tokens (uncached + cache read + cache write). */
  inputTokens: z.number().nonnegative(),
  /** Input tokens served from prompt cache. */
  cachedInputTokens: z.number().nonnegative().optional(),
  /** Input tokens written into prompt cache, when reported separately. */
  cacheWriteTokens: z.number().nonnegative().optional(),
  /** Output tokens generated. */
  outputTokens: z.number().nonnegative(),
  /** Total cost in USD when reported by the provider. */
  costUsd: z.number().nonnegative().optional(),
});

const usageRecordSchema = z.object({
  /** ISO timestamp of the LLM response/step. */
  at: z.string().optional(),
  /** Provider message identifier (Pi id/responseId, Devin message_id, Antigravity bot-... id, Claude message.id, Codex item id). */
  messageId: z.string().optional(),
  /** Tool call IDs emitted by this LLM call. */
  callIds: z.array(z.string()).optional(),
  /** Normalized leading snippet of assistant reply text, used for matching. */
  textPrefix: z.string().optional(),
  /** Normalized leading snippet of reasoning/thinking text, used for matching. */
  thinkingPrefix: z.string().optional(),
  /** Token usage for this LLM call. */
  usage: itemUsageSchema,
});

export type ItemUsage = z.infer<typeof itemUsageSchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const getAgentUsage = defineRpc({
  name: "turnline.usage.get",
  input: z.object({
    agentId: z.string(),
  }),
  output: z.object({
    provider: z.string(),
    status: z.enum(["ok", "unsupported", "unavailable"]),
    reason: z.string().optional(),
    records: z.array(usageRecordSchema).optional(),
  }),
});

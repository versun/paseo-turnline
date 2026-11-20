import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { PluginPaseoApi } from "@getpaseo/plugin/client";
import {
  groupTurns,
  itemIdentity,
  mergeUsage,
  type FeedEntry,
  type Turn,
  type TurnMeta,
} from "./turn-model";

type TimelinePage = Awaited<
  ReturnType<ReturnType<PluginPaseoApi["agents"]["ref"]>["timeline"]["refetch"]>
>;

const PAGE_SIZE = 150;

interface StoredFeedEntry extends FeedEntry {
  /** Set when a live update patched this canonical entry in place. */
  liveRawSeq?: number;
  liveArrivalSeq?: number;
}

interface LiveFeedEntry extends FeedEntry {
  arrivalSeq: number;
  rawSeq?: number;
}

interface AgentFeed {
  /** Canonical history entries keyed by seqStart. */
  entries: Map<number, StoredFeedEntry>;
  /** Live items in arrival order; appended after all canonical entries at emit. */
  liveItems: LiveFeedEntry[];
  /** Monotonic arrival counter for live items on this feed. */
  liveSeq: number;
  /** Incremented whenever a full reset clears history; invalidates stale loadOlder calls. */
  resetEpoch: number;
  /** Monotonic counter for tail refetch requests; drops out-of-order responses. */
  tailRequestSeq: number;
  /** Carries a pending reset across superseded or failed tail refetches until one succeeds. */
  pendingReset: boolean;
  /** Carries a pending turnMeta reset across replacement refetches until one succeeds. */
  pendingClearMeta: boolean;
  /** Largest canonical seqEnd applied; live items are ordered after it. */
  maxSeq: number;
  hasOlder: boolean;
  startCursor: { epoch: string; seq: number } | null;
  loading: boolean;
  loadingOlder: boolean;
  turnMeta: Map<string, TurnMeta>;
  agentRunning: boolean;
  error?: string;
  unsubscribe?: () => void;
}

export interface AgentFeedView {
  agentId: string;
  turns: Turn[];
  hasOlder: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error?: string;
}

function emptyFeed(running: boolean): AgentFeed {
  return {
    entries: new Map(),
    liveItems: [],
    liveSeq: 0,
    resetEpoch: 0,
    tailRequestSeq: 0,
    pendingReset: false,
    pendingClearMeta: false,
    maxSeq: 0,
    hasOlder: false,
    startCursor: null,
    loading: true,
    loadingOlder: false,
    turnMeta: new Map(),
    agentRunning: running,
  };
}

export class TurnFeedStore {
  private feeds = new Map<string, AgentFeed>();
  private listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, AgentFeedView> = new Map();
  private generation = 0;

  constructor(private paseo: PluginPaseoApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReadonlyMap<string, AgentFeedView> => this.snapshot;

  dispose() {
    this.generation += 1;
    for (const feed of this.feeds.values()) feed.unsubscribe?.();
    this.feeds.clear();
    this.snapshot = new Map();
  }

  /** Attach feeds for the given agents; detach feeds that disappeared. */
  setAgents(agents: { id: string; running: boolean }[]) {
    const wanted = new Set(agents.map((a) => a.id));
    let changed = false;

    for (const [id, feed] of this.feeds) {
      if (!wanted.has(id)) {
        feed.unsubscribe?.();
        this.feeds.delete(id);
        changed = true;
      }
    }

    const gen = this.generation;
    for (const { id, running } of agents) {
      let feed = this.feeds.get(id);
      if (!feed) {
        feed = emptyFeed(running);
        this.feeds.set(id, feed);
        changed = true;
        void this.attach(id, feed, gen);
      } else if (feed.agentRunning !== running) {
        feed.agentRunning = running;
        changed = true;
      }
    }

    if (changed) this.emit();
  }

  async loadOlder(agentId: string) {
    const feed = this.feeds.get(agentId);
    if (!feed || !feed.hasOlder || feed.loadingOlder || !feed.startCursor) return;
    const gen = this.generation;
    const epoch = feed.resetEpoch;
    const cursor = feed.startCursor;
    feed.loadingOlder = true;
    this.emit();
    try {
      const page = await this.paseo.agents.ref(agentId).timeline.refetch({
        direction: "before",
        cursor,
        limit: PAGE_SIZE,
        projection: "canonical",
      });
      if (gen !== this.generation || this.feeds.get(agentId) !== feed || feed.resetEpoch !== epoch) {
        return;
      }
      if (page.error) {
        feed.error = page.error;
      } else {
        feed.error = undefined;
        this.applyPage(feed, page, { isTail: false, reset: false, cutoff: 0 });
      }
    } catch (error) {
      if (gen !== this.generation || this.feeds.get(agentId) !== feed || feed.resetEpoch !== epoch) {
        return;
      }
      feed.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (gen === this.generation && this.feeds.get(agentId) === feed && feed.resetEpoch === epoch) {
        feed.loadingOlder = false;
        this.emit();
      }
    }
  }

  private async attach(agentId: string, feed: AgentFeed, gen: number) {
    const sub = this.paseo.agents.ref(agentId).timeline.subscribe((update) => {
      if (gen !== this.generation || this.feeds.get(agentId) !== feed) return;
      const event = update.event;
      switch (event.type) {
        case "timeline": {
          const timestamp =
            ("timestamp" in update && update.timestamp) || new Date().toISOString();
          const rawSeq =
            "seq" in update && typeof update.seq === "number" ? update.seq : undefined;
          this.upsertLiveItem(feed, {
            seq: 0,
            arrivalSeq: ++feed.liveSeq,
            rawSeq,
            timestamp,
            turnId: event.turnId,
            item: event.item,
          });
          break;
        }
        case "turn_started": {
          if (event.turnId) {
            const prev = feed.turnMeta.get(event.turnId) ?? {};
            feed.turnMeta.set(event.turnId, { ...prev, status: "running", error: undefined });
          }
          feed.agentRunning = true;
          break;
        }
        case "turn_completed": {
          if (event.turnId) {
            const prev = feed.turnMeta.get(event.turnId) ?? {};
            feed.turnMeta.set(event.turnId, {
              ...prev,
              status: "completed",
              error: undefined,
              usage: event.usage ? mergeUsage(prev.usage, event.usage) : prev.usage,
            });
          }
          feed.agentRunning = false;
          void this.refetchTail(agentId, feed, { reset: false }, gen);
          break;
        }
        case "turn_failed": {
          if (event.turnId) {
            const prev = feed.turnMeta.get(event.turnId) ?? {};
            feed.turnMeta.set(event.turnId, {
              ...prev,
              status: "failed",
              error: event.error,
            });
          }
          feed.agentRunning = false;
          void this.refetchTail(agentId, feed, { reset: false }, gen);
          break;
        }
        case "turn_canceled": {
          if (event.turnId) {
            const prev = feed.turnMeta.get(event.turnId) ?? {};
            feed.turnMeta.set(event.turnId, {
              ...prev,
              status: "canceled",
              error: event.reason,
            });
          }
          feed.agentRunning = false;
          void this.refetchTail(agentId, feed, { reset: false }, gen);
          break;
        }
        case "replacement":
          void this.refetchTail(agentId, feed, { reset: true, clearMeta: true }, gen);
          return;
        case "subscription_restored":
          void this.refetchTail(agentId, feed, { reset: true }, gen);
          return;
        case "error":
          feed.error = event.error;
          break;
        default:
          return;
      }
      this.emit();
    });
    feed.unsubscribe = () => sub();

    try {
      await sub.ready;
    } catch {
      // Establishment failed; the error event path already surfaced it.
    }
    if (gen !== this.generation || this.feeds.get(agentId) !== feed) return;
    await this.refetchTail(agentId, feed, { reset: false }, gen);
  }

  private upsertLiveItem(feed: AgentFeed, next: LiveFeedEntry) {
    const id = itemIdentity(next.item);
    if (id !== null) {
      const liveIdx = feed.liveItems.findIndex((existing) => itemIdentity(existing.item) === id);
      if (liveIdx >= 0) {
        const existing = feed.liveItems[liveIdx];
        feed.liveItems[liveIdx] = {
          ...next,
          timestamp: existing.timestamp,
          turnId: next.turnId ?? existing.turnId,
        };
        return;
      }
      for (const [seqStart, existing] of feed.entries) {
        if (itemIdentity(existing.item) === id) {
          feed.entries.set(seqStart, {
            ...existing,
            item: next.item,
            turnId: next.turnId ?? existing.turnId,
            liveRawSeq: next.rawSeq,
            liveArrivalSeq: next.arrivalSeq,
          });
          return;
        }
      }
    }
    feed.liveItems.push(next);
  }

  private async refetchTail(
    agentId: string,
    feed: AgentFeed,
    options: { reset: boolean; clearMeta?: boolean },
    gen: number,
  ) {
    if (options.reset) {
      feed.pendingReset = true;
      feed.resetEpoch += 1;
      if (feed.loadingOlder) {
        feed.loadingOlder = false;
        this.emit();
      }
    }
    if (options.clearMeta) {
      feed.pendingClearMeta = true;
    }
    const reqSeq = ++feed.tailRequestSeq;
    const cutoff = feed.liveSeq;
    try {
      const page = await this.paseo.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: PAGE_SIZE,
        projection: "canonical",
      });
      if (
        gen !== this.generation ||
        this.feeds.get(agentId) !== feed ||
        reqSeq !== feed.tailRequestSeq
      ) {
        return;
      }
      if (page.error) {
        feed.error = page.error;
      } else {
        const epochChanged =
          !feed.pendingReset &&
          feed.startCursor !== null &&
          page.startCursor !== null &&
          page.startCursor.epoch !== feed.startCursor.epoch;
        const reset = feed.pendingReset || epochChanged;
        const clearMeta = feed.pendingClearMeta || epochChanged;
        feed.pendingReset = false;
        feed.pendingClearMeta = false;
        feed.error = undefined;
        if (reset) {
          feed.entries.clear();
          feed.maxSeq = 0;
          feed.startCursor = null;
          feed.hasOlder = false;
          feed.loadingOlder = false;
          feed.resetEpoch += 1;
        }
        if (clearMeta) {
          feed.turnMeta.clear();
        }
        this.applyPage(feed, page, { isTail: true, reset, cutoff });
      }
    } catch (error) {
      if (
        gen !== this.generation ||
        this.feeds.get(agentId) !== feed ||
        reqSeq !== feed.tailRequestSeq
      ) {
        return;
      }
      feed.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (
        gen === this.generation &&
        this.feeds.get(agentId) === feed &&
        reqSeq === feed.tailRequestSeq
      ) {
        feed.loading = false;
        this.emit();
      }
    }
  }

  private applyPage(
    feed: AgentFeed,
    page: TimelinePage,
    options: { isTail: boolean; reset: boolean; cutoff: number },
  ) {
    const { isTail, reset, cutoff } = options;
    const reconcileLive = isTail && feed.liveItems.length > 0;
    const seenSerialized = reconcileLive ? new Set<string>() : undefined;
    const identityToSeqStart = reconcileLive ? new Map<string, number>() : undefined;

    for (const entry of page.entries) {
      feed.maxSeq = Math.max(feed.maxSeq, entry.seqEnd);
      const id = itemIdentity(entry.item);
      if (reconcileLive) {
        if (id !== null) identityToSeqStart!.set(id, entry.seqStart);
        else seenSerialized!.add(JSON.stringify(entry.item));
      }

      let newerLivePatch: StoredFeedEntry | undefined;
      if (!reset && id !== null) {
        const current = feed.entries.get(entry.seqStart);
        if (current && this.isLivePatchNewer(current, id, entry.seqEnd, cutoff)) {
          newerLivePatch = current;
        }
      }

      if (entry.seqEnd > entry.seqStart) {
        for (const [existingSeq, existing] of feed.entries) {
          if (existingSeq > entry.seqStart && existingSeq <= entry.seqEnd) {
            if (!reset && id !== null && this.isLivePatchNewer(existing, id, entry.seqEnd, cutoff)) {
              newerLivePatch = existing;
            }
            feed.entries.delete(existingSeq);
          }
        }
      }

      feed.entries.set(
        entry.seqStart,
        newerLivePatch
          ? {
              seq: entry.seqStart,
              timestamp: entry.timestamp,
              turnId: newerLivePatch.turnId ?? entry.turnId,
              item: newerLivePatch.item,
              liveRawSeq: newerLivePatch.liveRawSeq,
              liveArrivalSeq: newerLivePatch.liveArrivalSeq,
            }
          : {
              seq: entry.seqStart,
              timestamp: entry.timestamp,
              turnId: entry.turnId,
              item: entry.item,
            },
      );
    }

    // A tail page covers live items it now contains canonically; older pages do not.
    if (reconcileLive) {
      feed.liveItems = feed.liveItems.filter((entry) => {
        const id = itemIdentity(entry.item);
        if (id !== null) {
          const canonicalSeq = identityToSeqStart!.get(id);
          if (canonicalSeq !== undefined) {
            const newerThanPage =
              entry.rawSeq !== undefined
                ? entry.rawSeq > feed.maxSeq
                : entry.arrivalSeq > cutoff;
            if (newerThanPage) {
              const canonical = feed.entries.get(canonicalSeq);
              if (canonical) {
                feed.entries.set(canonicalSeq, {
                  ...canonical,
                  item: entry.item,
                  turnId: entry.turnId ?? canonical.turnId,
                  liveRawSeq: entry.rawSeq,
                  liveArrivalSeq: entry.arrivalSeq,
                });
              }
            }
            return false;
          }
        }
        if (entry.rawSeq !== undefined && entry.rawSeq <= feed.maxSeq) return false;
        if (id === null && seenSerialized!.has(JSON.stringify(entry.item))) return false;
        if ((reset || entry.rawSeq === undefined) && entry.arrivalSeq <= cutoff) return false;
        return true;
      });
    }

    const shouldUpdateOlderCursor =
      !isTail ||
      reset ||
      feed.startCursor === null ||
      (page.startCursor !== null &&
        (page.startCursor.epoch !== feed.startCursor.epoch ||
          page.startCursor.seq < feed.startCursor.seq));
    if (shouldUpdateOlderCursor) {
      feed.hasOlder = page.hasOlder;
      feed.startCursor = page.startCursor;
    }
  }

  private isLivePatchNewer(
    existing: StoredFeedEntry,
    id: string,
    canonicalSeqEnd: number,
    cutoff: number,
  ): boolean {
    if (existing.liveArrivalSeq === undefined || itemIdentity(existing.item) !== id) return false;
    return existing.liveRawSeq !== undefined
      ? existing.liveRawSeq > canonicalSeqEnd
      : existing.liveArrivalSeq > cutoff;
  }

  private emit() {
    const next = new Map<string, AgentFeedView>();
    for (const [agentId, feed] of this.feeds) {
      const combined: FeedEntry[] = [];
      for (const entry of feed.entries.values()) {
        combined.push({
          seq: entry.seq,
          timestamp: entry.timestamp,
          turnId: entry.turnId,
          item: entry.item,
        });
      }
      feed.liveItems.forEach((entry, index) => {
        combined.push({
          seq: feed.maxSeq + 1 + index,
          timestamp: entry.timestamp,
          turnId: entry.turnId,
          item: entry.item,
        });
      });
      next.set(agentId, {
        agentId,
        turns: groupTurns(agentId, combined, feed.turnMeta, feed.agentRunning),
        hasOlder: feed.hasOlder,
        loading: feed.loading,
        loadingOlder: feed.loadingOlder,
        error: feed.error,
      });
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Feeds for several agents at once. Returns a stable snapshot map keyed by agentId.
 */
export function useTurnFeeds(paseo: PluginPaseoApi, agents: { id: string; running: boolean }[]) {
  const store = useMemo(() => new TurnFeedStore(paseo), [paseo]);

  useEffect(() => {
    store.setAgents(agents);
  }, [store, agents]);

  useEffect(() => () => store.dispose(), [store]);

  const loadOlder = useCallback((id: string) => store.loadOlder(id), [store]);
  const feeds = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { feeds, loadOlder };
}

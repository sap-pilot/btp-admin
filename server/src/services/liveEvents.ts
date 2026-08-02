import type { Response } from 'express';

interface Subscriber {
  res: Response;
  topics: Set<string>;
}

const subscribers = new Set<Subscriber>();

// One pending payload per topic; first emit within a window wins, duplicates dropped.
const pendingByTopic = new Map<string, Record<string, unknown>>();
let flushTimer: NodeJS.Timeout | null = null;

const DEBOUNCE_MS = 1_000;

function flush(): void {
  flushTimer = null;
  if (pendingByTopic.size === 0 || subscribers.size === 0) return;

  const pending = new Map(pendingByTopic);
  pendingByTopic.clear();

  for (const sub of subscribers) {
    const matched: string[] = [];
    for (const topic of pending.keys()) {
      if (sub.topics.has(topic)) matched.push(topic);
    }
    if (matched.length === 0) continue;

    // If any service-specific topic matched, skip 'global' for this subscriber —
    // both fire on every health check and would otherwise cause a duplicate fetch.
    const specific = matched.filter(t => t !== 'global');
    const toSend = specific.length > 0 ? specific : matched;

    for (const topic of toSend) {
      const payload = `event: update\ndata: ${JSON.stringify(pending.get(topic)!)}\n\n`;
      try {
        sub.res.write(payload);
      } catch {
        subscribers.delete(sub);
        break;
      }
    }
  }
}

export function subscribe(res: Response, topics: string[]): () => void {
  const sub: Subscriber = { res, topics: new Set(topics) };
  subscribers.add(sub);
  return () => { subscribers.delete(sub); };
}

export function emit(topic: string, data: Record<string, unknown>): void {
  if (subscribers.size === 0) return;
  if (pendingByTopic.has(topic)) return; // drop duplicate within window
  pendingByTopic.set(topic, data);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, DEBOUNCE_MS);
    flushTimer.unref();
  }
}

// Send immediately to all matching subscribers, bypassing the debounce.
// Also discards any pending debounced emit for the same topic so the
// immediate payload isn't followed by a stale earlier one.
export function emitImmediate(topic: string, data: Record<string, unknown>): void {
  if (subscribers.size === 0) return;
  pendingByTopic.delete(topic);
  const payload = `event: update\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of [...subscribers]) {
    if (!sub.topics.has(topic)) continue;
    try { sub.res.write(payload); } catch { subscribers.delete(sub); }
  }
}

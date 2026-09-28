import { useEffect, useRef } from 'react';

export type LiveEventData = { service: string; ts: number };

/**
 * Subscribe to server-sent events for live updates.
 * - string  → scope to one service (history page)
 * - null    → subscribe to all events (overview)
 * - false   → disabled (e.g. viewing a closed past date range)
 */
export function useLiveEvents(
  service: string | null | false,
  onUpdate: (data: LiveEventData) => void,
): void {
  const cbRef = useRef(onUpdate);
  cbRef.current = onUpdate;

  useEffect(() => {
    if (service === false) return;
    const url = service !== null
      ? `/api/events?service=${encodeURIComponent(service)}`
      : '/api/events';
    const es = new EventSource(url);
    es.addEventListener('update', (e: MessageEvent) => {
      try {
        cbRef.current(JSON.parse((e as MessageEvent<string>).data) as LiveEventData);
      } catch { /* ignore malformed events */ }
    });
    return () => es.close();
  }, [service]);
}

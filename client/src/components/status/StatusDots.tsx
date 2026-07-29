import type { HistoryFile } from '@shared/types';
import { parseFilename } from '@/lib/parseFilename';

interface StatusDotsProps {
  history: HistoryFile[];
  maxDots?: number;
  showAvg?: boolean;
  showUptime?: boolean;
  onDotClick?: (file: HistoryFile) => void;
}

function getMeta(d: HistoryFile) {
  const parsed = d.timestamp === undefined || d.responseTime === undefined || d.city === undefined
    ? parseFilename(d.filename)
    : null;
  return {
    timestamp: d.timestamp ?? parsed?.timestamp ?? 0,
    responseTime: d.responseTime ?? parsed?.responseTime ?? 0,
    city: d.city ?? parsed?.city ?? 'unknown',
  };
}

function dotTooltip(d: HistoryFile): string {
  const { timestamp, responseTime, city } = getMeta(d);
  const date = new Date(timestamp);
  const label =
    d.overallStatus === 200 ? 'OK' :
    d.overallStatus === 203 ? 'OK (always ok)' :
    d.overallStatus === 400 ? 'PARTIAL' :
    d.overallStatus === 503 ? 'FAIL (always error)' :
    d.overallStatus === 504 ? 'TIMEOUT' : 'FAIL';
  return [
    d.filename,
    `date: ${date.toLocaleDateString()}`,
    `time: ${date.toLocaleTimeString()}`,
    `from: ${city}`,
    `response time: ${responseTime} ms`,
    `status: ${d.overallStatus} ${label}`,
  ].join('\n');
}

export default function StatusDots({ history, maxDots = 48, showAvg = true, showUptime = true, onDotClick }: StatusDotsProps) {
  const nonEmpty = history.length;
  const upCount = history.filter(h => h.overallStatus === 200 || h.overallStatus === 203).length;
  const uptime = nonEmpty > 0 ? Math.round((upCount / nonEmpty) * 100) : 100;
  const timedHistory = history.filter(h => h.overallStatus !== 504);
  const avgMs =
    timedHistory.length > 0
      ? Math.round(timedHistory.reduce((s, h) => s + getMeta(h).responseTime, 0) / timedHistory.length)
      : 0;

  const sorted = [...history].sort((a, b) => getMeta(a).timestamp - getMeta(b).timestamp);
  const hasOverflow = sorted.length > maxDots;

  // Normal: pad left with empty slots up to maxDots so the bar always looks full.
  // Overflow: show all dots — they shrink evenly via flex-1 to fill the available width.
  const displayDots: (HistoryFile | null)[] = hasOverflow
    ? sorted
    : [...Array(maxDots - sorted.length).fill(null), ...sorted];

  // Collapse gap when dots are plentiful to give each dot more room.
  const gapClass = hasOverflow ? 'gap-px' : 'gap-0.5';

  return (
    <div className="flex items-center gap-3 min-w-0 w-full">
      <div className={`flex ${gapClass} flex-1 min-w-0`}>
        {displayDots.map((d, i) => {
          if (!d) {
            return (
              <span
                key={i}
                className="flex-1 min-w-0 h-5 rounded-sm bg-gray-700 opacity-40"
              />
            );
          }
          const color =
            d.overallStatus === 200 ? 'bg-green-500' :
            d.overallStatus === 203 ? 'bg-emerald-700' :
            d.overallStatus === 400 ? 'bg-yellow-500' :
            d.overallStatus === 503 ? 'bg-red-900' :
            d.overallStatus === 504 ? 'bg-orange-500' :
            'bg-red-500';
          const title = dotTooltip(d);
          if (onDotClick) {
            return (
              <button
                key={i}
                type="button"
                className={`flex-1 min-w-0 h-5 rounded-sm ${color} cursor-pointer hover:opacity-75 hover:scale-110 transition-transform focus:outline-none focus:ring-1 focus:ring-white/50`}
                title={title}
                onClick={() => onDotClick(d)}
              />
            );
          }
          return (
            <span
              key={i}
              className={`flex-1 min-w-0 h-5 rounded-sm ${color} cursor-default`}
              title={title}
            />
          );
        })}
      </div>
      {showUptime && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {uptime}% up
        </span>
      )}
      {showAvg && avgMs > 0 && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          avg {avgMs}ms
        </span>
      )}
    </div>
  );
}

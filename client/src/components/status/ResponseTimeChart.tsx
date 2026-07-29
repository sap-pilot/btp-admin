import { useEffect, useRef, useState } from 'react';
import type { HistoryFile, ServiceConfig } from '@shared/types';

interface Props {
  files: HistoryFile[];
  service: ServiceConfig | null;
}

const COLORS = ['#3b82f6', '#22c55e', '#f97316', '#a855f7', '#ec4899', '#14b8a6'];
const SVG_H = 160;
const M = { top: 8, right: 12, bottom: 28, left: 52 };

/** Round up to a visually clean axis maximum. */
function niceMax(v: number): number {
  if (v <= 0) return 100;
  const exp = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, exp);
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

function fmtMs(ms: number): string {
  if (ms === 0) return '0';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtTick(ts: number, spanMs: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (spanMs < 24 * 3_600_000) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${mo}/${dy} ${hh}:${mm}`;
}

// ResponseTimeChart is only used on /service/:name which receives full data from /api/history/:name
type FullFile = HistoryFile & { timestamp: number; responseTime: number };

export default function ResponseTimeChart({ files: rawFiles, service }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(entries => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Narrow to files with the minimum fields needed to plot; new-format files have endpointSlug,
  // old-format have endpointIndex — both are handled in the grouping below
  const files = rawFiles.filter((f): f is FullFile =>
    f.timestamp !== undefined && f.responseTime !== undefined,
  );

  // Group files by endpoint+city; new-format files use endpointSlug, old-format use endpointIndex
  const byEndpoint = new Map<string, { name: string; pts: FullFile[] }>();
  for (const f of files) {
    const key = `${f.endpointSlug ?? f.endpointIndex}__${f.city ?? 'unknown'}`;
    if (!byEndpoint.has(key)) {
      const epName = f.endpointSlug !== undefined
        ? f.endpointSlug
        : f.endpointIndex !== undefined
          ? (service?.endpoints[f.endpointIndex]?.name ?? `Endpoint ${f.endpointIndex}`)
          : 'Unknown';
      const city = f.city ?? 'unknown';
      byEndpoint.set(key, { name: `${epName} (${city})`, pts: [] });
    }
    byEndpoint.get(key)!.pts.push(f);
  }
  const series = [...byEndpoint.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { name, pts }]) => ({
      key,
      name,
      pts: [...pts].sort((a, b) => a.timestamp - b.timestamp) as FullFile[],
    }));

  if (files.length === 0) {
    return (
      <div ref={containerRef} className="h-8 flex items-center">
        <span className="text-xs text-muted-foreground italic">No data in selected time range.</span>
      </div>
    );
  }

  const chartW = Math.max(1, width - M.left - M.right);
  const chartH = SVG_H - M.top - M.bottom;

  // Compute data bounds using reduce to avoid spread-on-large-array stack issues
  const allTs = series.flatMap(s => s.pts.map(p => p.timestamp));
  const allRt = series.flatMap(s => s.pts.map(p => p.responseTime));
  const tsMin = allTs.reduce((a, b) => Math.min(a, b), Infinity);
  const tsMax = allTs.reduce((a, b) => Math.max(a, b), -Infinity);
  const rtMax = allRt.reduce((a, b) => Math.max(a, b), 0);
  const yMax = niceMax(rtMax);
  const spanMs = tsMax - tsMin;

  const sx = (ts: number) =>
    tsMax === tsMin ? chartW / 2 : ((ts - tsMin) / (tsMax - tsMin)) * chartW;
  const sy = (ms: number) => chartH - (ms / yMax) * chartH;

  const buildPath = (pts: FullFile[]) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.timestamp).toFixed(1)},${sy(p.responseTime).toFixed(1)}`)
      .join(' ');

  // Y axis ticks: 5 evenly spaced values
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(t * yMax));

  // X axis ticks: up to 5 evenly spaced unique timestamps
  const uniqueTs = [...new Set(allTs)].sort((a, b) => a - b);
  const xCount = Math.min(5, uniqueTs.length);
  const xTicks =
    xCount <= 1
      ? uniqueTs
      : Array.from({ length: xCount }, (_, i) =>
          uniqueTs[Math.round((i / (xCount - 1)) * (uniqueTs.length - 1))]);

  // Only render dots when data is sparse enough to avoid DOM bloat
  const showDots = files.length <= 200;

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <svg width={width} height={SVG_H} className="overflow-visible">
          <g transform={`translate(${M.left},${M.top})`}>
            {/* Horizontal grid lines + Y axis labels */}
            {yTicks.map(v => (
              <g key={v}>
                <line
                  x1={0} y1={sy(v)} x2={chartW} y2={sy(v)}
                  stroke="currentColor" strokeOpacity={0.1} strokeWidth={1}
                />
                <text
                  x={-6} y={sy(v)} dy="0.35em"
                  textAnchor="end" fontSize={10} fill="currentColor" opacity={0.45}
                >
                  {fmtMs(v)}
                </text>
              </g>
            ))}

            {/* X axis labels */}
            {xTicks.map(ts => (
              <text
                key={ts}
                x={sx(ts)} y={chartH + 18}
                textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.45}
              >
                {fmtTick(ts, spanMs)}
              </text>
            ))}

            {/* Series lines */}
            {series.map((s, i) => (
              <path
                key={s.key}
                d={buildPath(s.pts)}
                fill="none"
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {/* Data point dots with native tooltips (sparse data only) */}
            {showDots &&
              series.map((s, i) =>
                s.pts.map(p => (
                  <circle
                    key={`${s.key}-${p.timestamp}`}
                    cx={sx(p.timestamp)}
                    cy={sy(p.responseTime)}
                    r={2.5}
                    fill={COLORS[i % COLORS.length]}
                  >
                    <title>{`${s.name} · ${new Date(p.timestamp).toLocaleString()} · ${p.responseTime}ms`}</title>
                  </circle>
                )),
              )}
          </g>
        </svg>
      )}

      {/* Legend */}
      {series.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1" style={{ paddingLeft: M.left }}>
          {series.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span
                className="inline-block w-4 rounded"
                style={{ height: 2, backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="text-xs text-muted-foreground">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

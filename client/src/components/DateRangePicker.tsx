import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface CalProps {
  label: string;
  selected: string;
  onSelect: (ymd: string) => void;
  min: string;
  max: string;
}

function MonthCalendar({ label, selected, onSelect, min, max }: CalProps) {
  const [yr, setYr] = useState(() => parseInt(selected.slice(0, 4)));
  const [mo, setMo] = useState(() => parseInt(selected.slice(5, 7)) - 1);

  const prevMo = () => {
    if (mo === 0) { setYr(y => y - 1); setMo(11); }
    else setMo(m => m - 1);
  };
  const nextMo = () => {
    if (mo === 11) { setYr(y => y + 1); setMo(0); }
    else setMo(m => m + 1);
  };

  const curYM = `${yr}-${String(mo + 1).padStart(2, '0')}`;
  const canPrev = curYM > min.slice(0, 7);
  const canNext = curYM < toYMD(new Date()).slice(0, 7);

  const firstDow = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="flex flex-col gap-1 select-none min-w-[168px]">
      <div className="text-[11px] font-semibold text-muted-foreground text-center uppercase tracking-wide">
        {label}
      </div>
      <div className="flex items-center justify-between mb-0.5">
        <button
          onClick={prevMo}
          disabled={!canPrev}
          className="p-1 hover:bg-muted rounded disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs font-medium">{MONTH_NAMES[mo]} {yr}</span>
        <button
          onClick={nextMo}
          disabled={!canNext}
          className="p-1 hover:bg-muted rounded disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px">
        {DOW.map(d => (
          <div key={d} className="text-center text-[10px] text-muted-foreground py-0.5">{d}</div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const ymd = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const isSel = ymd === selected;
          const disabled = ymd < min || ymd > max;
          return (
            <button
              key={i}
              disabled={disabled}
              onClick={() => onSelect(ymd)}
              className={cn(
                'text-xs py-1.5 rounded text-center leading-none transition-colors',
                disabled
                  ? 'text-muted-foreground/30 cursor-not-allowed'
                  : isSel
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'hover:bg-muted cursor-pointer',
              )}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (fromDate: string, untilDate: string) => void;
  fromDate: string;
  untilDate: string;
  maxStorageDays: number;
}

export default function DateRangePicker({ open, onClose, onApply, fromDate: initFrom, untilDate: initUntil, maxStorageDays }: Props) {
  const today = toYMD(new Date());

  const [from, setFrom] = useState(initFrom);
  const [until, setUntil] = useState(initUntil);

  useEffect(() => {
    if (open) { setFrom(initFrom); setUntil(initUntil); }
  }, [open, initFrom, initUntil]);

  function handleFrom(ymd: string) {
    setFrom(ymd);
    if (ymd > until) setUntil(ymd);
  }

  function handleUntil(ymd: string) {
    setUntil(ymd);
    if (ymd < from) setFrom(ymd);
  }

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Select Date Range</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col sm:flex-row gap-5 sm:gap-6 pt-1">
          <div className="flex-1">
            <MonthCalendar
              label="From"
              selected={from}
              onSelect={handleFrom}
              min=""
              max={until}
            />
          </div>
          <div className="hidden sm:block w-px bg-border self-stretch" />
          <div className="block sm:hidden border-t border-border" />
          <div className="flex-1">
            <MonthCalendar
              label="Until (inclusive)"
              selected={until}
              onSelect={handleUntil}
              min={from}
              max={today}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          Up to <strong>{maxStorageDays} days</strong> of history is available based on the server&apos;s{' '}
          <code className="text-[10px]">MAX_RESPONSE_STORAGE_DAYS</code> setting, unless files are starred
          (starred files are retained indefinitely).
        </p>
        <DialogFooter className="mt-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onApply(from, until); onClose(); }}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

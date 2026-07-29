import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import HomepageContent, { type HomepageData } from './HomepageContent';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditHomePageModal({ open, onClose, onSaved }: Props) {
  const [activeTab, setActiveTab] = useState<'edit' | 'history'>('edit');
  const [originalJson, setOriginalJson] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [changelog, setChangelog] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [previewTab, setPreviewTab] = useState('');
  const [splitPct, setSplitPct] = useState(50);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setActiveTab('edit');
    fetch('/api/homepage/raw')
      .then(r => r.json() as Promise<{ json: string | null }>)
      .then(({ json }) => {
        const text = json ? json : '{}';
        setOriginalJson(text);
        setJsonText(text);
      })
      .catch(() => null);
    fetch('/api/homepage/changelog')
      .then(r => r.json() as Promise<{ text: string }>)
      .then(({ text }) => setChangelog(text))
      .catch(() => null);
  }, [open]);

  const parsedData = useMemo<HomepageData | null>(() => {
    try { return JSON.parse(jsonText) as HomepageData; } catch { return null; }
  }, [jsonText]);

  useEffect(() => {
    if (parsedData?.tabs?.length) {
      setPreviewTab(t => (t && parsedData.tabs!.some(tab => tab.title === t)) ? t : parsedData.tabs![0].title);
    }
  }, [parsedData]);

  const isValid = parsedData !== null;
  const isDirty = jsonText !== originalJson;

  function onDragStart(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    function onMove(ev: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
      setSplitPct(pct);
    }
    function onUp() {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async function handleSave() {
    if (!isValid || !isDirty || isSaving) return;
    setIsSaving(true);
    try {
      const r = await fetch('/api/homepage/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: jsonText }),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(t); }
      setOriginalJson(jsonText);
      onSaved();
      const { text } = await fetch('/api/homepage/changelog').then(res => res.json() as Promise<{ text: string }>);
      setChangelog(text);
    } catch (err) {
      alert(`Save failed: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  }

  function handleReset() {
    if (!isDirty) return;
    if (window.confirm('Reset editor to the current saved homepage? Unsaved changes will be lost.')) {
      setJsonText(originalJson);
    }
  }

  function handleClose() {
    if (isDirty && !window.confirm('You have unsaved changes. Discard and close?')) return;
    onClose();
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed inset-4 z-50 flex flex-col rounded-lg bg-background border border-border shadow-2xl overflow-hidden"
          onEscapeKeyDown={e => { e.preventDefault(); handleClose(); }}
          onInteractOutside={e => e.preventDefault()}
          aria-label="Edit Homepage"
        >
          {/* Top bar */}
          <div className="flex items-center border-b border-border px-3 min-h-[48px] shrink-0 gap-1">
            <button
              onClick={() => setActiveTab('edit')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${activeTab === 'edit' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
            >Edit Homepage</button>
            <button
              onClick={() => setActiveTab('history')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${activeTab === 'history' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}
            >Change History</button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={handleReset}
                disabled={!isDirty || isSaving}
                className="px-3 py-1.5 text-sm rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >Reset</button>
              <button
                onClick={() => void handleSave()}
                disabled={!isValid || !isDirty || isSaving}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >{isSaving ? 'Saving…' : 'Save Homepage'}</button>
              <button
                onClick={handleClose}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                title="Close"
              ><X className="h-4 w-4" /></button>
            </div>
          </div>

          {/* Main area */}
          <div className="flex-1 overflow-hidden">
            {activeTab === 'edit' ? (
              <div ref={containerRef} className="flex h-full select-none">
                {/* JSON editor */}
                <div className="flex flex-col overflow-hidden min-w-0" style={{ width: `${splitPct}%` }}>
                  <textarea
                    value={jsonText}
                    onChange={e => setJsonText(e.target.value)}
                    className={`flex-1 w-full h-full resize-none font-mono text-xs p-3 bg-background text-foreground outline-none${!isValid ? ' ring-2 ring-inset ring-destructive/50 border-r-2 border-r-destructive' : ' border-r border-border'}`}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                  />
                </div>
                {/* Drag handle */}
                <div
                  onMouseDown={onDragStart}
                  className="w-1.5 bg-border hover:bg-primary/40 cursor-col-resize shrink-0 transition-colors"
                />
                {/* Preview */}
                <div className="flex-1 overflow-auto min-w-0 select-text">
                  <HomepageContent data={parsedData} activeTab={previewTab} onTabChange={setPreviewTab} />
                </div>
              </div>
            ) : (
              <div className="h-full overflow-auto p-4">
                {changelog ? (
                  <div className="font-mono text-xs leading-relaxed">
                    {renderChangelog(changelog)}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No change history yet.</p>
                )}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function renderChangelog(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    if (line.startsWith('## ')) {
      return <div key={i} className="font-bold mt-4 mb-1 text-foreground first:mt-0">{line.slice(3)}</div>;
    }
    if (line.startsWith('+ ')) {
      return <div key={i} className="text-green-600 dark:text-green-400">{line}</div>;
    }
    if (line.startsWith('- ')) {
      return <div key={i} className="text-red-500 dark:text-red-400">{line}</div>;
    }
    return <div key={i} className="text-muted-foreground">{line || ' '}</div>;
  });
}

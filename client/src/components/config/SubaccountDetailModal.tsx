import { useState } from 'react';
import { X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { SubaccountEntry } from './SubaccountsTable';

interface Props {
  sa:      SubaccountEntry | null;
  onClose: () => void;
}

type ModalTab = 'info' | 'subscriptions' | 'services';

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={`text-xs text-foreground break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

const thCls = 'text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border';
const tdCls = 'px-2 py-1.5 border-b border-border text-xs';

export default function SubaccountDetailModal({ sa, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<ModalTab>('info');

  const tabCls = (t: ModalTab) =>
    `px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
      activeTab === t
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <DialogPrimitive.Root open={sa !== null} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed inset-4 z-50 flex flex-col bg-background rounded-lg shadow-xl outline-none overflow-hidden max-w-[62.4rem] mx-auto"
          onInteractOutside={onClose}
          onEscapeKeyDown={onClose}
          aria-describedby={undefined}
        >
          {!sa ? null : (
            <>
              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
                <DialogPrimitive.Title className="text-sm font-semibold min-w-0 truncate flex-1">
                  {sa.subaccountName}
                  {sa.subdomain && (
                    <span className="ml-2 text-xs font-normal font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {sa.subdomain}
                    </span>
                  )}
                </DialogPrimitive.Title>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Tab bar */}
              <div className="flex border-b border-border shrink-0 px-2 bg-muted/5">
                <button className={tabCls('info')} onClick={() => setActiveTab('info')}>
                  Subaccount &amp; Org
                </button>
                <button className={tabCls('subscriptions')} onClick={() => setActiveTab('subscriptions')}>
                  Subscriptions ({sa.subscriptions.length})
                </button>
                <button className={tabCls('services')} onClick={() => setActiveTab('services')}>
                  Service Instances ({sa.serviceInstances.length})
                </button>
              </div>

              {/* Tab content — fills remaining modal height */}
              <div className="flex-1 overflow-auto">

                {/* ── Subaccount & Org ── */}
                {activeTab === 'info' && (
                  <div className="p-4 space-y-4">
                    {/* Identity grid */}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Subaccount ID"       value={sa.subaccountId}                mono />
                      <Field label="Global Account GUID" value={sa.globalAccountGUID}           mono />
                      <Field label="Global Account Name"      value={sa.globalAccountName}                />
                      <Field label="Global Account Subdomain" value={sa.globalAccountSubdomain} mono />
                      <Field label="Region"              value={sa.region}                      mono />
                      <Field label="Subdomain"           value={sa.subdomain}                   mono />
                      <Field label="Org Name"            value={sa.org?.orgName ?? ''}               />
                      <Field label="Org ID"              value={sa.org?.orgId   ?? ''}          mono />
                      <Field label="Group IDs"           value={sa.groupIds}                         />
                      <Field label="Alias"               value={sa.alias}                            />
                    </div>

                    {/* Flags */}
                    <div className="flex gap-4">
                      {([
                        { label: 'In Homepage',         val: sa.inHomepage },
                        { label: 'Manage Destinations', val: sa.manageDestinations },
                        { label: 'Use AOD',             val: sa.useAOD },
                      ] as const).map(({ label, val }) => (
                        <div key={label} className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${val ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                          <span className="text-xs text-muted-foreground">{label}</span>
                        </div>
                      ))}
                    </div>

                    {/* CF Spaces — full width */}
                    {sa.org && sa.org.spaces.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold text-foreground border-b border-border pb-1 mb-2">
                          CF Spaces
                        </h3>
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="bg-muted/30">
                              <th className={thCls}>Space Name</th>
                              <th className={`${thCls} font-mono`}>Space ID</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sa.org.spaces.map(s => (
                              <tr key={s.spaceId} className="hover:bg-muted/20">
                                <td className={tdCls}>{s.spaceName}</td>
                                <td className={`${tdCls} font-mono text-muted-foreground`}>{s.spaceId}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Subscriptions ── */}
                {activeTab === 'subscriptions' && (
                  sa.subscriptions.length > 0 ? (
                    <table className="w-full border-collapse text-xs">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-muted/30">
                          <th className={thCls}>Application</th>
                          <th className={thCls}>URL</th>
                          <th className={`${thCls} text-center`}>Customer Dev</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sa.subscriptions.map((sub, i) => (
                          <tr key={i} className="hover:bg-muted/20">
                            <td className={tdCls}>{sub.displayName}</td>
                            <td className={`${tdCls} font-mono text-[11px]`}>
                              <a href={sub.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                                {sub.url}
                              </a>
                            </td>
                            <td className={`${tdCls} text-center`}>
                              {sub.customerDeveloped
                                ? <span className="text-green-600 dark:text-green-400 font-medium">Yes</span>
                                : <span className="text-muted-foreground/40">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-muted-foreground px-3 py-8 text-center">No subscriptions.</p>
                  )
                )}

                {/* ── Service Instances ── */}
                {activeTab === 'services' && (
                  sa.serviceInstances.length > 0 ? (
                    <table className="w-full border-collapse text-xs">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-muted/30">
                          <th className={thCls}>Space</th>
                          <th className={thCls}>Instance Name (Service Plan)</th>
                          <th className={thCls}>Dashboard</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sa.serviceInstances.map((svc, i) => {
                          const spaceName = sa.org?.spaces.find(s => s.spaceId === svc.spaceId)?.spaceName ?? '';
                          return (
                            <tr key={i} className="hover:bg-muted/20">
                              <td className={`${tdCls} text-muted-foreground whitespace-nowrap`}>{spaceName || '—'}</td>
                              <td className={tdCls}>
                                <span className="block">{svc.instanceName}</span>
                                {(svc.serviceOfferingName || svc.servicePlanId) && (
                                  <span className="block text-[10px] text-muted-foreground font-mono mt-0.5">
                                    {svc.serviceOfferingName || svc.servicePlanId}
                                  </span>
                                )}
                              </td>
                              <td className={`${tdCls} font-mono text-[11px]`}>
                                <a href={svc.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                                  {svc.url}
                                </a>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-muted-foreground px-3 py-8 text-center">No service instances.</p>
                  )
                )}

              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

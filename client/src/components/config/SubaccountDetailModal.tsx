import { X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { SubaccountEntry } from './SubaccountsTable';

interface Props {
  sa:      SubaccountEntry | null;
  onClose: () => void;
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={`text-xs text-foreground break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

export default function SubaccountDetailModal({ sa, onClose }: Props) {
  return (
    <DialogPrimitive.Root open={sa !== null} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          className="fixed inset-4 z-50 flex flex-col bg-background rounded-lg shadow-xl outline-none overflow-hidden max-w-3xl mx-auto"
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
                <button onClick={onClose} className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-auto p-4 space-y-5">
                {/* Identity fields */}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Subaccount ID"      value={sa.subaccountId}      mono />
                  <Field label="Global Account GUID" value={sa.globalAccountGUID} mono />
                  <Field label="Region"              value={sa.region}            mono />
                  <Field label="Subdomain"           value={sa.subdomain}         mono />
                  <Field label="Group IDs"           value={sa.groupIds}               />
                  <Field label="Alias"               value={sa.alias}                  />
                </div>

                {/* Flags */}
                <div className="flex gap-4">
                  {[
                    { label: 'In Homepage',          val: sa.inHomepage },
                    { label: 'Manage Destinations',  val: sa.manageDestinations },
                    { label: 'Use AOD',              val: sa.useAOD },
                  ].map(({ label, val }) => (
                    <div key={label} className="flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${val ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                      <span className="text-xs text-muted-foreground">{label}</span>
                    </div>
                  ))}
                </div>

                {/* CF Organization */}
                {sa.org && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground border-b border-border pb-1">CF Organization</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Org Name" value={sa.org.orgName} />
                      <Field label="Org ID"   value={sa.org.orgId}   mono />
                    </div>

                    {sa.org.spaces.length > 0 && (
                      <div className="overflow-x-auto mt-1">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="bg-muted/30">
                              <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Space Name</th>
                              <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border font-mono">Space ID</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sa.org.spaces.map(s => (
                              <tr key={s.spaceId} className="hover:bg-muted/20">
                                <td className="px-2 py-1.5 border-b border-border">{s.spaceName}</td>
                                <td className="px-2 py-1.5 border-b border-border font-mono text-muted-foreground">{s.spaceId}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}

                {/* Subscriptions */}
                {sa.subscriptions.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground border-b border-border pb-1">
                      Subscriptions ({sa.subscriptions.length})
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="bg-muted/30">
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Application</th>
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">URL</th>
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Customer Dev</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sa.subscriptions.map((sub, i) => (
                            <tr key={i} className="hover:bg-muted/20">
                              <td className="px-2 py-1.5 border-b border-border">{sub.displayName}</td>
                              <td className="px-2 py-1.5 border-b border-border font-mono text-[11px]">
                                <a href={sub.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                                  {sub.url}
                                </a>
                              </td>
                              <td className="px-2 py-1.5 border-b border-border text-center">
                                {sub.customerDeveloped
                                  ? <span className="text-green-600 dark:text-green-400 font-medium">Yes</span>
                                  : <span className="text-muted-foreground/40">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {/* Service Instances */}
                {sa.serviceInstances.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground border-b border-border pb-1">
                      Service Instances ({sa.serviceInstances.length})
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="bg-muted/30">
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Space</th>
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Service</th>
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Instance</th>
                            <th className="text-left px-2 py-1.5 text-[10px] font-medium text-muted-foreground border-b border-border">Dashboard</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sa.serviceInstances.map((svc, i) => {
                            const spaceName = sa.org?.spaces.find(s => s.spaceId === svc.spaceId)?.spaceName ?? '';
                            return (
                              <tr key={i} className="hover:bg-muted/20">
                                <td className="px-2 py-1.5 border-b border-border text-muted-foreground">{spaceName || '—'}</td>
                                <td className="px-2 py-1.5 border-b border-border font-mono text-muted-foreground">{svc.serviceOfferingName || svc.servicePlanId}</td>
                                <td className="px-2 py-1.5 border-b border-border">{svc.instanceName}</td>
                                <td className="px-2 py-1.5 border-b border-border font-mono text-[11px]">
                                  <a href={svc.url} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                                    {svc.url}
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

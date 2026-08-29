import type { ModalTab } from '@/components/SubaccountModal';

type ModifierEvent = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

export interface SubaccountModalHint {
  appGuid?:       string;
  destName?:      string;
  destShowList?:  boolean;
  destSpaceName?: string;
  destInstName?:  string;
  destInstGuid?:  string;
  rcName?:        string;
  rcShowList?:    boolean;
  userEmail?:     string;
  userOrigin?:    string;
}

function buildPopupUrl(region: string, subdomain: string, tab: ModalTab, hint?: SubaccountModalHint): string {
  const p = new URLSearchParams({ region, subdomain, tab });
  if (hint?.appGuid)                    p.set('appGuid',      hint.appGuid);
  if (hint?.destName)                   p.set('destName',     hint.destName);
  if (hint?.destShowList !== undefined) p.set('destShowList', String(hint.destShowList));
  if (hint?.destSpaceName)              p.set('destSpaceName', hint.destSpaceName);
  if (hint?.destInstName)               p.set('destInstName',  hint.destInstName);
  if (hint?.destInstGuid)               p.set('destInstGuid',  hint.destInstGuid);
  if (hint?.rcName)                     p.set('rcName',        hint.rcName);
  if (hint?.rcShowList !== undefined)   p.set('rcShowList',    String(hint.rcShowList));
  if (hint?.userEmail)                  p.set('userEmail',     hint.userEmail);
  if (hint?.userOrigin)                 p.set('userOrigin',    hint.userOrigin);
  return `/popup.html?${p}`;
}

function openSubaccountPopup(region: string, subdomain: string, tab: ModalTab, hint?: SubaccountModalHint) {
  const url     = buildPopupUrl(region, subdomain, tab, hint);
  const w       = Math.min(window.innerWidth - 32, 1150);
  const h       = window.innerHeight - 32;
  const left    = Math.round((window.screen.width  - w) / 2);
  const top     = Math.round((window.screen.height - h) / 2);
  const winName = `btp-sa-popup:${region}/${subdomain}/${tab}`;
  // Defer one tick so Chrome doesn't inherit the Ctrl-click modifier and force a new tab.
  setTimeout(() => window.open(url, winName, `width=${w},height=${h},left=${left},top=${top}`), 0);
}

function openSubaccountTab(region: string, subdomain: string, tab: ModalTab, hint?: SubaccountModalHint) {
  const url = buildPopupUrl(region, subdomain, tab, hint);
  // Defer one tick so Chrome doesn't inherit the Shift-click modifier and force a new window.
  setTimeout(() => window.open(url, '_blank'), 0);
}

/** Single entry-point for all subaccount modal links.
 *  Ctrl/Cmd → popup window · Shift → new tab · plain click → onOpen() */
export function openSubaccountModal(
  e: ModifierEvent,
  region: string,
  subdomain: string,
  tab: ModalTab,
  onOpen: () => void,
  hint?: SubaccountModalHint,
) {
  if (e.ctrlKey || e.metaKey) {
    openSubaccountPopup(region, subdomain, tab, hint);
  } else if (e.shiftKey) {
    openSubaccountTab(region, subdomain, tab, hint);
  } else {
    onOpen();
  }
}

// Still exported for SubaccountModal's own "Open in new window" button (plain click, no modifier).
export { openSubaccountPopup };

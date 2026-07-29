import { useEffect, useState } from 'react';

export interface AuthState {
  enabled: boolean;
  loggedIn: boolean;
  firstName: string;
  email: string;
  initials: string;
  isAdmin: boolean;
}

interface MeResponse {
  enabled?: boolean;
  loggedIn?: boolean;
  firstName?: string;
  email?: string;
  initials?: string;
  isAdmin?: boolean;
}

interface AuthMessage {
  type: 'login' | 'logout' | 'login-error';
  user?: { firstName: string; initials: string; isAdmin: boolean };
}

const INITIAL: AuthState = { enabled: false, loggedIn: false, firstName: '', email: '', initials: '', isAdmin: false };

function fetchMe(): Promise<MeResponse> {
  return fetch('/api/me').then(r => r.json() as Promise<MeResponse>);
}

function applyMe(d: MeResponse): AuthState {
  return {
    enabled: d.enabled ?? false,
    loggedIn: d.loggedIn ?? false,
    firstName: d.firstName ?? '',
    email: d.email ?? '',
    initials: d.initials ?? '',
    isAdmin: d.isAdmin ?? false,
  };
}

function watchPopup(w: Window, onClose: () => void): () => void {
  const timer = setInterval(() => { if (w.closed) { clearInterval(timer); onClose(); } }, 500);
  return () => clearInterval(timer);
}

// Module-level singleton — shared across all useAuth() calls so /api/me fires once on startup.
let _state: AuthState = INITIAL;
let _initialized = false;
let _popupRef: Window | null = null;
const _listeners = new Set<() => void>();

function _notify() { _listeners.forEach(fn => fn()); }

function _update(updates: Partial<AuthState>) {
  _state = { ..._state, ...updates };
  _notify();
}

function _initOnce() {
  if (_initialized) return;
  _initialized = true;
  fetchMe().then(d => { _state = applyMe(d); _notify(); }).catch(() => null);

  function onMessage(e: MessageEvent) {
    if (e.origin && e.origin !== window.location.origin) return;
    const msg = e.data as AuthMessage;
    if (msg.type === 'login' && msg.user) {
      _update({ loggedIn: true, firstName: msg.user.firstName, initials: msg.user.initials, isAdmin: msg.user.isAdmin });
      _popupRef = null;
    } else if (msg.type === 'logout') {
      _update({ loggedIn: false, firstName: '', email: '', isAdmin: false });
      _popupRef = null;
    } else if (msg.type === 'login-error') {
      _popupRef = null;
    }
  }

  window.addEventListener('message', onMessage);
  // BroadcastChannel bypasses window.opener — works even when Chrome nullifies opener
  // after cross-origin XSUAA navigation.
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('btpauth') : null;
  if (bc) bc.onmessage = onMessage;
  // Event listeners are intentionally kept for the module's lifetime.
}

export function useAuth() {
  const [, rerender] = useState(0);

  useEffect(() => {
    _initOnce();
    const trigger = () => rerender(n => n + 1);
    _listeners.add(trigger);
    return () => { _listeners.delete(trigger); };
  }, []);

  function login() {
    if (_popupRef && !_popupRef.closed) { _popupRef.focus(); return; }
    const w = window.open('/login', 'btpauth', 'width=600,height=700,left=200,top=100');
    _popupRef = w;
    if (w) {
      // Fallback: postMessage may not fire if cross-origin navigation through XSUAA drops window.opener
      watchPopup(w, () => {
        if (_popupRef === w) _popupRef = null;
        fetchMe().then(d => { _state = applyMe(d); _notify(); }).catch(() => null);
      });
    }
  }

  function logout() {
    if (_popupRef && !_popupRef.closed) { _popupRef.focus(); return; }
    const w = window.open('/logout', 'btpauth', 'width=600,height=400,left=200,top=100');
    _popupRef = w;
    if (w) {
      // Fallback: ensure logged-out state even if postMessage was missed during XSUAA redirect chain
      watchPopup(w, () => {
        if (_popupRef === w) _popupRef = null;
        _update({ loggedIn: false, firstName: '', email: '', isAdmin: false });
      });
    }
  }

  return { ..._state, login, logout };
}

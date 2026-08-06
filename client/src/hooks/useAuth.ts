import { useEffect, useState } from 'react';

export interface AuthState {
  loading:        boolean;
  enabled:        boolean;
  loggedIn:       boolean;
  sessionExpired: boolean; // true when a mid-session 401 triggered the logout
  firstName:      string;
  email:          string;
  initials:       string;
  isAdmin:        boolean;
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

const INITIAL: AuthState = { loading: true, enabled: false, loggedIn: false, sessionExpired: false, firstName: '', email: '', initials: '', isAdmin: false };

function fetchMe(): Promise<MeResponse> {
  return fetch('/api/me').then(r => r.json() as Promise<MeResponse>);
}

function applyMe(d: MeResponse): AuthState {
  return {
    loading:        false,
    enabled:        d.enabled  ?? false,
    loggedIn:       d.loggedIn ?? false,
    sessionExpired: false,
    firstName:      d.firstName ?? '',
    email:          d.email     ?? '',
    initials:       d.initials  ?? '',
    isAdmin:        d.isAdmin   ?? false,
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
  fetchMe().then(d => { _state = applyMe(d); _notify(); }).catch(() => { _update({ loading: false }); });

  // Intercept fetch to detect mid-session 401s (expired XSUAA session).
  // Only fires when auth is enabled and the user was actively logged in.
  const _origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const res = await _origFetch(...args);
    if (res.status === 401 && _state.enabled && _state.loggedIn) {
      const raw = typeof args[0] === 'string' ? args[0]
        : args[0] instanceof URL ? args[0].href
        : args[0] instanceof Request ? args[0].url : '';
      let pathname: string;
      try { pathname = new URL(raw, location.href).pathname; } catch { pathname = raw; }
      if (pathname.startsWith('/api/') && pathname !== '/api/me') {
        _update({ loggedIn: false, sessionExpired: true, firstName: '', email: '', isAdmin: false });
      }
    }
    return res;
  };

  function onMessage(e: MessageEvent) {
    if (e.origin && e.origin !== window.location.origin) return;
    const msg = e.data as AuthMessage;
    if (msg.type === 'login' && msg.user) {
      _update({ loggedIn: true, sessionExpired: false, firstName: msg.user.firstName, initials: msg.user.initials, isAdmin: msg.user.isAdmin });
      _popupRef = null;
    } else if (msg.type === 'logout') {
      _update({ loggedIn: false, sessionExpired: false, firstName: '', email: '', isAdmin: false });
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

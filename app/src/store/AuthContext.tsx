import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../config';
import { ApiClient, type Session } from '../core/api';

const SESSION_KEY = 'kinpay.session';

type AuthValue = {
  loading: boolean;
  /** null = mode démonstration hors-ligne (pas de serveur configuré) */
  api: ApiClient | null;
  session: Session | null;
  setSession: (s: Session) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const tokenRef = useRef<string | null>(null);
  const [session, setSessionState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!!API_URL);
  const api = useMemo(() => (API_URL ? new ApiClient(API_URL, () => tokenRef.current) : null), []);

  useEffect(() => {
    if (!API_URL) return;
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(SESSION_KEY);
        if (raw) {
          const s = JSON.parse(raw) as Session;
          if (s && typeof s.token === 'string') {
            tokenRef.current = s.token;
            setSessionState(s);
          }
        }
      } catch {
        // pas de session sauvegardée
      }
      setLoading(false);
    })();
  }, []);

  const setSession = useCallback((s: Session) => {
    tokenRef.current = s.token;
    setSessionState(s);
    SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s)).catch(() => {});
  }, []);

  const logout = useCallback(() => {
    tokenRef.current = null;
    setSessionState(null);
    SecureStore.deleteItemAsync(SESSION_KEY).catch(() => {});
  }, []);

  const value = useMemo(() => ({ loading, api, session, setSession, logout }), [loading, api, session, setSession, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}

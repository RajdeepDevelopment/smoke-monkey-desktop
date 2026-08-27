'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from '../lib/api';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  login: async () => undefined,
  register: async () => undefined,
  logout: () => undefined,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      // No local token — a session may still exist via the httpOnly cookie.
      api
        .me()
        .then((res) => setUser(res.user))
        .catch(() => setUser(null))
        .finally(() => setLoading(false));
      return;
    }
    api
      .me()
      .then((res) => setUser(res.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setToken(res.accessToken);
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, name: string, password: string) => {
    const res = await api.register(email, name, password);
    setToken(res.accessToken);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => undefined);
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

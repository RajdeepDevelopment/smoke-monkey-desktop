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
  needsOnboarding: boolean;
  dismissOnboarding: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => void;
}

const ONBOARDING_TAG = 'sm_onboarding_dismissed';

const onboardingTag = (userId: string) => `${ONBOARDING_TAG}:${userId}`;

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  needsOnboarding: false,
  dismissOnboarding: () => undefined,
  login: async () => undefined,
  register: async () => undefined,
  logout: () => undefined,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    const token = getToken();
    const check = () =>
      api
        .me()
        .then((res) => setUser(res.user))
        .catch(() => {
          // Only tear down the session we were re-validating. If login/register
          // already swapped in a newer token meanwhile, don't clobber it.
          if (getToken() === token) {
            setToken(null);
            setUser(null);
          }
        })
        .finally(() => setLoading(false));
    if (!token) {
      // No local token — a session may still exist via the httpOnly cookie.
      api
        .me()
        .then((res) => setUser(res.user))
        .catch(() => setUser(null))
        .finally(() => setLoading(false));
      return;
    }
    check();
  }, []);

  // After the user is known, decide whether the onboarding wizard should show.
  // The dismissal tag is scoped per user id so a fresh account is never blocked
  // by onboarding state left behind by a previous account on the same device.
  useEffect(() => {
    if (loading || !user) return;
    if (localStorage.getItem(onboardingTag(user.id)) === '1') return;
    api
      .fetchOnboarding()
      .then((res) => setNeedsOnboarding(!res.completed))
      .catch(() => setNeedsOnboarding(false));
  }, [loading, user]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setToken(res.accessToken);
    setNeedsOnboarding(false);
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, name: string, password: string) => {
    const res = await api.register(email, name, password);
    setToken(res.accessToken);
    setNeedsOnboarding(false);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => undefined);
    if (user) localStorage.removeItem(onboardingTag(user.id));
    setToken(null);
    setUser(null);
    setNeedsOnboarding(false);
  }, [user]);

  const dismissOnboarding = useCallback(() => {
    if (!user) return;
    localStorage.setItem(onboardingTag(user.id), '1');
    setNeedsOnboarding(false);
  }, [user]);

  return (
    <AuthContext.Provider
      value={{ user, loading, needsOnboarding, dismissOnboarding, login, register, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

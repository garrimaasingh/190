"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiClientError, type Me, type Meta } from "@/lib/client/api";

// ============================================================
// Auth context — client-side mirror of the server session.
// The httpOnly cookie is the real credential; this context only
// caches the /auth/me bundle for rendering and UI guards.
// ============================================================

interface AuthState {
  status: "loading" | "authenticated" | "anonymous";
  me: Me | null;
  meta: Meta | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<Me>("/api/v1/auth/me");
      setMe(data);
      setStatus("authenticated");
      try {
        setMeta(await api.get<Meta>("/api/v1/meta"));
      } catch {
        setMeta(null);
      }
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        setMe(null);
        setStatus("anonymous");
      } else {
        // transient failure — keep anonymous but log
        console.error(err);
        setMe(null);
        setStatus("anonymous");
      }
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const login = useCallback(async (email: string, password: string) => {
    await api.post("/api/v1/auth/login", { email, password });
    await reload();
  }, [reload]);

  const logout = useCallback(async () => {
    try {
      await api.post("/api/v1/auth/logout");
    } finally {
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo(
    () => ({ status, me, meta, login, logout, reload }),
    [status, me, meta, login, logout, reload]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function hasPermission(me: Me | null, permission: string): boolean {
  if (!me) return false;
  return me.permissions.includes(permission);
}

"use client";

import * as React from "react";
import { useAuth } from "@/lib/client/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/platform/common";
import { ShieldCheck, Info } from "lucide-react";
import { ApiClientError } from "@/lib/client/api";

// ============================================================
// Login view (spec §17). Generic error copy — the UI must not
// reveal whether an email exists.
// ============================================================

export function LoginView() {
  const { login } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.status === 429 ? err.message : "Invalid email or password.");
      } else {
        setError("Sign-in failed. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <ShieldCheck aria-hidden size={26} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Central Justice Platform</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Secure sign-in for departments and officers. Identity, organization and access foundation.
        </p>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use the credentials issued by your department administrator.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Official email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="officer@department.gov.in"
                aria-invalid={!!error}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                aria-invalid={!!error}
              />
            </div>
            <FieldError message={error || undefined} />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-4 w-full max-w-md border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Info aria-hidden size={16} /> Demo accounts (seed data)
          </CardTitle>
          <CardDescription className="text-xs">
            Development seed accounts — password for all: <code className="rounded bg-muted px-1 py-0.5">Demo@Pass1</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1 text-xs text-muted-foreground">
          <p><span className="font-medium text-foreground">SYSTEM_ADMIN</span> — sysadmin@demo.gov.in</p>
          <p><span className="font-medium text-foreground">DEPARTMENT_ADMIN</span> — arjun.sharma@demo.gov.in (Indore Police)</p>
          <p><span className="font-medium text-foreground">DEPARTMENT_ADMIN</span> — meera.desai@demo.gov.in (Indore FSL)</p>
          <p><span className="font-medium text-foreground">OFFICER</span> — vishnu.kumar@demo.gov.in (Indore Police)</p>
          <p><span className="font-medium text-foreground">AUDITOR</span> — priya.nair@demo.gov.in</p>
        </CardContent>
      </Card>
    </div>
  );
}

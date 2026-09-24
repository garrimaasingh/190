"use client";

import * as React from "react";
import { useAuth } from "@/lib/client/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RoleBadge, StatusBadge } from "@/components/platform/common";
import { Check, Minus, ShieldCheck } from "lucide-react";

// ============================================================
// Settings (Phase 1): session transparency + role/permission
// matrix. Security UX (spec §42) — the user can always see who
// they are, which department they belong to, and what their
// session permits.
// ============================================================

export function SettingsView() {
  const { me, meta } = useAuth();
  if (!me) return null;

  const myRolePermissions = meta?.rolePermissions?.[me.officer.role] || me.permissions;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Session transparency and your access profile.</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck size={16} aria-hidden /> Session
          </CardTitle>
          <CardDescription>
            Your authentication is a server-side session bound to an httpOnly cookie. Logging out revokes it on the server — closing the page does not keep you signed in beyond the session lifetime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Signed in as</dt>
              <dd className="font-medium">{me.officer.name} <span className="font-mono text-xs text-muted-foreground">({me.officer.officerId})</span></dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Department</dt>
              <dd className="font-medium">{me.department?.name || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Role</dt>
              <dd><RoleBadge role={me.officer.role} /></dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Account status</dt>
              <dd><StatusBadge status={me.officer.status} /></dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your permissions ({myRolePermissions.length})</CardTitle>
          <CardDescription>Effective permissions granted to your role. Access is enforced by the backend on every request.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {myRolePermissions.map((p) => (
              <li key={p} className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
                <Check size={12} aria-hidden className="text-emerald-600" /> {p}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {meta && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Role / permission matrix</CardTitle>
            <CardDescription>Platform-wide reference of the Phase 1 authorization model.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Permission</TableHead>
                    {Object.keys(meta.rolePermissions).map((r) => (
                      <TableHead key={r} className="text-center">
                        <span className="sr-only">{r}</span>
                        <span aria-hidden className="text-[10px] font-medium">{r.split("_")[0]}<br />{r.split("_")[1] || ""}</span>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from(new Set(Object.values(meta.rolePermissions).flat())).sort().map((perm) => (
                    <TableRow key={perm}>
                      <TableCell className="font-mono text-xs">{perm}</TableCell>
                      {Object.keys(meta.rolePermissions).map((r) => (
                        <TableCell key={r} className="text-center">
                          {meta.rolePermissions[r].includes(perm) ? (
                            <Check size={14} aria-label={`${r} has ${perm}`} className="mx-auto text-emerald-600" />
                          ) : (
                            <Minus size={14} aria-label={`${r} does not have ${perm}`} className="mx-auto text-muted-foreground/40" />
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

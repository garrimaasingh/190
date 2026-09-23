"use client";

import * as React from "react";
import { useAuth, hasPermission } from "@/lib/client/store";
import { api, type AdminStats, type DepartmentListItem, type OfficerRow } from "@/lib/client/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DepartmentLogo,
  GeographicBreadcrumb,
  StatusBadge,
  RoleBadge,
  LoadingState,
  ErrorState,
} from "@/components/platform/common";
import { Building2, Users, MapPin, Network, Plus, ScrollText, Globe2, Landmark, Building, Map } from "lucide-react";
import type { ViewKey } from "@/components/platform/AppShell";

// ============================================================
// Dashboard — role-aware (spec §20/§21).
//  SYSTEM_ADMIN → platform statistics + geographic explorer
//  DEPARTMENT_ADMIN / OFFICER → department overview
//  AUDITOR → read-only platform statistics
// No case/document panels — later phases only.
// ============================================================

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AdminDashboard({ onNavigate }: { onNavigate: (v: ViewKey) => void }) {
  const { me } = useAuth();
  const [stats, setStats] = React.useState<AdminStats | null>(null);
  const [recent, setRecent] = React.useState<DepartmentListItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setError(null);
    Promise.all([
      hasPermission(me, "platform.stats.read") ? api.get<AdminStats>("/api/v1/admin/stats") : Promise.resolve(null),
      api.get<{ items: DepartmentListItem[] }>("/api/v1/departments?page=1&pageSize=5"),
    ])
      .then(([s, r]) => {
        setStats(s);
        setRecent(r.items);
      })
      .catch((e) => setError(e?.message || "Failed to load dashboard."));
  }, [me]);

  React.useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!recent) return <LoadingState rows={4} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform Dashboard</h1>
        <p className="text-sm text-muted-foreground">Centralized organizational overview across all departments.</p>
      </div>

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={<Map size={20} aria-hidden />} label="States" value={stats.geography.states} />
            <StatCard icon={<MapPin size={20} aria-hidden />} label="Districts" value={stats.geography.districts} />
            <StatCard icon={<Building size={20} aria-hidden />} label="Cities" value={stats.geography.cities} />
            <StatCard icon={<Globe2 size={20} aria-hidden />} label="Countries" value={stats.geography.countries} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={<Building2 size={20} aria-hidden />} label="Departments" value={stats.departments.total} />
            <StatCard icon={<Building2 size={20} aria-hidden />} label="Active depts" value={stats.departments.active} />
            <StatCard icon={<Users size={20} aria-hidden />} label="Officers" value={stats.officers.total} />
            <StatCard icon={<Users size={20} aria-hidden />} label="Active officers" value={stats.officers.active} />
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {hasPermission(me, "department.create") && (
          <Button onClick={() => onNavigate("department-register")}>
            <Plus size={16} aria-hidden /> Register Department
          </Button>
        )}
        <Button variant="outline" onClick={() => onNavigate("departments")}>
          <Building2 size={16} aria-hidden /> Department Directory
        </Button>
        <Button variant="outline" onClick={() => onNavigate("organization")}>
          <Network size={16} aria-hidden /> Geographic Explorer
        </Button>
        {hasPermission(me, "events.read") && (
          <Button variant="outline" onClick={() => onNavigate("events")}>
            <ScrollText size={16} aria-hidden /> Identity Events
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recently registered departments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recent.length === 0 && <p className="text-sm text-muted-foreground">No departments registered yet.</p>}
          {recent.map((d) => (
            <button
              key={d.id}
              onClick={() => onNavigate("departments")}
              className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <DepartmentLogo logoPath={d.logoPath} name={d.name} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {d.departmentType} · {d.location.city}, {d.location.state}
                </p>
              </div>
              <StatusBadge status={d.status} />
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function DepartmentDashboard({ onNavigate }: { onNavigate: (v: ViewKey) => void }) {
  const { me } = useAuth();
  const [dept, setDept] = React.useState<DepartmentDetailLite | null>(null);
  const [officers, setOfficers] = React.useState<OfficerRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    if (!me?.department) return;
    setError(null);
    Promise.all([
      api.get<DepartmentDetailLite>(`/api/v1/departments/${me.department.id}`),
      api.get<{ items: OfficerRow[] }>(`/api/v1/departments/${me.department.id}/officers?page=1&pageSize=5`),
    ])
      .then(([d, o]) => {
        setDept(d);
        setOfficers(o.items);
      })
      .catch((e) => setError(e?.message || "Failed to load department."));
  }, [me]);

  React.useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!dept) return <LoadingState rows={4} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Department Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview of your department and its organizational context.</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <DepartmentLogo logoPath={dept.logoPath} name={dept.name} size={72} className="shrink-0" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">{dept.name}</h2>
                <StatusBadge status={dept.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                {dept.departmentType} · ID <span className="font-mono">{dept.departmentCode}</span>
              </p>
              <GeographicBreadcrumb
                country={dept.geography.country}
                state={dept.geography.state}
                district={dept.geography.district}
                city={dept.geography.city}
              />
            </div>
          </div>
          {dept.description && <p className="mt-4 text-sm text-muted-foreground">{dept.description}</p>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard icon={<Users size={20} aria-hidden />} label="Officers" value={dept.officerCount} />
        <StatCard icon={<Building2 size={20} aria-hidden />} label="Status" value={<StatusBadge status={dept.status} />} />
        <StatCard icon={<Landmark size={20} aria-hidden />} label="Administrators" value={dept.administrators.length} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Officers</CardTitle>
          {me?.officer.role === "DEPARTMENT_ADMIN" && (
            <Button variant="outline" size="sm" onClick={() => onNavigate("officers")}>
              Manage
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {officers?.length === 0 && <p className="text-sm text-muted-foreground">No officers registered yet.</p>}
          {officers?.map((o) => (
            <button
              key={o.id}
              onClick={() => onNavigate("officers")}
              className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{o.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{o.officerId}</span> · {o.designation}
                </p>
              </div>
              <RoleBadge role={o.role} />
              <StatusBadge status={o.status} />
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

interface DepartmentDetailLite {
  id: string;
  departmentCode: string;
  name: string;
  departmentType: string;
  description: string | null;
  logoPath: string | null;
  status: string;
  geography: { country: string; state: string; district: string; city: string };
  officerCount: number;
  administrators: { id: string }[];
}

export function DashboardView({ onNavigate }: { onNavigate: (v: ViewKey) => void }) {
  const { me } = useAuth();
  if (!me) return null;
  if (me.officer.role === "SYSTEM_ADMIN" || me.officer.role === "AUDITOR") {
    return <AdminDashboard onNavigate={onNavigate} />;
  }
  return <DepartmentDashboard onNavigate={onNavigate} />;
}

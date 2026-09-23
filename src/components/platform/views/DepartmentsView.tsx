"use client";

import * as React from "react";
import { api, type DepartmentListItem } from "@/lib/client/api";
import { useAuth, hasPermission } from "@/lib/client/store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DepartmentLogo,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
  GeographicBreadcrumb,
} from "@/components/platform/common";
import { Search, Plus, ChevronLeft, ChevronRight } from "lucide-react";

// ============================================================
// Department Directory (spec §22): search + filters
// (state / district / city cascading + type + status) + pagination.
// ============================================================

export function DepartmentsView({ onOpenDepartment, onRegister }: { onOpenDepartment: (id: string) => void; onRegister: () => void }) {
  const { me, meta } = useAuth();
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [type, setType] = React.useState("ALL");
  const [status, setStatus] = React.useState("ALL");
  const [stateId, setStateId] = React.useState<string>();
  const [districtId, setDistrictId] = React.useState<string>();
  const [cityId, setCityId] = React.useState<string>();
  const [states, setStates] = React.useState<{ id: string; name: string }[]>([]);
  const [districts, setDistricts] = React.useState<{ id: string; name: string }[]>([]);
  const [cities, setCities] = React.useState<{ id: string; name: string }[]>([]);
  const [data, setData] = React.useState<DepartmentListItem[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const pageSize = 9;

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    api.get<{ id: string; name: string }[]>("/api/v1/geography/states").then(setStates).catch(() => setStates([]));
  }, []);

  React.useEffect(() => {
    if (!stateId) return setDistricts([]);
    api.get<{ id: string; name: string }[]>(`/api/v1/geography/states/${stateId}/districts`).then(setDistricts).catch(() => setDistricts([]));
  }, [stateId]);

  React.useEffect(() => {
    if (!districtId) return setCities([]);
    api.get<{ id: string; name: string }[]>(`/api/v1/geography/districts/${districtId}/cities`).then(setCities).catch(() => setCities([]));
  }, [districtId]);

  const load = React.useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debounced) params.set("search", debounced);
    if (type !== "ALL") params.set("departmentType", type);
    if (status !== "ALL") params.set("status", status);
    if (cityId) params.set("cityId", cityId);
    else if (districtId) params.set("districtId", districtId);
    else if (stateId) params.set("stateId", stateId);
    api.get<{ items: DepartmentListItem[]; total: number }>(`/api/v1/departments?${params.toString()}`)
      .then((d) => {
        setData(d.items);
        setTotal(d.total);
      })
      .catch((e) => setError(e?.message || "Failed to load departments."));
  }, [debounced, type, status, stateId, districtId, cityId, page]);

  React.useEffect(load, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Department Directory</h1>
          <p className="text-sm text-muted-foreground">All departments operating on the central platform.</p>
        </div>
        {hasPermission(me, "department.create") && (
          <Button onClick={onRegister}>
            <Plus size={16} aria-hidden /> Register Department
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="relative">
            <Search aria-hidden size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search name or department code…"
              className="pl-9"
              aria-label="Search departments"
            />
          </div>
          <Select
            value={stateId || "ALL"}
            onValueChange={(v) => {
              setStateId(v === "ALL" ? undefined : v);
              setDistrictId(undefined);
              setCityId(undefined);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Filter by state"><SelectValue placeholder="All states" /></SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value="ALL">All states</SelectItem>
              {states.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select
            value={districtId || "ALL"}
            onValueChange={(v) => {
              setDistrictId(v === "ALL" ? undefined : v);
              setCityId(undefined);
              setPage(1);
            }}
            disabled={!stateId}
          >
            <SelectTrigger aria-label="Filter by district"><SelectValue placeholder="All districts" /></SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value="ALL">All districts</SelectItem>
              {districts.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select
            value={cityId || "ALL"}
            onValueChange={(v) => {
              setCityId(v === "ALL" ? undefined : v);
              setPage(1);
            }}
            disabled={!districtId}
          >
            <SelectTrigger aria-label="Filter by city"><SelectValue placeholder="All cities" /></SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value="ALL">All cities</SelectItem>
              {cities.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => { setType(v); setPage(1); }}>
            <SelectTrigger aria-label="Filter by department type"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value="ALL">All types</SelectItem>
              {(meta?.departmentTypes || []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
            <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-64">
              <SelectItem value="ALL">All statuses</SelectItem>
              {(meta?.departmentStatuses || ["ACTIVE", "INACTIVE", "PENDING"]).map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !data && <LoadingState rows={3} />}
      {!error && data && data.length === 0 && (
        <EmptyState title="No departments found" description="Adjust the filters or register a new department." />
      )}

      {!error && data && data.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((d) => (
              <Card
                key={d.id}
                className="cursor-pointer transition-shadow hover:shadow-md focus-within:outline-2 focus-within:outline-ring"
                role="button"
                tabIndex={0}
                aria-label={`Open ${d.name}`}
                onClick={() => onOpenDepartment(d.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenDepartment(d.id);
                  }
                }}
              >
                <CardContent className="flex items-start gap-3 p-4">
                  <DepartmentLogo logoPath={d.logoPath} name={d.name} size={48} className="shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate font-medium">{d.name}</p>
                      <StatusBadge status={d.status} />
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">{d.departmentCode}</p>
                    <GeographicBreadcrumb
                      state={d.location.state}
                      district={d.location.district}
                      city={d.location.city}
                    />
                    <p className="text-xs text-muted-foreground">
                      {d.departmentType} · {d.officerCount} officer{d.officerCount === 1 ? "" : "s"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {total} department{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft size={16} aria-hidden /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                Next <ChevronRight size={16} aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

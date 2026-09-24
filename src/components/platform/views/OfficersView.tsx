"use client";

import * as React from "react";
import { useAuth, hasPermission } from "@/lib/client/store";
import { api, ApiClientError, type OfficerRow } from "@/lib/client/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusBadge, RoleBadge, EmptyState, LoadingState, ErrorState, FieldError } from "@/components/platform/common";
import { Search, UserPlus, ChevronLeft, ChevronRight, Eye, Pencil } from "lucide-react";
import type { ViewKey } from "@/components/platform/AppShell";

// ============================================================
// Officer Directory & management (spec §23/§24/§40).
// Registration, role assignment and lifecycle actions are all
// gated server-side; the UI only reflects permissions.
// ============================================================

interface Props {
  departmentId?: string; // scoped mode (dept admin/officer context)
  onOpenOfficer: (id: string) => void;
  onNavigate: (v: ViewKey) => void;
}

export function OfficersView({ departmentId, onOpenOfficer, onNavigate }: Props) {
  const { me, meta } = useAuth();
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("ALL");
  const [rows, setRows] = React.useState<OfficerRow[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const pageSize = 10;

  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [statusTarget, setStatusTarget] = React.useState<{ officer: OfficerRow; next: string } | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const listUrl = departmentId
    ? `/api/v1/departments/${departmentId}/officers`
    : "/api/v1/officers";

  const load = React.useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debounced) params.set("search", debounced);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    api
      .get<{ items: OfficerRow[]; total: number }>(`${listUrl}?${params.toString()}`)
      .then((d) => {
        setRows(d.items);
        setTotal(d.total);
      })
      .catch((e) => setError(e?.message || "Failed to load officers."));
  }, [listUrl, debounced, statusFilter, page]);

  React.useEffect(load, [load]);

  const canCreate = hasPermission(me, "officer.create");
  const canUpdate = hasPermission(me, "officer.update");
  const canStatus = hasPermission(me, "officer.activate") || hasPermission(me, "officer.deactivate");

  async function applyStatus() {
    if (!statusTarget) return;
    const { officer, next } = statusTarget;
    setStatusTarget(null);
    try {
      await api.patch(`/api/v1/officers/${officer.id}/status`, { status: next });
      load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Status change failed.");
    }
  }

  function nextStatuses(current: string): string[] {
    return meta?.officerStatusTransitions?.[current] || [];
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{departmentId ? "Officers" : "Officer Directory"}</h1>
          <p className="text-sm text-muted-foreground">
            {departmentId ? "Officers registered in your department." : "Officers across departments (scoped by your authorization)."}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setRegisterOpen(true)}>
            <UserPlus size={16} aria-hidden /> Register Officer
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search aria-hidden size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search officer ID, name or email…"
            className="pl-9"
            aria-label="Search officers"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-44" aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value="ALL">All statuses</SelectItem>
            {(meta?.officerStatuses || []).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !rows && <LoadingState rows={4} />}
      {!error && rows && rows.length === 0 && (
        <EmptyState title="No officers found" description="Adjust the filters or register a new officer." />
      )}

      {!error && rows && rows.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Officer ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Designation</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Last login</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-mono text-xs">{o.officerId}</TableCell>
                      <TableCell className="font-medium">{o.name}</TableCell>
                      <TableCell className="hidden md:table-cell">{o.designation}</TableCell>
                      <TableCell><RoleBadge role={o.role} /></TableCell>
                      <TableCell><StatusBadge status={o.status} /></TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                        {o.lastLoginAt ? new Date(o.lastLoginAt).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => onOpenOfficer(o.id)} aria-label={`View ${o.name}`}>
                            <Eye size={14} aria-hidden /> View
                          </Button>
                          {canUpdate && (
                            <Button variant="ghost" size="sm" onClick={() => onOpenOfficer(o.id)} aria-label={`Edit ${o.name}`}>
                              <Pencil size={14} aria-hidden /> Edit
                            </Button>
                          )}
                          {canStatus && nextStatuses(o.status).length > 0 && (
                            <Select
                              onValueChange={(next) => setStatusTarget({ officer: o, next })}
                              disabled={o.role === "SYSTEM_ADMIN"}
                            >
                              <SelectTrigger className="h-8 w-9 p-0" aria-label={`Change status for ${o.name}`}>
                                <span aria-hidden className="px-2">⋯</span>
                              </SelectTrigger>
                              <SelectContent>
                                {nextStatuses(o.status).map((s) => (
                                  <SelectItem key={s} value={s}>Set {s}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {total} officer{total === 1 ? "" : "s"} · page {page} of {Math.max(1, Math.ceil(total / pageSize))}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft size={16} aria-hidden /> Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next page"
          >
            Next <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      </div>

      <RegisterOfficerDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        departmentId={departmentId}
        onCreated={() => {
          setRegisterOpen(false);
          load();
        }}
        onNavigate={onNavigate}
      />

      {/* Status change confirmation (spec §40) */}
      <AlertDialog open={!!statusTarget} onOpenChange={(o) => !o && setStatusTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change officer status</AlertDialogTitle>
            <AlertDialogDescription>
              {statusTarget?.next === "ACTIVE"
                ? `${statusTarget?.officer.name} will regain authentication access.`
                : `${statusTarget?.officer.name} will lose authentication access immediately. Live sessions will be revoked. Historical records are preserved.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={applyStatus}>Confirm change</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------- Register officer dialog (spec §24) ----------

function RegisterOfficerDialog({
  open,
  onOpenChange,
  departmentId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  departmentId?: string;
  onCreated: () => void;
  onNavigate?: (v: ViewKey) => void;
}) {
  const { me, meta } = useAuth();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [designation, setDesignation] = React.useState("");
  const [role, setRole] = React.useState<string>("OFFICER");
  const [password, setPassword] = React.useState("");
  const [initialStatus, setInitialStatus] = React.useState("ACTIVE");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const targetDeptId = departmentId || me?.department?.id || "";
  const assignable = React.useMemo(() => {
    if (me?.officer.role === "SYSTEM_ADMIN") return meta?.officerRoles || [];
    if (me?.officer.role === "DEPARTMENT_ADMIN") return ["DEPARTMENT_ADMIN", "OFFICER"];
    return [];
  }, [me, meta]);

  React.useEffect(() => {
    if (open) {
      setName(""); setEmail(""); setPhone(""); setDesignation("");
      setRole("OFFICER"); setPassword(""); setInitialStatus("ACTIVE"); setFieldError(null);
    }
  }, [open]);

  async function submit() {
    setSaving(true);
    setFieldError(null);
    try {
      await api.post(`/api/v1/departments/${targetDeptId}/officers`, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        designation: designation.trim(),
        role,
        password,
        status: initialStatus,
      });
      onCreated();
    } catch (e) {
      setFieldError(e instanceof ApiClientError ? e.message : "Registration failed.");
    } finally {
      setSaving(false);
    }
  }

  const valid = name.trim().length >= 2 && /.+@.+\..+/.test(email) && designation.trim().length >= 2 && password.length >= 8;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register officer</DialogTitle>
          <DialogDescription>
            A stable Officer ID (e.g. OFF-MP-IND-00024) is generated by the server and never changes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="off-name">Full name *</Label>
            <Input id="off-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="off-email">Official email *</Label>
            <Input id="off-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="off-phone">Phone</Label>
            <Input id="off-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91-…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="off-desig">Designation *</Label>
            <Input id="off-desig" value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label>Role *</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger aria-label="Select role" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">
                {assignable.map((r) => <SelectItem key={r} value={r}>{r.replaceAll("_", " ")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="off-pass">Initial password *</Label>
            <Input id="off-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-xs text-muted-foreground">Min 8 chars, letter + number. Share securely.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Initial status</Label>
            <Select value={initialStatus} onValueChange={setInitialStatus}>
              <SelectTrigger aria-label="Select initial status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">ACTIVE — can sign in immediately</SelectItem>
                <SelectItem value="PENDING">PENDING — requires activation</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <FieldError message={fieldError || undefined} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !valid}>{saving ? "Creating…" : "Create officer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

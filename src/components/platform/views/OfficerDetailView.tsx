"use client";

import * as React from "react";
import { useAuth, hasPermission } from "@/lib/client/store";
import { api, ApiClientError, type OfficerRow } from "@/lib/client/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { StatusBadge, RoleBadge, GeographicBreadcrumb, LoadingState, ErrorState } from "@/components/platform/common";
import { Pencil } from "lucide-react";

// ============================================================
// Officer detail (spec §40): identity card + authorized edits.
// ============================================================

interface OfficerDetail extends OfficerRow {
  department: {
    id: string;
    departmentCode: string;
    name: string;
    departmentType: string;
    geography: { state: string; district: string; city: string };
  };
}

export function OfficerDetailView({ officerId, onBack }: { officerId: string; onBack: () => void }) {
  const { me, meta, reload } = useAuth();
  const [officer, setOfficer] = React.useState<OfficerDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const [editOpen, setEditOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [designation, setDesignation] = React.useState("");
  const [role, setRole] = React.useState("OFFICER");
  const [saving, setSaving] = React.useState(false);
  const [statusTarget, setStatusTarget] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setError(null);
    api
      .get<OfficerDetail>(`/api/v1/officers/${officerId}`)
      .then((o) => {
        setOfficer(o);
        setName(o.name);
        setPhone(o.phone || "");
        setDesignation(o.designation);
        setRole(o.role);
      })
      .catch((e) => setError(e?.message || "Failed to load officer."));
  }, [officerId]);

  React.useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!officer) return <LoadingState rows={3} />;

  const canUpdate = hasPermission(me, "officer.update");
  const canStatus = hasPermission(me, "officer.activate");
  const nextStatuses = meta?.officerStatusTransitions?.[officer.status] || [];

  async function saveEdit() {
    setSaving(true);
    setActionError(null);
    try {
      await api.patch(`/api/v1/officers/${officer!.id}`, {
        name: name.trim(),
        phone: phone.trim() || undefined,
        designation: designation.trim(),
        role,
      });
      setEditOpen(false);
      load();
      reload();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(next: string) {
    setStatusTarget(null);
    setActionError(null);
    try {
      await api.patch(`/api/v1/officers/${officer!.id}/status`, { status: next });
      load();
    } catch (e) {
      setActionError(e instanceof ApiClientError ? e.message : "Status change failed.");
    }
  }

  const assignable =
    me?.officer.role === "SYSTEM_ADMIN"
      ? meta?.officerRoles || []
      : me?.officer.role === "DEPARTMENT_ADMIN"
        ? ["DEPARTMENT_ADMIN", "OFFICER"]
        : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Officer Profile</h1>
          <p className="text-sm text-muted-foreground">Identity, role and organizational placement.</p>
        </div>
        <Button variant="outline" onClick={onBack}>← Back to officers</Button>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground" aria-hidden>
                {officer.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold">{officer.name}</h2>
                  <RoleBadge role={officer.role} />
                  <StatusBadge status={officer.status} />
                </div>
                <p className="font-mono text-sm text-muted-foreground">{officer.officerId}</p>
              </div>
            </div>

            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Designation</dt>
                <dd className="font-medium">{officer.designation}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Email</dt>
                <dd className="font-medium">{officer.email}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Phone</dt>
                <dd className="font-medium">{officer.phone || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last login</dt>
                <dd className="font-medium">{officer.lastLoginAt ? new Date(officer.lastLoginAt).toLocaleString() : "Never"}</dd>
              </div>
            </dl>

            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Department &amp; location</p>
              <p className="font-medium">{officer.department.name}</p>
              <GeographicBreadcrumb
                state={officer.department.geography.state}
                district={officer.department.geography.district}
                city={officer.department.geography.city}
              />
            </div>

            {(canUpdate || canStatus) && officer.role !== "SYSTEM_ADMIN" && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {canUpdate && (
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil size={14} aria-hidden /> Edit officer
                  </Button>
                )}
                {canStatus &&
                  nextStatuses.map((s) => (
                    <Button key={s} variant="outline" size="sm" onClick={() => setStatusTarget(s)}>
                      {s === "ACTIVE" ? "Reactivate" : `Set ${s.toLowerCase()}`}
                    </Button>
                  ))}
              </div>
            )}
            {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
          </div>
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit officer</DialogTitle>
            <DialogDescription>
              Officer ID <span className="font-mono">{officer.officerId}</span> is permanent. Email is the login identity.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="oedit-name">Full name</Label>
              <Input id="oedit-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oedit-phone">Phone</Label>
              <Input id="oedit-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oedit-desig">Designation</Label>
              <Input id="oedit-desig" value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={120} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger aria-label="Select role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {assignable.map((r) => <SelectItem key={r} value={r}>{r.replaceAll("_", " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {actionError && <p className="mt-2 text-sm text-destructive" role="alert">{actionError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!statusTarget} onOpenChange={(o) => !o && setStatusTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change status to {statusTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              {statusTarget === "ACTIVE"
                ? "The officer will regain authentication access."
                : "The officer will lose authentication access immediately and live sessions will be revoked."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => statusTarget && changeStatus(statusTarget)}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

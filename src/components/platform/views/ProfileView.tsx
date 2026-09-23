"use client";

import * as React from "react";
import { useAuth } from "@/lib/client/store";
import { api, ApiClientError } from "@/lib/client/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DepartmentLogo, StatusBadge, RoleBadge, GeographicBreadcrumb, LoadingState, ErrorState } from "@/components/platform/common";

// ============================================================
// Own profile (spec §41). Server-controlled identity fields
// (name, officer ID, email, role, status) are read-only here.
// ============================================================

interface Profile {
  id: string;
  officerId: string;
  name: string;
  email: string;
  phone: string | null;
  designation: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  department: {
    id: string;
    departmentCode: string;
    name: string;
    departmentType: string;
    logoPath: string | null;
    geography: { country: string; state: string; district: string; city: string };
  };
}

export function ProfileView() {
  const { reload } = useAuth();
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [phoneOpen, setPhoneOpen] = React.useState(false);
  const [phone, setPhone] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [phoneError, setPhoneError] = React.useState<string | null>(null);

  const [pwdOpen, setPwdOpen] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [pwdError, setPwdError] = React.useState<string | null>(null);
  const [pwdSaving, setPwdSaving] = React.useState(false);

  const load = React.useCallback(() => {
    setError(null);
    api
      .get<Profile>("/api/v1/profile")
      .then((p) => {
        setProfile(p);
        setPhone(p.phone || "");
      })
      .catch((e) => setError(e?.message || "Failed to load profile."));
  }, []);

  React.useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profile) return <LoadingState rows={3} />;

  async function savePhone() {
    setSaving(true);
    setPhoneError(null);
    try {
      await api.patch("/api/v1/profile", { phone: phone.trim() });
      setPhoneOpen(false);
      load();
    } catch (e) {
      setPhoneError(e instanceof ApiClientError ? e.message : "Update failed.");
    } finally {
      setSaving(false);
    }
  }

  async function changePassword() {
    setPwdSaving(true);
    setPwdError(null);
    try {
      await api.post("/api/v1/profile/password", { currentPassword, newPassword });
      setPwdOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      reload();
      alert("Password changed successfully.");
    } catch (e) {
      setPwdError(e instanceof ApiClientError ? e.message : "Password change failed.");
    } finally {
      setPwdSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">Your identity on the central platform.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground" aria-hidden>
                {profile.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold">{profile.name}</h2>
                  <RoleBadge role={profile.role} />
                  <StatusBadge status={profile.status} />
                </div>
                <p className="font-mono text-sm text-muted-foreground">{profile.officerId}</p>
              </div>
            </div>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Email</dt>
                <dd className="font-medium">{profile.email}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Phone</dt>
                <dd className="flex items-center gap-2 font-medium">
                  {profile.phone || "—"}
                  <button
                    className="text-xs font-normal text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => setPhoneOpen(true)}
                  >
                    Edit
                  </button>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Designation</dt>
                <dd className="font-medium">{profile.designation}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last login</dt>
                <dd className="font-medium">{profile.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString() : "Never"}</dd>
              </div>
            </dl>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setPwdOpen(true)}>Change password</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Department</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-3">
              <DepartmentLogo logoPath={profile.department.logoPath} name={profile.department.name} size={44} />
              <div className="min-w-0">
                <p className="truncate font-medium">{profile.department.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{profile.department.departmentCode}</p>
              </div>
            </div>
            <GeographicBreadcrumb
              country={profile.department.geography.country}
              state={profile.department.geography.state}
              district={profile.department.geography.district}
              city={profile.department.geography.city}
            />
          </CardContent>
        </Card>
      </div>

      <Dialog open={phoneOpen} onOpenChange={setPhoneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit phone number</DialogTitle>
            <DialogDescription>Only the phone number is self-editable. Other identity fields are managed by your administrator.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="phone-edit">Phone</Label>
            <Input id="phone-edit" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91-…" />
            {phoneError && <p className="text-sm text-destructive" role="alert">{phoneError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPhoneOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={savePhone} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pwdOpen} onOpenChange={setPwdOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>Minimum 8 characters with at least one letter and one number.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pwd-current">Current password</Label>
              <Input id="pwd-current" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pwd-new">New password</Label>
              <Input id="pwd-new" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
            </div>
            {pwdError && <p className="text-sm text-destructive" role="alert">{pwdError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdOpen(false)} disabled={pwdSaving}>Cancel</Button>
            <Button onClick={changePassword} disabled={pwdSaving || newPassword.length < 8}>
              {pwdSaving ? "Changing…" : "Change password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

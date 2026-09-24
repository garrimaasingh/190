"use client";

import * as React from "react";
import { AuthProvider, useAuth } from "@/lib/client/store";
import { AppShell, type ViewKey } from "@/components/platform/AppShell";
import { LoginView } from "@/components/platform/views/LoginView";
import { DashboardView } from "@/components/platform/views/DashboardView";
import { DepartmentsView } from "@/components/platform/views/DepartmentsView";
import { DepartmentRegisterView } from "@/components/platform/views/DepartmentRegisterView";
import { DepartmentProfileView } from "@/components/platform/views/DepartmentProfileView";
import { OfficersView } from "@/components/platform/views/OfficersView";
import { OfficerDetailView } from "@/components/platform/views/OfficerDetailView";
import { ProfileView } from "@/components/platform/views/ProfileView";
import { SettingsView } from "@/components/platform/views/SettingsView";
import { OrganizationView } from "@/components/platform/views/OrganizationView";
import { EventsView } from "@/components/platform/views/EventsView";
import { CasesView } from "@/components/platform/views/CasesView";
import { CaseCreateView } from "@/components/platform/views/CaseCreateView";
import { CaseDashboardView } from "@/components/platform/views/CaseDashboardView";
import { DocumentUploadView, type RelatedWorkflow } from "@/components/platform/views/DocumentUploadView";
import { DocumentDetailsView } from "@/components/platform/views/DocumentDetailsView";
import { DocumentViewerView } from "@/components/platform/views/DocumentViewerView";
import { EvidenceRegisterView } from "@/components/platform/views/EvidenceRegisterView";
import { EvidenceDetailsView } from "@/components/platform/views/EvidenceDetailsView";
import { AuditView, AuditDetailView } from "@/components/platform/views/AuditView";
import { AuditIntegrityView } from "@/components/platform/views/AuditIntegrityView";
import { ReportsView } from "@/components/platform/views/ReportsView";
import { LoadingState, ErrorState } from "@/components/platform/common";
import { ShieldAlert } from "lucide-react";

// ============================================================
// Central Justice Platform — Phase 1 SPA shell.
// The sandbox exposes a single route (/); navigation between
// Phase 1 screens is state-driven below. Route guards are UI
// courtesy only — every API is authorization-enforced server-side.
// ============================================================

interface Navigation {
  view: ViewKey;
  departmentId?: string;
  officerId?: string;
  caseId?: string;
  documentId?: string;
  evidenceId?: string;
  eventId?: string;
  documentMode?: "details" | "view";
  relatedWorkflow?: RelatedWorkflow;
}
function AccessDenied({ what }: { what: string }) {
  return (
    <ErrorState
      message={`Access denied — your role is not authorized to view ${what}.`}
    />
  );
}

function Shell() {
  const { status, me, meta } = useAuth();
  const [nav, setNav] = React.useState<Navigation>({ view: "dashboard" });

  // Signed-out users must never land on the previous session's view
  // after signing in again — reset navigation when anonymous.
  React.useEffect(() => {
    if (status === "anonymous") setNav({ view: "dashboard" });
  }, [status]);

  function navigate(view: ViewKey) {
    setNav({ view });
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md">
          <LoadingState rows={3} />
        </div>
      </div>
    );
  }

  if (status === "anonymous" || !me) {
    return <LoginView />;
  }

  // --- UI-level guards (backend re-checks every API call) ---
  const role = me.officer.role;
  let content: React.ReactNode;

  switch (nav.view) {
    case "dashboard":
      content = <DashboardView onNavigate={navigate} />;
      break;
    case "cases":
      content = (
        <CasesView
          onOpenCase={(caseId) => setNav({ view: "case-detail", caseId })}
          onCreateCase={() => navigate("case-create")}
        />
      );
      break;
    case "case-create":
      content =
        role === "AUDITOR" ? (
          <AccessDenied what="case creation" />
        ) : (
          <CaseCreateView onCreated={(caseId) => setNav({ view: "case-detail", caseId })} />
        );
      break;
    case "case-detail":
      content = nav.caseId ? (
        <CaseDashboardView
          caseRef={nav.caseId}
          onBack={() => navigate("cases")}
          onUploadDocument={() => setNav({ view: "case-document-upload", caseId: nav.caseId })}
          onOpenDocument={(documentId, mode) =>
            setNav({ view: mode === "view" ? "case-document-view" : "case-document-detail", caseId: nav.caseId, documentId, documentMode: mode })
          }
          onRegisterEvidence={() => setNav({ view: "case-evidence-register", caseId: nav.caseId })}
          onOpenEvidence={(evidenceId) => setNav({ view: "case-evidence-detail", caseId: nav.caseId, evidenceId })}
        />
      ) : (
        <AccessDenied what="this page" />
      );
      break;
    case "case-document-upload":
      content = nav.caseId ? (
        <DocumentUploadView
          caseRef={nav.caseId}
          meta={meta}
          workflow={nav.relatedWorkflow ?? null}
          targetDocumentId={nav.documentId ?? null}
          onCommitted={(documentId, mode) =>
            setNav({ view: mode === "view" ? "case-document-view" : "case-document-detail", caseId: nav.caseId, documentId })
          }
          onBack={() => setNav(nav.documentId ? { view: "case-document-detail", caseId: nav.caseId, documentId: nav.documentId } : { view: "case-detail", caseId: nav.caseId })}
        />
      ) : (
        <AccessDenied what="document upload" />
      );
      break;
    case "case-document-detail":
      content = nav.caseId && nav.documentId ? (
        <DocumentDetailsView
          caseRef={nav.caseId}
          documentId={nav.documentId}
          meta={meta}
          onBack={() => setNav({ view: "case-detail", caseId: nav.caseId })}
          onOpenDocument={(documentId, mode) =>
            setNav({ view: mode === "view" ? "case-document-view" : "case-document-detail", caseId: nav.caseId, documentId, documentMode: mode })
          }
          onStartRelated={(workflow) => setNav({ view: "case-document-upload", caseId: nav.caseId, documentId: nav.documentId, relatedWorkflow: workflow })}
          onView={() => setNav({ view: "case-document-view", caseId: nav.caseId, documentId: nav.documentId })}
        />
      ) : (
        <AccessDenied what="this page" />
      );
      break;
    case "case-document-view":
      content = nav.caseId && nav.documentId ? (
        <DocumentViewerView
          caseRef={nav.caseId}
          documentId={nav.documentId}
          onBack={() => setNav({ view: nav.documentMode === "details" ? "case-document-detail" : "case-detail", caseId: nav.caseId, documentId: nav.documentId })}
          onDetails={() => setNav({ view: "case-document-detail", caseId: nav.caseId, documentId: nav.documentId })}
        />
      ) : (
        <AccessDenied what="this page" />
      );
      break;
    case "organization":
      content =
        role === "AUDITOR" ? (
          <AccessDenied what="the organization explorer" />
        ) : (
          <OrganizationView
            onOpenDepartment={(id) => setNav({ view: "department-profile", departmentId: id })}
          />
        );
      break;
    case "departments":
      content =
        role === "OFFICER" || role === "DEPARTMENT_ADMIN" ? (
          <AccessDenied what="the department directory" />
        ) : (
          <DepartmentsView
            onOpenDepartment={(id) => setNav({ view: "department-profile", departmentId: id })}
            onRegister={() => navigate("department-register")}
          />
        );
      break;
    case "department-register":
      content =
        role === "SYSTEM_ADMIN" ? (
          <DepartmentRegisterView onRegistered={(id) => setNav({ view: "department-profile", departmentId: id })} />
        ) : (
          <AccessDenied what="department registration" />
        );
      break;
    case "department-profile":
      content =
        role === "AUDITOR" && !nav.departmentId ? (
          <AccessDenied what="department profiles" />
        ) : (
          <DepartmentProfileView key={nav.departmentId || "own"} departmentId={nav.departmentId} />
        );
      break;
    case "officers":
      content =
        role === "OFFICER" ? (
          <AccessDenied what="officer management" />
        ) : (
          <OfficersView
            departmentId={role === "DEPARTMENT_ADMIN" ? me.department?.id : undefined}
            onOpenOfficer={(id) => setNav({ view: "officer-detail", officerId: id })}
            onNavigate={navigate}
          />
        );
      break;
    case "officer-detail":
      content =
        role === "OFFICER" ? (
          <AccessDenied what="officer profiles" />
        ) : nav.officerId ? (
          <OfficerDetailView officerId={nav.officerId} onBack={() => navigate("officers")} />
        ) : (
          <AccessDenied what="this page" />
        );
      break;
    case "profile":
      content = <ProfileView />;
      break;
    case "settings":
      content = <SettingsView />;
      break;
    case "events":
      content =
        role === "DEPARTMENT_ADMIN" || role === "OFFICER" ? (
          <AccessDenied what="the identity event ledger" />
        ) : (
          <EventsView />
        );
      break;
    case "case-evidence-register":
      content =
        role === "AUDITOR" ? (
          <AccessDenied what="evidence registration" />
        ) : nav.caseId ? (
          <EvidenceRegisterView
            caseRef={nav.caseId}
            meta={meta}
            onRegistered={(evidenceId) => setNav({ view: "case-evidence-detail", caseId: nav.caseId, evidenceId })}
            onBack={() => setNav({ view: "case-detail", caseId: nav.caseId })}
          />
        ) : (
          <AccessDenied what="this page" />
        );
      break;
    case "case-evidence-detail":
      content = nav.caseId && nav.evidenceId ? (
        <EvidenceDetailsView
          caseRef={nav.caseId}
          evidenceId={nav.evidenceId}
          meta={meta}
          onBack={() => setNav({ view: "case-detail", caseId: nav.caseId })}
          onOpenDocument={(documentId, mode) =>
            setNav({ view: mode === "view" ? "case-document-view" : "case-document-detail", caseId: nav.caseId, documentId, documentMode: mode })
          }
        />
      ) : (
        <AccessDenied what="this page" />
      );
      break;
    case "audit":
      content =
        role === "DEPARTMENT_ADMIN" || role === "OFFICER" ? (
          <AccessDenied what="the audit ledger" />
        ) : (
          <AuditView
            meta={meta}
            onOpenEvent={(eventId) => setNav({ view: "audit-detail", eventId })}
            onOpenIntegrity={() => navigate("audit-integrity")}
          />
        );
      break;
    case "audit-detail":
      content =
        role === "DEPARTMENT_ADMIN" || role === "OFFICER" ? (
          <AccessDenied what="the audit ledger" />
        ) : nav.eventId ? (
          <AuditDetailView eventId={nav.eventId} onBack={() => navigate("audit")} />
        ) : (
          <AccessDenied what="this page" />
        );
      break;
    case "audit-integrity":
      content =
        role === "DEPARTMENT_ADMIN" || role === "OFFICER" ? (
          <AccessDenied what="audit integrity" />
        ) : (
          <AuditIntegrityView />
        );
      break;
    case "reports":
      content =
        role === "OFFICER" ? (
          <AccessDenied what="report generation" />
        ) : (
          <ReportsView />
        );
      break;
    default:
      content = <DashboardView onNavigate={navigate} />;
  }

  return (
    <AppShell view={nav.view} onNavigate={navigate}>
      {content}
    </AppShell>
  );
}

export default function Home() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

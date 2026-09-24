import { handleApiError, jsonOk } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  DEPARTMENT_TYPES,
  DEPARTMENT_STATUSES,
  OFFICER_ROLES,
  OFFICER_STATUSES,
  OFFICER_STATUS_TRANSITIONS,
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_STATUSES,
  CASE_STATUS_TRANSITIONS,
  PARTICIPATION_TYPES,
  CASE_OFFICER_ROLES,
  CASE_OFFICER_STATUSES,
  TRANSFER_STATUSES,
  CASE_EVENT_TYPES,
  DOCUMENT_TYPES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_CLASSIFICATION_NOTES,
  DOCUMENT_CLASSIFICATION_CEILING,
  DOCUMENT_STATUSES,
  DOCUMENT_RELATIONSHIP_TYPES,
  DOCUMENT_EVENT_TYPES,
  DOCUMENT_ALLOWED_EXTENSIONS,
  DOCUMENT_MAX_SIZE_MB,
  EVIDENCE_TYPES,
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_STATUSES,
  EVIDENCE_STATUS_TRANSITIONS,
  EVIDENCE_CLASSIFICATIONS,
  EVIDENCE_CLASSIFICATION_NOTES,
  EVIDENCE_RELATIONSHIP_TYPES,
  EVIDENCE_RELATIONSHIP_NOTES,
  AUDIT_EVENT_TYPES,
  AUDIT_EVENT_CATEGORIES,
  LEDGER_ADAPTERS,
  // Phase 5
  AI_JOB_TYPES,
  AI_JOB_STATUSES,
  AI_ENTITY_TYPES,
  AI_SUMMARY_TYPES,
  AI_TIMELINE_EVENT_TYPES,
  AI_MODEL_TASKS,
  AI_LANGUAGES,
  AI_LANGUAGE_LABELS,
  DOCUMENT_AI_STATUSES,
  AI_REVIEWABLE_RESULT_TYPES,
  AI_AUDIT_EVENT_TYPES,
  LEDGER_ACTIVE_ADAPTER,
} from "@/lib/constants";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export const runtime = "nodejs";

// GET /api/v1/meta — controlled reference/enumeration data (spec §6/§13).
// The frontend loads these from the API and never hard-codes them.
export async function GET(req: Request) {
  try {
    await requirePermission(req, PERMISSIONS.PROFILE_READ);
    return jsonOk({
      departmentTypes: DEPARTMENT_TYPES,
      departmentStatuses: DEPARTMENT_STATUSES,
      officerRoles: OFFICER_ROLES,
      officerStatuses: OFFICER_STATUSES,
      officerStatusTransitions: OFFICER_STATUS_TRANSITIONS,
      rolePermissions: ROLE_PERMISSIONS,
      // Phase 2 — case reference data (spec §6/§7/§8/§12/§13/§19)
      caseTypes: CASE_TYPES,
      casePriorities: CASE_PRIORITIES,
      caseStatuses: CASE_STATUSES,
      caseStatusTransitions: CASE_STATUS_TRANSITIONS,
      participationTypes: PARTICIPATION_TYPES,
      caseOfficerRoles: CASE_OFFICER_ROLES,
      caseOfficerStatuses: CASE_OFFICER_STATUSES,
      transferStatuses: TRANSFER_STATUSES,
      caseEventTypes: CASE_EVENT_TYPES,
      // Phase 3 — document reference data (spec §6/§7/§8/§9/§13/§54)
      documentTypes: DOCUMENT_TYPES,
      documentCategories: DOCUMENT_CATEGORIES,
      documentClassifications: DOCUMENT_CLASSIFICATIONS,
      documentClassificationNotes: DOCUMENT_CLASSIFICATION_NOTES,
      documentClassificationCeiling: DOCUMENT_CLASSIFICATION_CEILING,
      documentStatuses: DOCUMENT_STATUSES,
      documentRelationshipTypes: DOCUMENT_RELATIONSHIP_TYPES,
      documentEventTypes: DOCUMENT_EVENT_TYPES,
      documents: {
        maxSizeMb: DOCUMENT_MAX_SIZE_MB,
        allowedExtensions: Object.keys(DOCUMENT_ALLOWED_EXTENSIONS),
      },
      // Phase 4 — evidence & audit reference data (spec §6-§9/§20/§33/§60)
      evidenceTypes: EVIDENCE_TYPES,
      evidenceSourceTypes: EVIDENCE_SOURCE_TYPES,
      evidenceStatuses: EVIDENCE_STATUSES,
      evidenceStatusTransitions: EVIDENCE_STATUS_TRANSITIONS,
      evidenceClassifications: EVIDENCE_CLASSIFICATIONS,
      evidenceClassificationNotes: EVIDENCE_CLASSIFICATION_NOTES,
      evidenceRelationshipTypes: EVIDENCE_RELATIONSHIP_TYPES,
      evidenceRelationshipNotes: EVIDENCE_RELATIONSHIP_NOTES,
      auditEventTypes: AUDIT_EVENT_TYPES,
      auditEventCategories: AUDIT_EVENT_CATEGORIES,
      ledgerAdapters: LEDGER_ADAPTERS,
      ledgerActiveAdapter: LEDGER_ACTIVE_ADAPTER,
      // Phase 5 — AI reference data (spec §5/§10/§11/§14/§17/§28/§39)
      aiJobTypes: AI_JOB_TYPES,
      aiJobStatuses: AI_JOB_STATUSES,
      aiEntityTypes: AI_ENTITY_TYPES,
      aiSummaryTypes: AI_SUMMARY_TYPES,
      aiTimelineEventTypes: AI_TIMELINE_EVENT_TYPES,
      aiModelTasks: AI_MODEL_TASKS,
      aiLanguages: AI_LANGUAGES,
      aiLanguageLabels: AI_LANGUAGE_LABELS,
      documentAiStatuses: DOCUMENT_AI_STATUSES,
      aiReviewableResultTypes: AI_REVIEWABLE_RESULT_TYPES,
      aiAuditEventTypes: AI_AUDIT_EVENT_TYPES,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

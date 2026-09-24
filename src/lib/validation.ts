import { z } from "zod";
import {
  DEPARTMENT_TYPES,
  OFFICER_ROLES,
  PASSWORD_MIN_LENGTH,
  CASE_TYPES,
  CASE_PRIORITIES,
  CASE_OFFICER_ROLES,
  CASE_TITLE_MAX_LENGTH,
  CASE_DESCRIPTION_MAX_LENGTH,
  CASE_NUMBER_MAX_LENGTH,
  DOCUMENT_TYPES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_TITLE_MAX_LENGTH,
  DOCUMENT_DESCRIPTION_MAX_LENGTH,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  DOCUMENT_TAG_MAX_LENGTH,
  DOCUMENT_TAGS_MAX_COUNT,
  EVIDENCE_TYPES,
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_CLASSIFICATIONS,
  EVIDENCE_TITLE_MAX_LENGTH,
  EVIDENCE_DESCRIPTION_MAX_LENGTH,
  EVIDENCE_LOCATION_MAX_LENGTH,
  EVIDENCE_NOTES_MAX_LENGTH,
  EVIDENCE_CATEGORY_MAX_LENGTH,
  EVIDENCE_NUMBER_MAX_LENGTH,
  EVIDENCE_SOURCE_REFERENCE_MAX_LENGTH,
  EVIDENCE_CONDITION_MAX_LENGTH,
  EVIDENCE_RELATIONSHIP_TYPES,
} from "@/lib/constants";

// ============================================================
// Request validation schemas (Pydantic-equivalent layer).
// Every mutating endpoint validates its payload here before
// touching the database.
// ============================================================

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(128)
  .regex(/[A-Za-z]/, "Password must contain a letter.")
  .regex(/[0-9]/, "Password must contain a number.");

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required."),
  password: z.string().min(1, "Password is required.").max(128),
});

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(2, "Department name is required.").max(160),
  departmentType: z.enum(DEPARTMENT_TYPES),
  stateId: z.string().min(1, "State is required."),
  districtId: z.string().min(1, "District is required."),
  cityId: z.string().min(1, "City is required."),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const updateDepartmentStatusSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

export const createOfficerSchema = z.object({
  name: z.string().trim().min(2, "Name is required.").max(120),
  email: z.string().trim().toLowerCase().email("A valid email is required."),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{6,18}$/, "Phone must be 6-18 digits and may include + or -.")
    .optional()
    .or(z.literal("")),
  designation: z.string().trim().min(2, "Designation is required.").max(120),
  role: z.enum(OFFICER_ROLES),
  password: passwordSchema,
  status: z.enum(["ACTIVE", "PENDING"]).optional().default("ACTIVE"),
});

export const updateOfficerSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{6,18}$/, "Phone must be 6-18 digits and may include + or -.")
    .optional()
    .or(z.literal("")),
  designation: z.string().trim().min(2).max(120).optional(),
  role: z.enum(OFFICER_ROLES).optional(),
});

export const updateOfficerStatusSchema = z.object({
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "INACTIVE"]),
});

export const updateProfileSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{6,18}$/, "Phone must be 6-18 digits and may include + or -.")
    .optional()
    .or(z.literal("")),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required.").max(128),
  newPassword: passwordSchema,
});

export const createStateSchema = z.object({
  countryId: z.string().min(1, "Country is required."),
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, "Code must be 1-6 letters/digits."),
});

export const createDistrictSchema = z.object({
  stateId: z.string().min(1, "State is required."),
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, "Code must be 1-6 letters/digits."),
});

export const createCitySchema = z.object({
  districtId: z.string().min(1, "District is required."),
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, "Code must be 1-6 letters/digits."),
});

export const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  stateId: z.string().optional(),
  districtId: z.string().optional(),
  cityId: z.string().optional(),
  departmentType: z.string().optional(),
  status: z.string().optional(),
  role: z.string().optional(),
  departmentId: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

// ============================================================
// PHASE 2 — Case schemas (spec §15/§17/§32).
// NOTE: no created_by / department / custodian / status fields are
// accepted from the client — they are derived server-side.
// ============================================================

const caseNumberSchema = z
  .string()
  .trim()
  .max(CASE_NUMBER_MAX_LENGTH, `Case number must be at most ${CASE_NUMBER_MAX_LENGTH} characters.`)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 \-_/.]*$/,
    "Case number may contain letters, digits, spaces and - _ / . only."
  )
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined));

export const createCaseSchema = z.object({
  title: z
    .string()
    .trim()
    .min(4, "Case title is required (min 4 characters).")
    .max(CASE_TITLE_MAX_LENGTH, `Title must be at most ${CASE_TITLE_MAX_LENGTH} characters.`),
  caseNumber: caseNumberSchema,
  description: z
    .string()
    .trim()
    .max(CASE_DESCRIPTION_MAX_LENGTH)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  caseType: z.enum(CASE_TYPES),
  caseCategory: z.string().trim().max(80).optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
  priority: z.enum(CASE_PRIORITIES),
  stateId: z.string().min(1, "State is required."),
  districtId: z.string().min(1, "District is required."),
  cityId: z.string().min(1, "City is required."),
});

export const updateCaseSchema = z.object({
  title: z.string().trim().min(4).max(CASE_TITLE_MAX_LENGTH).optional(),
  caseNumber: caseNumberSchema,
  description: z.string().trim().max(CASE_DESCRIPTION_MAX_LENGTH).optional().or(z.literal("")),
  caseCategory: z.string().trim().max(80).optional().or(z.literal("")),
  priority: z.enum(CASE_PRIORITIES).optional(),
});

export const updateCaseStatusSchema = z.object({
  status: z.string().min(1, "Status is required."),
});

export const caseListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  caseType: z.string().optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  custodianDepartmentId: z.string().optional(),
  originatingDepartmentId: z.string().optional(),
  stateId: z.string().optional(),
  districtId: z.string().optional(),
  cityId: z.string().optional(),
  createdFrom: z.string().trim().optional(),
  createdTo: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

export const addCaseOfficerSchema = z.object({
  officerId: z.string().min(1, "Officer is required."),
  roleOnCase: z.enum(CASE_OFFICER_ROLES),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

export const updateCaseOfficerSchema = z.object({
  roleOnCase: z.enum(CASE_OFFICER_ROLES).optional(),
});

export const addCaseDepartmentSchema = z.object({
  departmentId: z.string().min(1, "Department is required."),
  participationType: z.enum(["PARTICIPATING", "CONSULTED"]).default("PARTICIPATING"),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

export const createTransferSchema = z.object({
  toDepartmentId: z.string().min(1, "Destination department is required."),
  toOfficerId: z.string().optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
  reason: z.string().trim().min(4, "A reason is required for the custody transfer.").max(1000),
  transferNotes: z.string().trim().max(2000).optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
});

// ============================================================
// PHASE 3 — document metadata schemas (spec §27/§72).
// Server-controlled fields (uploadedByOfficerId, sha256Hash,
// storageKey, committedAt, status) are NOT part of any client
// schema — .strict() rejects client attempts to smuggle them.
// FormData is parsed field-by-field in the route; the schema here
// validates the resulting object.
// ============================================================

const documentTagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(DOCUMENT_TAG_MAX_LENGTH)
      .regex(/^[^<>{}"']*$/, "Tags may not contain HTML or quote characters.")
  )
  .max(DOCUMENT_TAGS_MAX_COUNT, `At most ${DOCUMENT_TAGS_MAX_COUNT} tags are allowed.`)
  .optional();

const documentMetadataBlock = z.object({
  referenceNumber: z.string().trim().max(DOCUMENT_REFERENCE_MAX_LENGTH).optional().or(z.literal("")),
  issuingDepartmentName: z.string().trim().max(160).optional().or(z.literal("")),
  externalReference: z.string().trim().max(DOCUMENT_REFERENCE_MAX_LENGTH).optional().or(z.literal("")),
  tags: documentTagsSchema,
});

export const documentUploadSchema = documentMetadataBlock
  .extend({
    title: z.string().trim().min(2, "Document title is required.").max(DOCUMENT_TITLE_MAX_LENGTH),
    description: z.string().trim().max(DOCUMENT_DESCRIPTION_MAX_LENGTH).optional().or(z.literal("")),
    documentType: z.enum(DOCUMENT_TYPES),
    documentCategory: z.enum(DOCUMENT_CATEGORIES).optional().or(z.literal("")),
    classification: z.enum(DOCUMENT_CLASSIFICATIONS),
    documentDate: z.coerce.date().optional(),
    // Idempotency key (spec §68) — opaque, length-bounded, never interpreted.
    clientRequestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{8,100}$/, "clientRequestId must be 8-100 URL-safe characters.")
      .optional(),
  })
  .strict();

export const documentRelationshipSchema = z
  .object({
    targetDocumentId: z.string().trim().min(4).max(60),
    relationshipType: z.enum(["RELATED", "REFERENCE"]),
  })
  .strict();

export const documentListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  type: z.string().optional(),
  classification: z.string().optional(),
  status: z.string().optional(),
  departmentId: z.string().optional(),
  uploadedBy: z.string().optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

// ============================================================
// PHASE 4 — evidence schemas (spec §5/§10/§38).
// Server-controlled fields (registeredByOfficerId, sha256Hash,
// storageKey, status, committedAt, currentCustodian*) are NOT part
// of any client schema — .strict() rejects smuggling attempts.
// The registering actor and custodian are derived server-side.
// ============================================================

// Optional device/acquisition metadata (spec §10): bounded keys,
// string values — explicitly NOT claimed available for every type.
const evidenceDeviceMetadataSchema = z
  .record(z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9 _.-]+$/), z.string().trim().max(200).regex(/^[^<>{}"']*$/))
  .refine((obj) => Object.keys(obj).length <= 12, "At most 12 device metadata entries.")
  .optional();

export const evidenceRegisterSchema = z
  .object({
    title: z.string().trim().min(2, "Evidence title is required.").max(EVIDENCE_TITLE_MAX_LENGTH),
    description: z.string().trim().max(EVIDENCE_DESCRIPTION_MAX_LENGTH).optional().or(z.literal("")),
    evidenceType: z.enum(EVIDENCE_TYPES),
    category: z.string().trim().max(EVIDENCE_CATEGORY_MAX_LENGTH).optional().or(z.literal("")),
    classification: z.enum(EVIDENCE_CLASSIFICATIONS),
    sourceType: z.enum(EVIDENCE_SOURCE_TYPES),
    sourceReference: z.string().trim().max(EVIDENCE_SOURCE_REFERENCE_MAX_LENGTH).optional().or(z.literal("")),
    collectionLocation: z.string().trim().max(EVIDENCE_LOCATION_MAX_LENGTH).optional().or(z.literal("")),
    collectedAt: z.coerce.date().optional(),
    collectedByOfficerId: z.string().trim().max(60).optional().or(z.literal("")),
    condition: z.string().trim().max(EVIDENCE_CONDITION_MAX_LENGTH).optional().or(z.literal("")),
    notes: z.string().trim().max(EVIDENCE_NOTES_MAX_LENGTH).optional().or(z.literal("")),
    evidenceNumber: z.string().trim().max(EVIDENCE_NUMBER_MAX_LENGTH).optional().or(z.literal("")),
    deviceMetadata: evidenceDeviceMetadataSchema,
  })
  .strict();

export const evidenceStatusChangeSchema = z
  .object({
    status: z.enum(["REGISTERED", "COLLECTED", "IN_CUSTODY", "UNDER_EXAMINATION", "RETURNED", "RELEASED", "ARCHIVED"]),
    reason: z.string().trim().max(EVIDENCE_NOTES_MAX_LENGTH).optional().or(z.literal("")),
  })
  .strict();

export const evidenceTransferCreateSchema = z
  .object({
    toDepartmentId: z.string().trim().min(1),
    toOfficerId: z.string().trim().optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
    reason: z.string().trim().min(4, "A reason is required for the evidence transfer.").max(1000),
    notes: z.string().trim().max(2000).optional().or(z.literal("")).transform((v) => (v ? v : undefined)),
  })
  .strict();

export const evidenceTransferDecisionSchema = z
  .object({
    action: z.enum(["ACCEPT", "REJECT", "CANCEL"]),
  })
  .strict();

export const evidenceRelationshipSchema = z
  .object({
    documentId: z.string().trim().min(4).max(60),
    relationshipType: z.enum(EVIDENCE_RELATIONSHIP_TYPES),
    note: z.string().trim().max(300).optional().or(z.literal("")),
  })
  .strict();

export const evidenceListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  type: z.string().optional(),
  classification: z.string().optional(),
  status: z.string().optional(),
  custodianDepartmentId: z.string().optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const auditSearchQuerySchema = z.object({
  q: z.string().trim().max(120).optional(), // free-text over event id / case / doc / evidence ids
  eventId: z.string().trim().max(60).optional(),
  eventType: z.string().optional(),
  category: z.string().optional(),
  caseId: z.string().trim().max(60).optional(),
  documentId: z.string().trim().max(60).optional(),
  evidenceId: z.string().trim().max(60).optional(),
  actorOfficerId: z.string().trim().max(60).optional(),
  departmentId: z.string().trim().max(60).optional(),
  result: z.string().optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

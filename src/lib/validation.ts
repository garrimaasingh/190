import { z } from "zod";
import {
  DEPARTMENT_TYPES,
  OFFICER_ROLES,
  PASSWORD_MIN_LENGTH,
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
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

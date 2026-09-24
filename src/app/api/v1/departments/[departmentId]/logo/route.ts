import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, jsonOk, ApiError } from "@/lib/api";
import { requirePermission, clientIp } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assertDepartmentScope } from "@/lib/scope";
import { validateAndStoreLogo, deleteLogo } from "@/lib/logo";
import { recordIdentityEvent, IDENTITY_EVENTS } from "@/lib/events";
import { LOGO_MAX_BYTES } from "@/lib/constants";

export const runtime = "nodejs";

// POST /api/v1/departments/{departmentId}/logo — multipart upload (spec §8/§47)
// File type is decided by magic bytes, never by client headers or filename.
export async function POST(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.LOGO_UPDATE);
    const { departmentId } = await params;

    const department = await db.department.findUnique({ where: { id: departmentId } });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");

    assertDepartmentScope(ctx, department.id);

    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data")) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected multipart/form-data upload.");
    }

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > LOGO_MAX_BYTES + 64 * 1024) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Logo exceeds the 2 MB size limit.");
    }

    const form = await req.formData();
    const file = form.get("logo");
    if (!(file instanceof File)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Logo file is required.");
    }

    const stored = await validateAndStoreLogo(file);

    // Replace: remove previous stored file after successful write
    const previous = department.logoPath;
    const updated = await db.department.update({
      where: { id: department.id },
      data: { logoPath: stored.fileId, logoMime: stored.mime },
    });
    if (previous) await deleteLogo(previous);

    await recordIdentityEvent({
      eventType: IDENTITY_EVENTS.DEPARTMENT_LOGO_UPDATED,
      actorOfficerId: ctx.officer.id,
      departmentId: department.id,
      targetType: "DEPARTMENT_LOGO",
      targetId: department.id,
      metadata: { fileId: stored.fileId, originalSize: file.size },
      ipAddress: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    return jsonOk({ logoPath: updated.logoPath, logoMime: updated.logoMime }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE /api/v1/departments/{departmentId}/logo
export async function DELETE(req: Request, { params }: { params: Promise<{ departmentId: string }> }) {
  try {
    const ctx = await requirePermission(req, PERMISSIONS.LOGO_UPDATE);
    const { departmentId } = await params;

    const department = await db.department.findUnique({ where: { id: departmentId } });
    if (!department) throw new ApiError(404, "NOT_FOUND", "Department not found.");

    assertDepartmentScope(ctx, department.id);

    if (department.logoPath) await deleteLogo(department.logoPath);
    await db.department.update({
      where: { id: department.id },
      data: { logoPath: null, logoMime: null },
    });

    return jsonOk({ removed: true });
  } catch (err) {
    return handleApiError(err);
  }
}

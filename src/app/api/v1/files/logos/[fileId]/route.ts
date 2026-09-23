import { readLogo } from "@/lib/logo";

export const runtime = "nodejs";

// GET /api/v1/files/logos/{fileId}
// Controlled logo serving: the file id must match the server-
// generated UUID pattern; arbitrary filesystem paths are never
// accepted. Responses are immutable-cacheable.
export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const data = await readLogo(fileId);
  if (!data) {
    return new NextResponse404();
  }
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// small helper to keep the handler tidy
class NextResponse404 extends Response {
  constructor() {
    super(JSON.stringify({ error: { code: "NOT_FOUND", message: "File not found." } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** Quick unit smoke of the Phase 9 package format + zip layer. */
import { buildPackage, parsePackage, canonicalize, canonicalSha256, ZipFormatError } from "../src/lib/interop/package-format";
import { buildZip, readZipSecure, normalizePackagePath, sha256Hex } from "../src/lib/interop/zip";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log("PASS", name);
  } catch (err) {
    failures++;
    console.log("FAIL", name, "-", err instanceof Error ? err.message.slice(0, 160) : err);
  }
}

const draft = {
  manifest: {
    package_type: "FULL_CASE_EXPORT" as const,
    schema_version: "1.0",
    created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
    created_by: "OFF-MP-IND-00001",
    source_system: "Central Case Platform",
    source_department: "Indore Police",
    case_count: 1,
    document_count: 1,
    evidence_count: 1,
    relationship_count: 1,
    integrity_algorithm: "SHA-256" as const,
    integrity_manifest_reference: "integrity.json" as const,
  },
  metadata: { case_reference: "CASE-MP-IND-2026-000001", classification: "RESTRICTED" },
  case: {
    case_id: "CASE-MP-IND-2026-000001",
    title: "Demo case",
    case_type: "THEFT",
    priority: "HIGH",
    status: "OPEN",
  },
  documents: [
    {
      payload: {
        document_id: "DOC-MP-IND-2026-000001",
        case_id: "CASE-MP-IND-2026-000001",
        title: "FIR",
        document_type: "FIR",
        classification: "RESTRICTED",
        original_filename: "fir.pdf",
        mime_type: "application/pdf",
        size: 5,
        sha256: sha256Hex(Buffer.from("hello")),
        has_binary: false,
      },
      binary: Buffer.from("hello"),
    },
  ],
  evidence: [
    {
      payload: {
        evidence_id: "EVD-MP-IND-2026-000001",
        case_id: "CASE-MP-IND-2026-000001",
        title: "Knife",
        evidence_type: "PHYSICAL",
        classification: "RESTRICTED",
        status: "IN_CUSTODY",
        has_binary: false,
        custody_history_available: false,
      },
      binary: undefined,
    },
  ],
  relationships: [
    {
      relationship_id: "rel-1",
      source_type: "DOCUMENT" as const,
      source_id: "DOC-MP-IND-2026-000001",
      target_type: "EVIDENCE" as const,
      target_id: "EVD-MP-IND-2026-000001",
      relationship_type: "RELATED",
      provenance: "AUTHORITATIVE_IMPORT" as const,
    },
  ],
};

check("canonicalize is sorted + stable", () => {
  const a = canonicalize({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
  const b = canonicalize({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
  if (a !== b) throw new Error("canonical forms differ");
  if (canonicalSha256({ x: 1 }) !== canonicalSha256({ x: 1 })) throw new Error("unstable hash");
});

check("build → parse round-trip verifies integrity", () => {
  const built = buildPackage(draft);
  if (built.rawArchiveSha256.length !== 64) throw new Error("bad raw hash");
  const parsed = parsePackage(built.zip);
  if (parsed.manifest.document_count !== 1 || parsed.documents.length !== 1) throw new Error("counts wrong");
  if (parsed.documents[0].binary?.toString() !== "hello") throw new Error("binary mismatch");
  if (parsed.relationships.length !== 1) throw new Error("relationships lost");
  if (parsed.integrityCanonicalSha256 !== built.integrityCanonicalSha256) throw new Error("canonical hash drift");
});

check("deterministic bytes for identical drafts", () => {
  const a = buildPackage(structuredClone(draft));
  const b = buildPackage(structuredClone(draft));
  if (!a.zip.equals(b.zip)) throw new Error("archives differ");
});

check("tampered binary (CRC recomputed by attacker) → PACKAGE_TAMPERED", () => {
  const built = buildPackage(structuredClone(draft));
  const zip = built.zip;
  // competent tamperer: flip a byte in the stored binary AND recompute both CRCs
  const idx = zip.indexOf(Buffer.from("hello"));
  zip[idx] = 0x78;
  const { crc32 } = require("../src/lib/interop/zip") as { crc32: (b: Buffer) => number };
  const dataEnd = idx + 5;
  // local header starts 30 bytes before the name; name = "documents/DOC-MP-IND-2026-000001/fir.pdf"
  const name = Buffer.from("documents/DOC-MP-IND-2026-000001/fir.pdf");
  const localOff = idx - 30 - name.length;
  const newCrc = crc32(zip.subarray(idx, dataEnd));
  zip.writeUInt32LE(newCrc, localOff + 14);
  const cdIdx = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(newCrc, cdIdx + 16);
  try {
    parsePackage(zip);
    throw new Error("should have thrown");
  } catch (err) {
    if (!(err instanceof ZipFormatError) || err.code !== "PACKAGE_TAMPERED") throw err;
  }
});

check("zip-slip path rejected", () => {
  for (const p of ["../../evil.txt", "..\\..\\evil.txt", "/etc/passwd", "C:/Windows/evil", "a/../../b", "ok/../../../x"]) {
    try {
      normalizePackagePath(p, 3);
      throw new Error(`accepted ${p}`);
    } catch (err) {
      if (!(err instanceof ZipFormatError)) throw err;
    }
  }
  if (normalizePackagePath("a/b/c.txt", 3) !== "a/b/c.txt") throw new Error("normalize broken");
});

check("archive bomb rejected before inflation (declared size)", () => {
  // craft an archive with a lying/oversized central directory entry
  const zip = buildZip([{ path: "a.txt", data: Buffer.from("real") }]);
  // patch central directory uncompressed size (offset of CD: find signature 0x02014b50)
  const cdIdx = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(0xffffffff, cdIdx + 24); // declared uncompressed = 4GB-1
  try {
    readZipSecure(zip, { maxCompressedBytes: 1e8, maxUncompressedBytes: 5e8, maxFileBytes: 5e7, maxFiles: 500, maxCompressionRatio: 200, maxDepth: 3 });
    throw new Error("should have thrown");
  } catch (err) {
    if (!(err instanceof ZipFormatError) || err.code !== "ARCHIVE_BOMB_FILE") throw err;
  }
});

check("unsupported schema version rejected", () => {
  const built = buildPackage(structuredClone(draft));
  const built2 = structuredClone(built);
  void built2;
  const m = JSON.parse(built.zip.subarray(0, 0).toString() || "{}");
  void m;
  // simpler: build a draft with bad version via manifest override
  const bad = buildPackage({ ...structuredClone(draft), manifest: { ...draft.manifest, schema_version: "9.9" } } as never);
  // patch the manifest entry data: rebuild manually
  const patched = bad.zip;
  void patched;
  // The parser reads manifest.json — easiest is to rebuild with bad version:
  const badDraft = structuredClone(draft) as typeof draft & { manifest: { schema_version: string } };
  badDraft.manifest.schema_version = "9.9";
  const pkg = buildPackage(badDraft as never);
  try {
    parsePackage(pkg.zip);
    throw new Error("should have thrown");
  } catch (err) {
    if (!(err instanceof ZipFormatError) || err.code !== "PACKAGE_SCHEMA_UNSUPPORTED") throw err;
  }
});

process.exit(failures > 0 ? 1 : 0);

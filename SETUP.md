# Justice Case Management Platform — Project Archive

Centralized security-law investigation case & document management platform.
Next.js (App Router) + TypeScript + Prisma/SQLite + Tailwind + Bun runtime.

## What is included

- Full source (`src/`), tests (`tests/`), Prisma schema (`prisma/`)
- Working SQLite database with demo data (`db/custom.db`) and uploaded evidence files (`db/uploads/`)
- Utility scripts (`scripts/`) including the regression runner
- All phases 0–9 implemented (Phase 9 = Manual Import/Export + Interoperability Fallback)

NOT included (regenerated on install): `node_modules/`, `.next/` build cache.

## Quick start

```bash
bun install          # or: npm install
bun run dev          # dev server on http://localhost:3000
```

Production:

```bash
bun run build
bun run start        # standalone server, logs to /tmp/justice-server.log
```

Database: `db/custom.db` ships pre-seeded. To rebuild from schema:
`bun run db:push` (then create accounts via the app seed, see `prisma/`).

## Demo login

- arjun.sharma@demo.gov.in / Demo@Pass1  (DEPARTMENT_ADMIN)
- Other demo accounts are selectable on the login screen.

## Tests

```bash
bun test tests/api/phase9.test.ts        # Phase 9 interop suite
bash scripts/regression-step.sh          # per-suite regression protocol
```

Last verified state: 398/398 tests across phase1–9 (see `worklog.md`).

## Notes

- Dev/start logs are written to `/tmp/justice-dev.log` and `/tmp/justice-server.log`
  (kept OUTSIDE the project root on purpose — a log inside the watched root caused
  webpack Fast-Refresh churn / full-page reload glitches; do not move them back).
- Manual import/export packages are a file-transfer FALLBACK, never a live integration.
- SHA-256 package integrity is NOT a digital signature (PackageSignatureService ships
  UNSUPPORTED by design); FileSecurityScanner is a labeled DEVELOPMENT STUB.

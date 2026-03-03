<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# scripts/ Directory - Agent Reference

## Purpose

This directory contains build and deployment scripts for native platform exports (Tauri, Capacitor). Scripts handle Next.js static export, platform-specific bundling, and SPA routing fallbacks.

## Key Files

| File | Purpose | Audience |
|------|---------|----------|
| `build-static.mjs` | Node.js script for Next.js static export to native platforms. Temporarily hides incompatible API routes and dynamic pages, runs build, and creates SPA routing fallback | DevOps, native platform builders |

## For AI Agents

### When modifying scripts in this directory:

- **Execution:** Requires bash 4+, Node.js with pnpm, Next.js v13+
- **Dependencies:** `next` package, existing `src/app/` directory structure
- **Key behavior:**
  - Backs up incompatible dirs (`src/app/api`, gallery pages)
  - Runs static export via `NEXT_OUTPUT=export next build`
  - Creates `out/gallery/index.html` fallback for SPA routing
  - Restores all files on exit (via trap)
- **Testing:** Verify static export completes and `out/` directory is created
- **Platform targets:** Tauri webview, Capacitor Android webview
- **Related:** `/project/hipago-13b1450f755b/HiPaGo/next.config.js` (must set `output: 'export'`)

### Script updates needed if:

1. Next.js incompatible directories change (check `src/app/` structure)
2. Build output location changes
3. Native platform routing requirements change
4. Node environment needs setup (pnpm, .npmrc hoisting)

<!-- MANUAL: -->

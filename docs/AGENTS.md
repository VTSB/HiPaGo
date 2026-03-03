<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# docs/ Directory - Agent Reference

## Purpose

This directory contains technical analysis and architecture documentation. It focuses on reverse-engineered API specifications and implementation details for external services (Hitomi.la, CDN infrastructure).

## Key Files

| File | Purpose | Audience |
|------|---------|----------|
| `hitomi-api-analysis.md` | Comprehensive analysis of Hitomi.la API, CDN architecture, image routing (gg.js), gallery data formats, nozomi indexes, B-tree search, tag suggestion API, and HiPaGo proxy implementation | Backend engineers, API integrators |

## For AI Agents

### When modifying docs in this directory:

- **Update mechanism:** API endpoints, image URL construction, gg.js routing logic, nozomi binary formats
- **Key dependencies:** Hitomi.la infrastructure (CDN domains, domain migration, gg.js updates)
- **Testing:** Verify examples against live endpoints. Document domain migration status (ltn.hitomi.la → ltn.gold-usergeneratedcontent.net as of 2025)
- **Staleness risk:** HIGH — External API specs change frequently. Last verified: 2026-02-19
- **Cross-reference:** Used by `/api/hitomi/`, `/api/img/`, `/api/tagindex/` proxy routes in main codebase

### Analysis updates needed if:

1. Hitomi.la changes gg.js format (check `https://ltn.gold-usergeneratedcontent.net/gg.js`)
2. Tag index domain migration (`tagindex/version` endpoint status)
3. Image CDN subdomain routing changes
4. Nozomi file format or compression changes
5. Gallery info JSON schema updates

<!-- MANUAL: -->

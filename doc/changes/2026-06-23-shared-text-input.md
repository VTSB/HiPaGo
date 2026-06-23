# Shared text input atom

**Date:** 2026-06-23
**Area:** shared components / settings / search

Search and settings text inputs should use the same filled control surface.
The search bar style is the canonical input design: no outline border, semantic
`--control` background tokens, responsive height, and visible focus through a
filled-hover surface change.

`components/atoms/TextInput` is the shared atom for that surface.
Search-specific behavior such as leading icons, clear buttons, autocomplete,
and dropdowns remains in wrapper components. Settings fields and matching
fixed-width number fields use the same atom directly so filled inputs no longer
mix custom outlined variants on the same product surface.

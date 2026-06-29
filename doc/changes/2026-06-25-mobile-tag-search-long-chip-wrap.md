# Mobile tag search long chip wrapping

**Date:** 2026-06-25
**Area:** ui / search / settings
**Task:** TASK__mobile-tag-search-long-tag-overflow

Long tag suggestion labels on mobile could keep their chip on one unbreakable
line. In the search suggestion rows, the chip's intrinsic width then pushed
past the viewport and left the amount column outside the visible screen,
creating horizontal page scroll.

`TagChip` now keeps the existing one-line behavior by default, but exposes a
`wrap` mode for constrained autocomplete rows. Search and settings suggestion
rows use `min-w-0` + a flexible label cell, keep the count column `shrink-0`,
and render wrapped chips with `overflow-wrap: anywhere` so long Korean or
English labels stay inside the row without widening the page.

# Negative-only Tag Search

## Context

Search already supported negative terms when at least one positive term existed, such as `female:loli -male:yaoi`. A query containing only negative terms, such as `-female:loli`, returned no results because there was no positive result set to filter.

## Decision

Negative-only search uses the current browse index as its base result set, then removes the union of all negative term matches.

Examples:

- `-female:loli` returns all galleries for the current language/sort except galleries tagged `female:loli`.
- `-female:loli -artist:yam` returns all galleries except galleries matching either excluded term.
- `female:loli -artist:yam` keeps the existing positive+negative behavior: search `female:loli`, then remove `artist:yam`.

## Tradeoff

Negative-only search needs the full current index in memory before filtering. Use the full nozomi index fetch path rather than paginated browse requests so exclusion can preserve the current index order and avoid thousands of page fetches.

## Verification Cue

Search tests should assert that negative-only queries first fetch `('', 'index', language, sort)` through `fetchNozomiSearch`, then subtract each negative term's ID set.

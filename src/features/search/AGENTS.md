<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/features/search Directory Guide

## Purpose

The `search` feature implements a chip-based search interface with tag autocomplete, search history, and intelligent switching between local and remote search APIs. It parses query strings, maintains search state, and provides suggestions from either the local Dexie database (instant) or remote API (with debounce).

## Key Files

- **`hooks/useSearch.ts`** - Search logic and autocomplete
  - Parses active term from query (supports multi-term queries with spaces)
  - Branches on `dbReady` state:
    - If DB ready: use local search (instant, no debounce)
    - If DB not ready: use remote API (300ms debounce, min 2 chars)
  - Parses tag prefix (e.g., `female:loli` → tagType=female, tag=loli)
  - Updates suggestions via `setSuggestions()` in store
  - Clears suggestions when inactive

- **`store/search.store.ts`** - Zustand store with persistence
  - State: `query`, `suggestions`, `isSearching`, `isLoadingSuggestions`, `recentSearches`
  - Actions: `setQuery`, `setSuggestions`, `addRecentSearch`, `removeRecentSearch`, `clearRecentSearches`, `clearSuggestions`, `reset`
  - Persisted fields: `recentSearches` (via `zustand/middleware` localStorage)

- **`components/SearchBar.tsx`** - Full search UI component
  - Chip-based input (each tag or term becomes a chip)
  - Active input field for typing
  - Edit chip functionality (click to edit existing chip)
  - Dropdown suggestions (tag suggestions, popular tags, search history)
  - Keyboard navigation (arrow keys, enter to select, backspace to remove last chip)
  - Search history dropdown (shown when input empty and DB initialized)
  - Popular tags dropdown (shown after chips entered and DB initialized)
  - Ctrl+K or "/" to focus input
  - Escape to close dropdown or unfocus

- **`components/SearchResults.tsx`** - Search results display
  - Renders grid of galleries matching query
  - Integrates with `GalleryGrid` for rendering

## Subdirectories

### components/
- **`SearchBar.tsx`** - Search input and suggestion dropdown
- **`SearchResults.tsx`** - Results grid

### hooks/
- **`useSearch.ts`** - Autocomplete logic

### store/
- **`search.store.ts`** - Search state (persistent)

## Architecture Patterns

### Query Parsing

- **Chip format**: `type:tag` or free text
- **Valid types**: artist, group, series, character, tag, male, female, type, language
- **Tag format**: underscores replace spaces (e.g., `female:loli_teacher`)
- **Multi-term**: Chips are space-separated in final query
- **Examples**:
  - `female:loli artist:drawfag` → two chips
  - `female:loli drawfag` → two chips (first is tag, second is free text)
  - `female:lo` (editing in input) → suggestion for female tag starting with "lo"

### DB vs Remote Search

- **DB Ready** (local indices initialized):
  - `searchLocalTags(term, typeFilter)` returns instant results
  - No debounce (user gets suggestions immediately)
  - Full query syntax support (prefix matching only)

- **DB Not Ready** (initializing or no DB):
  - `getSuggestionsForQuery(term)` from remote API
  - 300ms debounce to reduce requests
  - Minimum 2 characters required
  - Limited feature set (API limitations)

- **Transition**: When DB finishes initializing, suggestions switch from remote to local (no UX disruption)

### Search History

- **Storage**: localStorage via Zustand persist middleware
- **Limit**: 20 recent searches max
- **Format**: Full query string (e.g., `female:loli artist:drawfag`)
- **UI**: Dropdown when SearchBar input empty and no suggestions
- **Actions**: Click to search, remove individual item, clear all

### Popular Tags

- **Shown**: After user selects at least one chip
- **Source**: Local DB query (all tags sorted by count)
- **UI**: Dropdown below input, replaced by suggestions when typing
- **Purpose**: Help users discover common tags

## For AI Agents

### Common Tasks

**Add new tag type:**
1. Add to `validTypes` array in `SearchBar.tsx` (line 22)
2. Update `TAG_TYPE_DISPLAY` in `src/lib/utils/types.ts`
3. Verify it's in search API types

**Change debounce timing:**
1. Edit timeout value in `useSearch.ts` (line 63)
2. Default is 300ms

**Modify suggestion display:**
1. Edit `SearchBar.tsx` suggestion dropdown rendering (lines 367-390)
2. Change className, order, or layout
3. Update tag display format

**Add search filter UI:**
1. Add filter state in `SearchBar.tsx`
2. Update query building logic in `buildQuery()`
3. Persist filter preference if needed

**Change history limit:**
1. Edit limit in `search.store.ts` addRecentSearch (line 36)
2. `.slice(0, 20)` sets max 20 searches

**Add search suggestions from custom source:**
1. Create new hook similar to `useSearch()`
2. Fetch from custom API endpoint
3. Update suggestions via store

### Key Patterns to Follow

- **Always check `dbReady`** before assuming local search works
- **Parse active term only** (last space-separated token) for suggestions
- **Validate tag types** before appending (check `validTypes`)
- **Debounce remote API** calls but not local queries
- **Handle spaces in tags** by converting to underscores in chip format
- **Clear suggestions** when input empty or inactive
- **Persist only recent searches**, not suggestions (temporary)

### Code Organization Rules

1. **Hook** (`useSearch.ts`) manages autocomplete logic only
2. **Component** (`SearchBar.tsx`) manages UI state (chips, dropdown, focus)
3. **Store** (`search.store.ts`) manages persistent state (query, history)
4. **Results** (`SearchResults.tsx`) is separate component (receives query via props or URL)
5. **Keyboard handling** in SearchBar component (not in hook)

<!-- MANUAL: -->

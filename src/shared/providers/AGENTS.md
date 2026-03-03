<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/shared/providers Directory Guide

## Purpose

The `providers/` directory contains React context providers that wrap the entire application with shared configuration, state management, and initialization logic. Providers set up React Query caching, database initialization, and locale detection.

## Key Files

- **`providers.tsx`** - Root Providers component wrapping QueryClientProvider, DbInitializer, and locale setup

## Provider Overview

### `providers.tsx` (817 bytes)

**Wrapper Component**
- Exported as: `function Providers({ children }: { children: ReactNode })`
- Used in: `src/app/layout.tsx` as root provider wrapper
- Client component: `'use client'` (state and hooks required)

**Features**

1. **React Query Setup**
   ```typescript
   QueryClient {
     defaultOptions: {
       queries: {
         staleTime: 5 * 60 * 1000,      // 5 minutes
         gcTime: 30 * 60 * 1000,        // 30 minutes (cache GC)
         retry: 2,                       // retry failed queries twice
         refetchOnWindowFocus: false,    // don't refetch when tab regains focus
       }
     }
   }
   ```
   - Initialized once on component mount (state hook, not re-created each render)
   - Persists across component re-renders via `useState`

2. **Database Initialization**
   - Mounts invisible `DbInitializer` component
   - Runs BEFORE main app content renders
   - Initializes SQLite database (or detects platform unavailability)
   - Starts background tag sync if needed
   - App can check `useDbStatusStore().dbReady` to decide search strategy

3. **Locale Initialization**
   - Calls `initLocaleOnce()` on mount (once per session)
   - Sets up i18n language detection
   - Uses browser language or stored preference
   - Respects `useSettingsStore.language` if user has set preference

**DOM Structure**
```
<QueryClientProvider>
  <DbInitializer />  {/* invisible */}
  {children}         {/* page content */}
</QueryClientProvider>
```

**Hooks Used**
- `useState` — create QueryClient once
- `useEffect` — run locale init on mount

## Integration Points

### In `src/app/layout.tsx`
```typescript
import { Providers } from '@/shared/providers/providers';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### QueryClient Configuration Rationale
- **staleTime: 5min** — Gallery data doesn't change frequently, safe to cache 5 min
- **gcTime: 30min** — Keep unused cached queries for 30 min in case user navigates back
- **retry: 2** — Network blips are common on mobile, retry twice before failing
- **refetchOnWindowFocus: false** — Avoid refetch when user switches tabs (reduces API load)

### Database Initialization Flow
1. `Providers` component mounts
2. `DbInitializer` component mounts (invisible)
3. `initializeDatabase()` runs (creates schema, opens connection)
4. `checkDbReady()` checks if tag table is populated
5. If not ready, `runTagSync()` starts in background
6. App reads `useDbStatusStore().dbReady` to decide:
   - `true` → use local SQLite search
   - `false` → use remote API search (fallback)

### Locale Initialization Flow
1. `initLocaleOnce()` runs on first Providers mount
2. Detects browser language from `navigator.language`
3. Checks `useSettingsStore.language` for user preference
4. Sets up translation strings via `useT()` hook
5. i18n tags (Korean) loaded from `korean-tags.json` static data

## For AI Agents

### Common Tasks

**Add a new provider:**
1. Create new file: `src/shared/providers/[ProviderName].tsx`
2. Export as client component: `'use client'`
3. Wrap children with context provider
4. Add to `Providers` component in `providers.tsx`:
   ```typescript
   return (
     <QueryClientProvider client={queryClient}>
       <DbInitializer />
       <NewProvider>
         {children}
       </NewProvider>
     </QueryClientProvider>
   );
   ```

**Modify QueryClient configuration:**
1. Edit `src/shared/providers/providers.tsx`
2. Update `defaultOptions` for queries and mutations
3. Common changes:
   - Increase `staleTime` if data is very stable
   - Decrease `staleTime` if data changes frequently
   - Adjust `retry` count for unreliable networks
   - Enable `refetchOnWindowFocus` if data must be fresh

**Add initialization logic:**
1. Create new initialization component (like `DbInitializer`)
2. Use `useRef` to prevent double-run in dev mode
3. Add to Providers component:
   ```typescript
   export function Providers({ children }: { children: ReactNode }) {
     const [queryClient] = useState(() => new QueryClient(...));

     useEffect(() => {
       initSomething();
     }, []);

     return (
       <QueryClientProvider client={queryClient}>
         <NewInitializer />
         {children}
       </QueryClientProvider>
     );
   }
   ```

**Wrap multiple providers:**
1. Providers nest naturally: innermost executes first
2. Order matters: DbInitializer before QueryClientProvider would fail
3. Current order (correct): QueryClientProvider wraps DbInitializer
4. Add new provider outside: `NewProvider > QueryClientProvider`

### Key Patterns

**Single QueryClient instance**
```typescript
const [queryClient] = useState(() => new QueryClient({...}));
// Not:
const queryClient = new QueryClient({...}); // ❌ recreated each render
```

**One-time initialization**
```typescript
useEffect(() => {
  initLocaleOnce();
}, []); // empty deps = run once on mount
```

**Invisible initialization components**
```typescript
export function DbInitializer() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    // init logic
  }, []);
  return null; // invisible
}
```

### Testing Providers

In tests, wrap components with mock Providers:
```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false }, // no retry in tests
  }
});

render(
  <QueryClientProvider client={queryClient}>
    <MyComponent />
  </QueryClientProvider>
);
```

### Performance Notes
- QueryClient instance is created once and reused (memoized via useState)
- Providers component is lightweight (no large trees)
- DbInitializer is invisible (no DOM impact)
- Locale init is one-time (cached in Zustand store)
- No performance impact from provider nesting

### Troubleshooting

**"useQuery is not defined"**
- Component is not wrapped with Providers
- Add Providers wrapper to test setup

**Database not initializing**
- Check browser console for [db] messages
- Verify platform is detected (Tauri/Capacitor/browser)
- Check if tag-sync.ts is running
- Test store: `useDbStatusStore().dbReady` should be true after ~2s

**Queries not caching**
- Check staleTime: is query hitting 5min threshold?
- Check gcTime: is query cached long enough?
- Use React Query DevTools: `@tanstack/react-query-devtools`

<!-- MANUAL: -->

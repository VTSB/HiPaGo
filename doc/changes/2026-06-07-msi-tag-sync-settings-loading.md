# MSI Tag Sync and Settings Loading

Windows MSI/Tauri builds must resolve tag DB sync and clean-route settings navigation without relying on dev-server behavior.

## Changes

- Tauri tag DB sync imports `@tauri-apps/api/core` through the bundled path before invoking `bypass_fetch`; packaged WebView must not receive an ignored bare dynamic import for this module.
- The desktop SQLite adapter exposes the app DB URL (`sqlite:hipago.db`) and the Tauri SQL capability explicitly includes `sql:allow-load` alongside execute, select, and close permissions.
- Static export creates directory `index.html` aliases for top-level routes such as `/settings`, `/history`, `/favorites`, `/search`, `/library`, and `/licenses`, so packaged native navigation does not depend on server extension rewrites.

## Verification

- Focused Vitest coverage for Tauri tag fetcher and Tauri DB capability.
- Full Vitest suite passed.
- Static export completed and produced `out/settings/index.html`.

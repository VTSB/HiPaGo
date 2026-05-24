# Contributing to HiPaGo

This document contains developer-facing setup, build, testing, and architecture notes. The user-facing project overview lives in [README.md](README.md).

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| State | Zustand, TanStack Query |
| Database | Dexie (IndexedDB) / sql.js / Capacitor SQLite |
| Desktop | Tauri 2 (Rust) |
| Mobile | Capacitor 6 (iOS / Android) |
| Bypass | Rust (DoH + SNI fragmentation + Chrome TLS fingerprint) |
| Testing | Vitest, Testing Library |

## Prerequisites

- Node.js 22
- pnpm
- Rust stable
- LLVM/Clang for bindgen in `bypass-napi`
- NASM for BoringSSL assembly in `bypass-napi` on Windows
- Java 21 Corretto for Android
- Xcode for iOS

[mise](https://mise.jdx.dev/) is recommended for tool version management:

```bash
mise install
```

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

The dev script:

- Installs `@napi-rs/cli` and builds the `bypass-napi` addon when needed.
- Rebuilds native bindings when Rust source changes.
- Starts the Next.js dev server.

If `bypass-napi` fails to build, the app can still run through the JavaScript fallback path.

## Optional Native Build Setup

`bypass-napi` needs LLVM and NASM.

### Windows

```powershell
winget install LLVM.LLVM
winget install NASM.NASM
set LIBCLANG_PATH=C:\Program Files\LLVM\bin
```

Restart the terminal after installing LLVM or NASM.

### macOS

```bash
brew install llvm nasm
export LIBCLANG_PATH="$(brew --prefix llvm)/lib"
```

### Linux

```bash
sudo apt install llvm-dev libclang-dev nasm
export LIBCLANG_PATH=/usr/lib/llvm-18/lib
```

Add `LIBCLANG_PATH` to your shell profile if you build native bindings regularly.

## Troubleshooting

### Turbopack cache errors

```bash
rm -rf .next && pnpm dev
```

PowerShell:

```powershell
Remove-Item -Recurse -Force .next
pnpm dev
```

### Port conflicts

If `EADDRINUSE` appears, an older dev server process is still running. Stop that process and restart `pnpm dev`.

### `.next/dev/lock` errors

```bash
rm -rf .next/dev/lock && pnpm dev
```

PowerShell:

```powershell
Remove-Item -Recurse -Force .next\dev\lock
pnpm dev
```

## Build

### Web

```bash
pnpm build
```

### Desktop

```bash
pnpm build:tauri
```

Builds for the current platform. Tauri handles Rust compilation automatically.

### Android

```bash
pnpm build:android
```

Runs Rust cross-compilation, static export, Capacitor sync, and Gradle APK build.

Requires Android NDK and:

```bash
cargo install cargo-ndk
```

### iOS

```bash
pnpm build:ios
```

Runs Rust cross-compilation, static export, and Capacitor sync.

Requires Xcode and:

```bash
rustup target add aarch64-apple-ios
```

## Project Structure

```text
HiPaGo/
├── src/
│   ├── app/                  # Next.js routes
│   │   ├── (main)/           # Main app pages
│   │   ├── (reader)/         # Reader pages
│   │   └── api/              # API proxy routes
│   ├── features/             # Feature modules
│   ├── lib/                  # Core libraries
│   │   ├── api/              # API client, parsers, fetchers
│   │   ├── db/               # Database layer
│   │   ├── server/           # Server-only utilities
│   │   ├── store/            # Zustand stores
│   │   ├── plugins/          # Capacitor plugin wrappers
│   │   └── utils/            # Shared utilities
│   ├── shared/               # Shared UI components
│   └── types/                # TypeScript type definitions
├── crates/
│   ├── bypass-core/          # Rust: DoH, SOCKS5 proxy, rquest client
│   ├── bypass-napi/          # Rust to Node.js bindings
│   └── bypass-uniffi/        # Rust to Kotlin/Swift bindings
├── src-tauri/                # Tauri desktop app
├── android/                  # Capacitor Android project
├── ios/                      # Capacitor iOS project
└── scripts/                  # Build scripts
```

## Bypass Architecture

ISP bypass is implemented as a single Rust library, `bypass-core`, with platform-specific bindings.

```text
Browser / Next.js      Tauri desktop        Capacitor mobile
       |                    |                     |
   /api proxy           IPC invoke          UniFFI plugin
       |                    |                     |
 bypass-napi           src-tauri           bypass-uniffi
       \____________________|_____________________/
                            |
                      bypass-core
```

Main pieces:

- DoH resolver
- SOCKS5 proxy
- SNI fragmentation
- Chrome-like TLS fingerprint through `rquest` and BoringSSL

## Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Dev server plus Rust auto-rebuild |
| `pnpm build` | Next.js production build |
| `pnpm test` | Run all tests |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |
| `pnpm build:static` | Static export for native platforms |
| `pnpm build:napi` | Build `bypass-napi` addon |
| `pnpm build:tauri` | Build Tauri desktop app |
| `pnpm build:android` | Full Android build pipeline |
| `pnpm build:ios` | Full iOS build pipeline |
| `pnpm build:bypass:android` | Rust cross-compile for Android only |
| `pnpm build:bypass:ios` | Rust cross-compile for iOS only |

## Testing

```bash
pnpm test
pnpm test:watch
```

Rust tests:

```bash
cd crates/bypass-core
cargo test
```

## CI/CD

GitHub Actions workflow:

```text
.github/workflows/release.yml
```

Release flow:

- Pushes to `release` or `v*` tags trigger CI.
- Test, desktop, Android, and iOS jobs run in parallel where possible.
- Tag builds assemble GitHub Release artifacts for supported platforms.


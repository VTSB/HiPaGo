# HiPaGo

Cross-platform gallery viewer built with Next.js, Tauri, and Capacitor.

## Tech Stack

| Layer | Technology |
|-------|-----------|
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
- Rust stable (for native builds)
- LLVM/Clang (for bindgen in bypass-napi)
- NASM (for BoringSSL assembly in bypass-napi, Windows only)
- Java 21 Corretto (for Android)
- Xcode (for iOS)

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

Automatically:
- Installs `@napi-rs/cli` and builds `bypass-napi` addon if not already built (or if Rust source changed)
- Starts Next.js dev server

> bypass-napi 빌드가 실패해도 JS fallback으로 정상 동작합니다.

### bypass-napi 네이티브 빌드 준비 (선택)

bypass-napi를 빌드하려면 LLVM과 NASM이 필요합니다. 없어도 JS fallback으로 동작합니다.

**Windows:**

```powershell
winget install LLVM.LLVM
winget install NASM.NASM
set LIBCLANG_PATH=C:\Program Files\LLVM\bin
```

> NASM, LLVM 설치 후 터미널을 재시작하세요.

**macOS:**

```bash
brew install llvm nasm
export LIBCLANG_PATH="$(brew --prefix llvm)/lib"
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install llvm-dev libclang-dev nasm
export LIBCLANG_PATH=/usr/lib/llvm-18/lib
```

> `LIBCLANG_PATH`는 셸 프로필(`.bashrc`, `.zshrc` 등)에 추가하면 편합니다.

### 트러블슈팅

**Turbopack 캐시 에러 (500 에러)**

```powershell
# PowerShell
Remove-Item -Recurse -Force .next
pnpm dev
```

```bash
# Bash / Zsh
rm -rf .next && pnpm dev
```

**포트 충돌 (EADDRINUSE)**

이전 dev 서버 프로세스가 남아있을 수 있습니다. 프로세스 종료 후 재시작하세요.

**.next/dev/lock 에러**

```powershell
# PowerShell
Remove-Item -Recurse -Force .next\dev\lock
pnpm dev
```

## Build

### Web

```bash
pnpm build
```

### Desktop (Tauri)

```bash
pnpm build:tauri
```

Builds for the current platform (Linux/macOS/Windows). Tauri handles Rust compilation automatically.

### Android

```bash
pnpm build:android
```

Runs: Rust cross-compile (arm64, armv7, x86_64) → static export → Capacitor sync → Gradle APK

Requires Android NDK and `cargo install cargo-ndk`.

### iOS

```bash
pnpm build:ios
```

Runs: Rust cross-compile (aarch64-apple-ios) → static export → Capacitor sync

Requires Xcode and `rustup target add aarch64-apple-ios`.

## Project Structure

```
HiPaGo/
├── src/
│   ├── app/                  # Next.js routes
│   │   ├── (main)/           #   Main app pages
│   │   ├── (reader)/         #   Reader pages
│   │   └── api/              #   API proxy routes
│   ├── features/             # Feature modules
│   ├── lib/                  # Core libraries
│   │   ├── api/              #   API client, parsers, fetchers
│   │   ├── db/               #   Database layer (Dexie)
│   │   ├── server/           #   Server-only utilities
│   │   ├── store/            #   Zustand stores
│   │   ├── plugins/          #   Capacitor plugin wrappers
│   │   └── utils/            #   Shared utilities
│   ├── shared/               # Shared UI components
│   └── types/                # TypeScript type definitions
├── crates/
│   ├── bypass-core/          # Rust: DoH, SOCKS5 proxy, rquest client
│   ├── bypass-napi/          # Rust → Node.js bindings (napi-rs)
│   └── bypass-uniffi/        # Rust → Kotlin/Swift bindings (uniffi)
├── src-tauri/                # Tauri desktop app
├── android/                  # Capacitor Android project
├── ios/                      # Capacitor iOS project
└── scripts/                  # Build scripts (cross-platform .mjs)
```

## Bypass Architecture

ISP bypass is implemented as a single Rust library (`bypass-core`) with platform-specific bindings:

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Browser    │     │    Tauri     │     │  Capacitor   │
│  (Next.js)   │     │  (Desktop)  │     │   (Mobile)   │
└──────┬───────┘     └──────┬──────┘     └──────┬───────┘
       │                    │                    │
  /api/* proxy         IPC invoke          uniffi plugin
       │                    │                    │
┌──────┴───────┐     ┌──────┴──────┐     ┌──────┴───────┐
│ bypass-napi  │     │  src-tauri  │     │bypass-uniffi │
│  (napi-rs)   │     │  (direct)   │     │  (Kt/Swift)  │
└──────┬───────┘     └──────┬──────┘     └──────┬───────┘
       └────────────────────┼────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  bypass-core  │
                    │───────────────│
                    │ DoH resolver  │
                    │ SOCKS5 proxy  │
                    │ SNI fragment  │
                    │ Chrome TLS FP │
                    └───────────────┘
```

- **DoH**: DNS over HTTPS via Cloudflare 1.1.1.1 / Google 8.8.8.8
- **SNI fragmentation**: Splits TLS ClientHello into two TCP segments
- **Chrome TLS fingerprint**: Impersonates Chrome 131 via rquest + BoringSSL

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Dev server + Rust auto-rebuild |
| `pnpm build` | Next.js production build |
| `pnpm test` | Run all tests |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |
| `pnpm build:static` | Static export for native platforms |
| `pnpm build:napi` | Build bypass-napi addon |
| `pnpm build:tauri` | Build Tauri desktop app |
| `pnpm build:android` | Full Android build pipeline |
| `pnpm build:ios` | Full iOS build pipeline |
| `pnpm build:bypass:android` | Rust cross-compile for Android only |
| `pnpm build:bypass:ios` | Rust cross-compile for iOS only |

## Testing

```bash
pnpm test           # run once
pnpm test:watch     # watch mode
```

Rust tests:

```bash
cd crates/bypass-core && cargo test
```

## CI/CD

GitHub Actions workflow (`.github/workflows/release.yml`):

- **Trigger**: Push to `release` branch or `v*` tags
- **Jobs**: Test → Desktop (Linux/macOS/Windows) + Android + iOS (parallel)
- **Release**: Tag push creates draft GitHub Release with all platform artifacts

#!/bin/bash
# Build Next.js as static export for native platforms (Tauri/Capacitor).
# Temporarily hides API routes and dynamic route pages that are incompatible
# with static export. Native platforms handle SPA routing via webview fallback.

set -e

BACKUP=".build-backup"
mkdir -p "$BACKUP"

# Items to temporarily hide during static export
HIDE_DIRS=(
  "src/app/api"
  "src/app/(main)/gallery"
  "src/app/(reader)/gallery"
)

# Move incompatible dirs out
for dir in "${HIDE_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    backup_path="$BACKUP/$dir"
    mkdir -p "$(dirname "$backup_path")"
    mv "$dir" "$backup_path"
    echo "Hidden: $dir"
  fi
done

cleanup() {
  for dir in "${HIDE_DIRS[@]}"; do
    backup_path="$BACKUP/$dir"
    if [ -d "$backup_path" ]; then
      mkdir -p "$(dirname "$dir")"
      mv "$backup_path" "$dir"
      echo "Restored: $dir"
    fi
  done
  rm -rf "$BACKUP"
}
trap cleanup EXIT

NEXT_OUTPUT=export node node_modules/next/dist/bin/next build
echo "Static export complete → out/"

# Copy index.html as fallback for SPA routing in native webviews
if [ -f "out/index.html" ]; then
  mkdir -p out/gallery
  cp out/index.html out/gallery/index.html
  echo "Created SPA fallback: out/gallery/index.html"
fi

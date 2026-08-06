#!/usr/bin/env bash
set -euo pipefail

apk="${1:-}"
if [[ -z "$apk" || ! -s "$apk" ]]; then
  echo "usage: $0 <non-empty-apk>" >&2
  exit 2
fi

ndk_home="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [[ -z "$ndk_home" ]]; then
  echo "ANDROID_NDK_HOME or ANDROID_NDK_ROOT is required" >&2
  exit 2
fi

host_tag="linux-x86_64"
case "$(uname -s)" in
  Darwin) host_tag="darwin-x86_64" ;;
  MINGW*|MSYS*|CYGWIN*) host_tag="windows-x86_64" ;;
esac

readelf="$ndk_home/toolchains/llvm/prebuilt/$host_tag/bin/llvm-readelf"
if [[ "$host_tag" == "windows-x86_64" ]]; then
  readelf="${readelf}.exe"
fi
if [[ ! -x "$readelf" ]]; then
  echo "llvm-readelf not found: $readelf" >&2
  exit 2
fi

android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$android_home" ]]; then
  echo "ANDROID_HOME or ANDROID_SDK_ROOT is required" >&2
  exit 2
fi
zipalign="$(find "$android_home/build-tools" -mindepth 2 -maxdepth 2 -type f -name 'zipalign*' | sort -V | tail -1)"
if [[ -z "$zipalign" || ! -x "$zipalign" ]]; then
  echo "zipalign not found below $android_home/build-tools" >&2
  exit 2
fi

# Android's 16 KB guidance requires both ZIP layout alignment and compatible
# ELF LOAD segment alignment. Checking only zipalign can miss compressed native
# libraries whose program headers still use a 4 KB p_align.
"$zipalign" -c -P 16 -v 4 "$apk" >/dev/null

extract_dir="$(mktemp -d)"
trap 'rm -rf -- "$extract_dir"' EXIT

native_entries="$(unzip -Z1 "$apk" | awk '/^lib\/(arm64-v8a|x86_64)\/[^/]+\.so$/')"
duplicate_entries="$(printf '%s\n' "$native_entries" | sort | uniq -d)"
if [[ -n "$duplicate_entries" ]]; then
  echo "duplicate 64-bit native library entries in APK:" >&2
  printf '%s\n' "$duplicate_entries" >&2
  exit 1
fi
unzip -q "$apk" 'lib/arm64-v8a/*.so' 'lib/x86_64/*.so' -d "$extract_dir"

minimum=$((16 * 1024))
checked=0
failed=0
for abi in arm64-v8a x86_64; do
  abi_dir="$extract_dir/lib/$abi"
  if [[ ! -d "$abi_dir" ]]; then
    echo "missing required 64-bit ABI directory: lib/$abi" >&2
    failed=1
    continue
  fi

  while IFS= read -r -d '' library; do
    relative="${library#"$extract_dir/"}"
    alignments="$("$readelf" -lW "$library" | awk '$1 == "LOAD" { print $NF }')"
    if [[ -z "$alignments" ]]; then
      echo "$relative: no ELF LOAD segments found" >&2
      failed=1
      continue
    fi

    smallest=0
    while IFS= read -r alignment; do
      value=$((alignment))
      if (( smallest == 0 || value < smallest )); then
        smallest=$value
      fi
      if (( value < minimum )); then
        echo "$relative: LOAD p_align $alignment is below 0x4000" >&2
        failed=1
      fi
    done <<< "$alignments"

    printf '%s: minimum LOAD p_align=0x%x\n' "$relative" "$smallest"
    checked=$((checked + 1))
  done < <(find "$abi_dir" -type f -name '*.so' -print0 | sort -z)
done

if (( checked == 0 )); then
  echo "no 64-bit native libraries were checked" >&2
  exit 1
fi
if (( failed != 0 )); then
  exit 1
fi

echo "Verified 16 KB ZIP and ELF alignment for $checked 64-bit libraries."

@echo off
setlocal

if not defined HIPAGO_ANDROID_REAL_CARGO (
  echo HIPAGO_ANDROID_REAL_CARGO is required. 1>&2
  exit /b 1
)
if not defined HIPAGO_ANDROID_CLANG_PATH (
  echo HIPAGO_ANDROID_CLANG_PATH is required. 1>&2
  exit /b 1
)

rem cargo-ndk 4.1.2 replaces CLANG_PATH with an extension-less Windows path.
rem Restore the NDK clang.exe selected and validated by build-android.mjs.
set "CLANG_PATH=%HIPAGO_ANDROID_CLANG_PATH%"
"%HIPAGO_ANDROID_REAL_CARGO%" %*
exit /b %ERRORLEVEL%

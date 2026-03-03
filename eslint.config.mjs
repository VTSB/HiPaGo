import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Rust crates (including build artifacts and generated loaders)
    "target/**",
    "crates/**",
    "src-tauri/**",
    // Native platform build artifacts
    "android/**",
    "ios/**",
    // Test coverage output
    "coverage/**",
  ]),
]);

export default eslintConfig;

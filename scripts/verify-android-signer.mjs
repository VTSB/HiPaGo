#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizeCertificateSha256(value, label = 'certificate SHA-256 digest') {
  const normalized = String(value ?? '')
    .replace(/[\s:]/g, '')
    .toUpperCase();

  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new Error(`${label} must contain exactly 64 hexadecimal characters`);
  }

  return normalized;
}

export function extractSignerCertificateSha256(apksignerOutput) {
  const matches = [
    ...String(apksignerOutput).matchAll(
      /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer):?\s+certificate SHA-256 digest:\s*(.*?)\s*$/gim,
    ),
  ];
  const digests = new Set(
    matches.map((match) =>
      normalizeCertificateSha256(match[1], 'APK signer certificate SHA-256 digest'),
    ),
  );

  if (digests.size !== 1) {
    throw new Error(
      `apksigner output must contain exactly one unique signer certificate SHA-256 digest; found ${digests.size}`,
    );
  }

  return digests.values().next().value;
}

export function verifyAndroidSigner(apksignerOutput, expectedDigest) {
  const expected = normalizeCertificateSha256(expectedDigest, 'ANDROID_EXPECTED_CERT_SHA256');
  const actual = extractSignerCertificateSha256(apksignerOutput);

  if (actual !== expected) {
    throw new Error('APK signer certificate SHA-256 digest does not match the production value');
  }

  return actual;
}

async function readStandardInput() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath.toLowerCase() === resolve(scriptPath).toLowerCase()) {
  try {
    const digest = verifyAndroidSigner(await readStandardInput(), process.argv[2]);
    console.log(`[android-signing] verified production certificate SHA-256 ${digest}`);
  } catch (error) {
    console.error(`[android-signing] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

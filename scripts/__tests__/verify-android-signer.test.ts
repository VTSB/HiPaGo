// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  extractSignerCertificateSha256,
  normalizeCertificateSha256,
  verifyAndroidSigner,
} from '../verify-android-signer.mjs';

const DIGEST = '0123456789ABCDEF'.repeat(4);

function colonSeparated(value: string): string {
  return value.match(/.{2}/g)!.join(':');
}

describe('Android production signer verification', () => {
  it('normalizes spaces, colons, and letter case before exact comparison', () => {
    const output = `Signer #1 certificate SHA-256 digest: ${colonSeparated(DIGEST.toLowerCase())}\n`;
    const expected = `  ${DIGEST.slice(0, 32)} ${DIGEST.slice(32).toLowerCase()}  `;

    expect(verifyAndroidSigner(output, expected)).toBe(DIGEST);
  });

  it('accepts the versioned signer label emitted by newer Build Tools', () => {
    const output = `V2 Signer: certificate SHA-256 digest: ${DIGEST.toLowerCase()}\n`;

    expect(verifyAndroidSigner(output, DIGEST)).toBe(DIGEST);
  });

  it.each(['', 'ABCD', `${'A'.repeat(63)}:`, `${'G'.repeat(64)}`])(
    'rejects a missing or malformed expected digest: %j',
    (expected) => {
      expect(() => normalizeCertificateSha256(expected, 'ANDROID_EXPECTED_CERT_SHA256')).toThrow(
        'exactly 64 hexadecimal characters',
      );
    },
  );

  it('rejects a signer mismatch', () => {
    const output = `Signer #1 certificate SHA-256 digest: ${DIGEST}\n`;

    expect(() => verifyAndroidSigner(output, 'F'.repeat(64))).toThrow(
      'does not match the production value',
    );
  });

  it('requires exactly one signer digest in apksigner output', () => {
    expect(() => extractSignerCertificateSha256('Verified\n')).toThrow('found 0');
    expect(() =>
      extractSignerCertificateSha256(
        `Signer #1 certificate SHA-256 digest: ${DIGEST}\n` +
          `Signer #2 certificate SHA-256 digest: ${'F'.repeat(64)}\n`,
      ),
    ).toThrow('found 2');
  });

  it('deduplicates the same signer certificate reported for multiple schemes', () => {
    const output =
      `V1 Signer: certificate SHA-256 digest: ${DIGEST}\n` +
      `V2 Signer: certificate SHA-256 digest: ${DIGEST.toLowerCase()}\n`;

    expect(extractSignerCertificateSha256(output)).toBe(DIGEST);
  });
});

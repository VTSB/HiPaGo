// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildLatestJson } from '../build-latest-json.mjs';

const signatures = {
  'HiPaGo_1.2.3_macos_aarch64.app.tar.gz.sig': ' mac-signature\n',
  'HiPaGo_1.2.3_linux_x86_64.AppImage.sig': 'linux-signature',
  'HiPaGo_1.2.3_windows_x86_64.msi.zip.sig': 'msi-signature',
};
const build = (sigs: Record<string, string>) => buildLatestJson({ signatures: sigs, version: '1.2.3', tag: 'v1.2.3', repository: 'VTSB/HiPaGo', notes: 'Tested beta' });

describe('Tauri release manifest', () => {
  it('requires all shipping platforms and supports legacy zipped MSI signatures', () => {
    const manifest = build(signatures);
    expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'linux-x86_64', 'windows-x86_64']);
    expect(manifest.platforms['darwin-aarch64'].signature).toBe('mac-signature');
    expect(manifest.platforms['windows-x86_64'].url).toBe('https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_windows_x86_64.msi.zip');
  });

  it('deterministically prefers current signed NSIS installers over MSI and zip formats', () => {
    const manifest = build({ ...signatures,
      'HiPaGo_1.2.3_windows_x86_64-setup.exe.sig': 'exe-signature',
      'HiPaGo_1.2.3_windows_x86_64.nsis.zip.sig': 'zip-signature',
      'HiPaGo_1.2.3_windows_x86_64.msi.sig': 'native-msi-signature',
    });
    expect(manifest.platforms['windows-x86_64'].signature).toBe('exe-signature');
    expect(manifest.platforms['windows-x86_64'].url).toMatch(/-setup\.exe$/);
  });

  it('rejects empty, unknown-only and incomplete signatures instead of publishing unusable manifests', () => {
    expect(() => build({})).toThrow('Missing updater platform');
    expect(() => build({ 'unused.zip.sig': 'anything' })).toThrow('Missing updater platform');
    expect(() => build({ ...signatures, 'HiPaGo_1.2.3_linux_x86_64.AppImage.sig': ' \n' })).toThrow('Empty signature');
    expect(() => buildLatestJson({ signatures, version: '1.2.4', tag: 'v1.2.3', repository: 'VTSB/HiPaGo', notes: '' })).toThrow('must match');
  });
});

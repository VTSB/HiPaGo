// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../App.xcodeproj/project.pbxproj',
);

describe('iOS Xcode project download sources', () => {
  it('includes native download Swift files in the App target sources', () => {
    const project = readFileSync(projectFile, 'utf8');

    for (const file of [
      'BypassPlugin.swift',
      'DownloadBackgroundTask.swift',
      'DownloadWorkerPlugin.swift',
    ]) {
      expect(project).toContain(`/* ${file} */`);
      expect(project).toContain(`/* ${file} in Sources */`);
    }
  });
});

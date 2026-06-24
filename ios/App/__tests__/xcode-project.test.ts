// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../App.xcodeproj/project.pbxproj',
);
const backgroundTaskFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../App/DownloadBackgroundTask.swift',
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

  it('backs off failed background runs before rescheduling', () => {
    const source = readFileSync(backgroundTaskFile, 'utf8');

    expect(source).toContain('scheduleProcessingTask(after: 5 * 60)');
    expect(source).toContain('request.earliestBeginDate = Date(timeIntervalSinceNow: delay)');
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectFile = resolve('ios/App/App.xcodeproj/project.pbxproj');
const backgroundTaskFile = resolve('ios/App/App/DownloadBackgroundTask.swift');

describe('iOS native background downloads', () => {
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

    expect(source).toContain(
      'BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)',
    );
    expect(source).toContain('scheduleProcessingTask(after: 5 * 60)');
    expect(source).toContain('request.earliestBeginDate = Date(timeIntervalSinceNow: delay)');
  });

  it('refreshes the manifest when background resume skips an existing page', () => {
    const source = readFileSync(backgroundTaskFile, 'utf8');

    expect(source).toContain('if isNonEmptyFile(dest) {');
    expect(source).toContain(
      'writeManifest(galleryDir: galleryDir, exts: Array(exts.prefix(i + 1)))',
    );
  });
});

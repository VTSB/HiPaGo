// @vitest-environment node
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGradleInvocation, runGradle } from '../run-gradle.mjs';

describe('Gradle wrapper invocation', () => {
  it('launches the wrapper main class directly and preserves exact arguments on Windows', () => {
    const args = ['testDebugUnitTest', '&', 'echo injected', '%PATH%', '!value!'];
    const invocation = createGradleInvocation({
      args,
      platform: 'win32',
      environment: { NODE_ENV: 'test', JAVA_HOME: '"C:\\Program Files\\Java\\jdk-17"' },
      cwd: 'D:\\fixture\\android',
    });

    expect(invocation.command).toBe('C:\\Program Files\\Java\\jdk-17\\bin\\java.exe');
    expect(invocation.commandArguments).toEqual([
      '-Xmx64m',
      '-Xms64m',
      '-Dorg.gradle.appname=gradlew',
      '-classpath',
      'D:\\fixture\\android\\gradle\\wrapper\\gradle-wrapper.jar',
      'org.gradle.wrapper.GradleWrapperMain',
      ...args,
    ]);
  });

  it("uses a shell-free child process and returns Gradle's exact exit status", () => {
    const spawnProcess = vi.fn(
      (_command: string, _args: readonly string[], _options: Record<string, unknown>) => {
        void _command;
        void _args;
        void _options;
        return { status: 7, signal: null };
      },
    );
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', JAVA_HOME: '/opt/jdk' };

    const status = runGradle({
      args: ['assembleDebug', '--scan'],
      platform: 'linux',
      environment,
      cwd: '/repo/android',
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawnSync,
    });

    expect(status).toBe(7);
    expect(spawnProcess).toHaveBeenCalledOnce();
    const [command, args, options] = spawnProcess.mock.calls[0]!;
    expect(command).toBe(join('/opt/jdk', 'bin', 'java'));
    expect(args.slice(-2)).toEqual(['assembleDebug', '--scan']);
    expect(options).toMatchObject({
      cwd: '/repo/android',
      env: environment,
      shell: false,
      stdio: 'inherit',
    });
  });

  it('surfaces launch errors and terminating signals', () => {
    expect(() =>
      runGradle({
        args: ['tasks'],
        spawnProcess: (() => ({
          error: new Error('spawn failed'),
          status: null,
          signal: null,
        })) as unknown as typeof import('node:child_process').spawnSync,
      }),
    ).toThrow('Unable to launch Gradle: spawn failed');

    expect(() =>
      runGradle({
        args: ['tasks'],
        spawnProcess: (() => ({
          status: null,
          signal: 'SIGTERM',
        })) as unknown as typeof import('node:child_process').spawnSync,
      }),
    ).toThrow('Gradle terminated by signal SIGTERM');
  });

  it('rejects an empty task list', () => {
    expect(() => runGradle({ args: [] })).toThrow(/Usage:/);
  });
});

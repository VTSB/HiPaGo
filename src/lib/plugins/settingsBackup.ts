import { registerPlugin } from '@capacitor/core';

interface SettingsBackupPlugin {
  get(): Promise<{ value: string | null }>;
  set(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
}

export const SettingsBackup = registerPlugin<SettingsBackupPlugin>('SettingsBackup');

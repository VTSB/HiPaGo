import { notFound } from 'next/navigation';
import {
  SettingsSection,
  type SettingsSectionName,
} from '@/features/settings/components/SettingsSection';

const sections = ['general', 'reader', 'content', 'privacy', 'storage', 'about'] as const;

export function generateStaticParams() {
  return sections.map((section) => ({ section }));
}

export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!(sections as readonly string[]).includes(section)) notFound();
  return <SettingsSection section={section as SettingsSectionName} />;
}

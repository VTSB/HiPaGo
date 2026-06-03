import { Suspense } from 'react';
import { Header } from '@/shared/components/Header';
import { MainShell } from '@/shared/components/MainShell';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Header />
      {/* MainShell (client) decides root-tab vs stacked from the route: it
          renders the bottom tab bar + its padding only on root tabs, and drops
          both on stacked routes (detail / search results / licenses), which
          carry their own sticky BackBar instead. Suspense wraps it because it
          reads useSearchParams (the /search ?q= split). */}
      <Suspense>
        <MainShell>{children}</MainShell>
      </Suspense>
    </div>
  );
}

import { Header } from '@/shared/components/Header';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Header />
      {/* pb-24 on mobile so the bottom-centered FloatingPageNav doesn't clip
          the last row of cards. Desktop keeps the original py-6 — its pill
          stays bottom-right and never overlays content. */}
      <main className="mx-auto max-w-7xl px-4 pt-6 pb-24 sm:pb-6">
        {children}
      </main>
    </div>
  );
}

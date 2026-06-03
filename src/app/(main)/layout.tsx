import { Header } from '@/shared/components/Header';
import { BottomNav } from '@/shared/components/BottomNav';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Header />
      {/* Mobile (<md) reserves room for the bottom tab bar (--bottom-nav-h)
          plus clearance for the floating page chip that sits above it. The
          reservation is unconditional (not gated on totalPages) so the list
          never reflows when the page count resolves. Desktop (>=md) keeps the
          original pb-6 — its FloatingPageNav pill stays bottom-right and never
          overlays content. The pb breakpoint is md (not sm) to match where the
          bottom nav hides. */}
      <main className="mx-auto max-w-7xl px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(var(--bottom-nav-h)+3rem)] md:pt-6 md:pb-6">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}

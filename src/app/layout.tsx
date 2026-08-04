import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/shared/providers/providers';
import { ErrorBoundary } from '@/shared/components/ErrorBoundary';
import { UpdateBanner } from '@/shared/components/UpdateBanner';

export const metadata: Metadata = {
  title: 'HiPaGo',
  description: 'Cross-platform gallery viewer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
          (function() {
            try {
              var stored = localStorage.getItem('hipago-settings');
              if (stored) {
                var parsed = JSON.parse(stored);
                var theme = parsed.state && parsed.state.theme;
                if (theme === 'dark') {
                  document.documentElement.classList.add('dark');
                }
              }
            } catch(e) { /* Recoverable: localStorage parse failure — default to light theme */ }
          })();
        `,
          }}
        />
      </head>
      <body className="antialiased">
        <Providers>
          <UpdateBanner />
          <ErrorBoundary>{children}</ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}

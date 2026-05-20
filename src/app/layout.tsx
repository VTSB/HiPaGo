import type { Metadata } from 'next';
import { Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/shared/providers/providers';
import { ErrorBoundary } from '@/shared/components/ErrorBoundary';
import { UpdateBanner } from '@/shared/components/UpdateBanner';

const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'HiPaGo',
  description: 'Cross-platform gallery viewer',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <script dangerouslySetInnerHTML={{ __html: `
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
        ` }} />
      </head>
      <body className={`${geistMono.variable} antialiased`}>
        <Providers>
          <UpdateBanner />
          <ErrorBoundary>{children}</ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}

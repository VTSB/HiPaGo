'use client';

import { Component, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/useT';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({ error, onReset }: { error: Error | null; onReset: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-2 text-xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('error.title')}
        </h1>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          {t('error.unexpected')}
        </p>
        {error && (
          <pre className="mb-4 overflow-auto rounded bg-zinc-100 p-3 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
            {error.message}
          </pre>
        )}
        <button
          onClick={onReset}
          className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {t('error.tryAgain')}
        </button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} onReset={this.handleReset} />;
    }
    return this.props.children;
  }
}

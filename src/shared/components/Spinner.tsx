interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'inline' | 'page' | 'overlay';
  className?: string;
}

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

export function Spinner({ size = 'md', variant, className = '' }: SpinnerProps) {
  const spinner = (
    <div
      className={`animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-600 dark:border-t-zinc-100 ${sizeClasses[size]} ${className}`}
      role="status"
      aria-label="Loading"
    />
  );

  if (variant === 'page') {
    return <div className="flex justify-center py-12">{spinner}</div>;
  }
  if (variant === 'overlay') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-zinc-900/50">
        {spinner}
      </div>
    );
  }
  return spinner;
}

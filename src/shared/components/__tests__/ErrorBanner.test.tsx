// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import { ErrorBanner } from '../ErrorBanner';

describe('ErrorBanner', () => {
  it('renders title, description and the detail string', () => {
    const { container, getByText } = render(
      <ErrorBanner title="Sync failed" description="needs the tag DB" detail="boom: status 502" />,
    );
    expect(getByText('Sync failed')).toBeTruthy();
    expect(getByText('needs the tag DB')).toBeTruthy();
    expect(container.textContent).toContain('boom: status 502');
  });

  it('copies the detail string verbatim via the Copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { getByText } = render(
      <ErrorBanner title="t" description="d" detail="exact-error-string" />,
    );
    await act(async () => {
      fireEvent.click(getByText('db.error.copy'));
    });
    expect(writeText).toHaveBeenCalledWith('exact-error-string');
  });

  it('renders the action button and invokes it only when an action is provided', () => {
    const onClick = vi.fn();
    const { getByText } = render(
      <ErrorBanner title="t" description="d" detail="x" action={{ label: 'Retry', onClick }} />,
    );
    act(() => {
      fireEvent.click(getByText('Retry'));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no action button when action is omitted', () => {
    const { queryByText } = render(<ErrorBanner title="t" description="d" detail="x" />);
    // Only the Copy button is present.
    expect(queryByText('Retry')).toBeNull();
    expect(queryByText('db.error.copy')).toBeTruthy();
  });
});

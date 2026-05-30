// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import { DbErrorBanner } from '../DbErrorBanner';
import { useDbStatusStore } from '@/lib/store/db-status';

describe('DbErrorBanner', () => {
  afterEach(() => {
    useDbStatusStore.setState({ dbError: null, dbInitStage: null });
  });

  it('renders nothing when there is no dbError', () => {
    useDbStatusStore.setState({ dbError: null, dbInitStage: null });
    const { container } = render(<DbErrorBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('surfaces the actual error message so the on-device cause is visible', () => {
    useDbStatusStore.setState({
      dbError: 'capacitor: open failed: unable to open database file',
      dbInitStage: null,
    });
    const { container } = render(<DbErrorBanner />);
    expect(container.textContent).toContain(
      'capacitor: open failed: unable to open database file',
    );
  });

  it('prefixes the stuck init stage when present', () => {
    useDbStatusStore.setState({
      dbError: 'boom',
      dbInitStage: 'opening connection (capacitor)',
    });
    const { container } = render(<DbErrorBanner />);
    expect(container.textContent).toContain('[opening connection (capacitor)] boom');
  });

  it('copies the full diagnostic via the Copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useDbStatusStore.setState({
      dbError: 'boom',
      dbInitStage: 'opening connection (capacitor)',
    });
    const { getByText } = render(<DbErrorBanner />);
    await act(async () => {
      fireEvent.click(getByText('db.error.copy'));
    });
    expect(writeText).toHaveBeenCalledWith('[opening connection (capacitor)] boom');
  });
});

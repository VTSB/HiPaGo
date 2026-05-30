// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import { DbErrorOverlay } from '../DbErrorOverlay';
import { useDbStatusStore } from '@/lib/store/db-status';

describe('DbErrorOverlay', () => {
  afterEach(() => {
    useDbStatusStore.setState({ dbError: null, dbInitStage: null });
  });

  it('renders nothing when there is no dbError', () => {
    useDbStatusStore.setState({ dbError: null, dbInitStage: null });
    const { container } = render(<DbErrorOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('surfaces the failing stage + native message on any screen', () => {
    useDbStatusStore.setState({
      dbError: 'capacitor: open failed: unable to open database file',
      dbInitStage: 'opening connection (capacitor)',
    });
    const { container } = render(<DbErrorOverlay />);
    expect(container.textContent).toContain(
      '[opening connection (capacitor)] capacitor: open failed: unable to open database file',
    );
  });

  it('copies the full diagnostic to the clipboard on Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useDbStatusStore.setState({
      dbError: 'boom',
      dbInitStage: 'opening connection (capacitor)',
    });
    const { getByText } = render(<DbErrorOverlay />);
    await act(async () => {
      fireEvent.click(getByText('db.error.copy'));
    });
    expect(writeText).toHaveBeenCalledWith('[opening connection (capacitor)] boom');
  });

  it('hides after dismiss', () => {
    useDbStatusStore.setState({ dbError: 'boom', dbInitStage: null });
    const { container, getByLabelText } = render(<DbErrorOverlay />);
    expect(container.firstChild).not.toBeNull();
    fireEvent.click(getByLabelText('db.error.dismiss'));
    expect(container.firstChild).toBeNull();
  });
});

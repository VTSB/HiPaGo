// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { UpdateCheckCard } from '../UpdateCheckCard';
import { UpdateService } from '@/services/UpdateService';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/services/UpdateService', () => ({
  UpdateService: {
    checkForUpdate: vi.fn(),
  },
  CURRENT_VERSION: '0.0.11',
}));

describe('UpdateCheckCard — no layout shift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an always-present reserved status slot in the idle state', () => {
    render(<UpdateCheckCard />);

    // The slot exists before any check runs, reserving its height so the
    // result later fills pre-allocated space instead of pushing the page down.
    const slot = screen.getByTestId('update-status-slot');
    expect(slot).toBeInTheDocument();
    // Idle: no outcome text yet.
    expect(within(slot).queryByText('update.about.upToDate')).not.toBeInTheDocument();
  });

  it('renders the up-to-date result inside the pre-reserved slot (no new flow block)', async () => {
    vi.mocked(UpdateService.checkForUpdate).mockResolvedValue({
      available: false,
    });

    render(<UpdateCheckCard />);
    const slotBefore = screen.getByTestId('update-status-slot');

    fireEvent.click(screen.getByRole('button', { name: 'update.about.check' }));

    await waitFor(() => {
      expect(screen.getByText('update.about.upToDate')).toBeInTheDocument();
    });

    // The message must live inside the same reserved slot element — i.e. it
    // was not appended as a brand-new sibling block in the document flow.
    const slotAfter = screen.getByTestId('update-status-slot');
    expect(slotAfter).toBe(slotBefore);
    expect(within(slotAfter).getByText('update.about.upToDate')).toBeInTheDocument();
  });
});

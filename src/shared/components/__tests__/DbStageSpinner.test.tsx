// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import { DbStageSpinner } from '../DbStageSpinner';
import { useDbStatusStore } from '@/lib/store/db-status';

describe('DbStageSpinner', () => {
  afterEach(() => {
    useDbStatusStore.setState({ dbInitStage: null });
  });

  it('shows only the spinner when no init stage is set', () => {
    useDbStatusStore.setState({ dbInitStage: null });
    const { container } = render(<DbStageSpinner />);
    expect(container.textContent).not.toContain('db.preparing');
  });

  it('shows the current init stage so a hang stays visible on screen', () => {
    useDbStatusStore.setState({ dbInitStage: 'opening connection (capacitor)' });
    const { container } = render(<DbStageSpinner />);
    expect(container.textContent).toContain('db.preparing');
    expect(container.textContent).toContain('(opening connection (capacitor))');
  });
});

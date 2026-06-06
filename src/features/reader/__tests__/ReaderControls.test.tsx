// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReaderControls } from '../components/ReaderControls';

const mockSetDualPage = vi.fn();

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (
    sel: (s: {
      dualPage: boolean;
      setDualPage: (value: boolean) => void;
      locale: 'en' | 'ko';
    }) => unknown,
  ) => sel({ dualPage: false, setDualPage: mockSetDualPage, locale: 'en' }),
}));

describe('ReaderControls', () => {
  it('centers the mobile toolbar without an x-axis translate transform', () => {
    render(
      <ReaderControls
        onBack={vi.fn()}
        currentPage={3}
        totalPages={23}
        mode="page"
        onModeChange={vi.fn()}
        onNextPage={vi.fn()}
        onPrevPage={vi.fn()}
        onPageChange={vi.fn()}
      />,
    );

    const wrapper = screen.getByRole('button', { name: /back/i }).parentElement
      ?.parentElement as HTMLElement;
    const toolbar = screen.getByRole('button', { name: /back/i }).parentElement as HTMLElement;

    expect(wrapper.className).toContain('inset-x-0');
    expect(wrapper.className).toContain('justify-center');
    expect(wrapper.className).not.toContain('-translate-x-1/2');
    expect(toolbar.className).toContain('max-w-[calc(100vw-1rem)]');
  });
});

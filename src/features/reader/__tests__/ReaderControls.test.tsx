// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
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
        dualPage={false}
        onDualPageChange={vi.fn()}
        fullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const wrapper = screen.getByRole('button', { name: /back/i }).parentElement
      ?.parentElement as HTMLElement;
    const toolbar = screen.getByRole('button', { name: /back/i }).parentElement as HTMLElement;

    expect(wrapper.className).toContain('inset-x-0');
    expect(wrapper.className).toContain('justify-center');
    expect(wrapper.className).toContain('sm:right-[calc(1rem+env(safe-area-inset-right))]');
    expect(wrapper.className).toContain('sm:bottom-[calc(1rem+env(safe-area-inset-bottom))]');
    expect(wrapper.className).not.toContain('-translate-x-1/2');
    expect(toolbar.className).toContain('max-w-[calc(100vw-1rem)]');
    expect(toolbar).toHaveAttribute('role', 'toolbar');
  });

  it('focuses the page input and cancels editing with Escape', () => {
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
        dualPage={false}
        onDualPageChange={vi.fn()}
        fullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /jump to page/i }));
    const input = screen.getByRole('spinbutton', { name: /jump to page/i });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /jump to page/i })).toBeInTheDocument();
  });

  it('shows a spread range and disables next on the final two-page spread', () => {
    render(
      <ReaderControls
        onBack={vi.fn()}
        currentPage={2}
        totalPages={4}
        mode="page"
        onModeChange={vi.fn()}
        onNextPage={vi.fn()}
        onPrevPage={vi.fn()}
        onPageChange={vi.fn()}
        dualPage
        onDualPageChange={vi.fn()}
        fullscreen={false}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /jump to page/i })).toHaveTextContent('3–4 / 4');
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /single-page view/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

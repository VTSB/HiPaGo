// @vitest-environment jsdom
import React from 'react';
import Link from 'next/link';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act, cleanup, screen } from '@testing-library/react';
import { GalleryActionTarget } from '../GalleryActionTarget';
import { GalleryActionsContext, type GalleryActions } from '@/shared/hooks/useGalleryActions';

const open = vi.fn();
const actions: GalleryActions = {
  open,
  close: vi.fn(),
  save: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  deleteFiles: vi.fn(),
  collections: vi.fn(),
};
function renderTarget(props: Partial<React.ComponentProps<typeof GalleryActionTarget>> = {}) {
  const click = vi.fn();
  const result = render(
    <GalleryActionsContext.Provider value={actions}>
      <GalleryActionTarget gallery={{ id: 12, title: 'Work' }} {...props}>
        <Link href="/gallery/12" onClick={click}>
          Work
        </Link>
      </GalleryActionTarget>
    </GalleryActionsContext.Provider>,
  );
  const link = screen.getByRole('link');
  return { ...result, link, target: link.parentElement!, click };
}
function pointer(target: Element, type: string, overrides: Record<string, unknown> = {}) {
  fireEvent(
    target,
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      button: 0,
      isPrimary: true,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      ...overrides,
    }),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  open.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('gallery gestures', () => {
  it('uses the folder override for holds and suppresses duplicate menus and release navigation', () => {
    const onOpen = vi.fn();
    const { target, link, click } = renderTarget({ onOpen });
    pointer(target, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(undefined);
    fireEvent.contextMenu(target);
    pointer(target, 'pointerup');
    expect(fireEvent.click(link)).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the folder override for anchored context and keyboard menus', () => {
    const onOpen = vi.fn();
    const { link } = renderTarget({ onOpen });
    fireEvent.contextMenu(link, { clientX: 140, clientY: 200 });
    expect(onOpen).toHaveBeenLastCalledWith({ x: 140, y: 200 });
    fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
    expect(onOpen).toHaveBeenLastCalledWith({ x: 16, y: 16 });
    fireEvent.keyDown(link, { key: 'ContextMenu' });
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(open).not.toHaveBeenCalled();
  });

  it('cancels a moved folder hold and preserves its normal navigation', () => {
    const onOpen = vi.fn();
    const { target, link, click } = renderTarget({ onOpen });
    pointer(target, 'pointerdown');
    pointer(target, 'pointermove', { clientX: 30 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    pointer(target, 'pointerup');
    fireEvent.click(link);
    expect(click).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it('opens one long-press sheet and suppresses the release click', () => {
    const { target, link, click } = renderTarget();
    pointer(target, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(open).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ id: 12, title: 'Work' }, undefined, undefined);
    fireEvent.contextMenu(target);
    expect(open).toHaveBeenCalledTimes(1);
    pointer(target, 'pointerup');
    expect(fireEvent.click(link)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['movement', 'scroll', 'cancel', 'release', 'unmount'])(
    'cancels a pending hold on %s',
    (reason) => {
      const { target, unmount } = renderTarget();
      pointer(target, 'pointerdown');
      if (reason === 'movement') pointer(target, 'pointermove', { clientX: 30 });
      if (reason === 'scroll') fireEvent.scroll(window);
      if (reason === 'cancel') pointer(target, 'pointercancel');
      if (reason === 'release') pointer(target, 'pointerup');
      if (reason === 'unmount') unmount();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('keeps normal clicks and modified link clicks available', () => {
    const { target, link, click } = renderTarget();
    pointer(target, 'pointerdown');
    pointer(target, 'pointerup');
    fireEvent.click(link, { ctrlKey: true });
    expect(click).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a desktop context menu and supports Shift+F10', () => {
    const { link } = renderTarget();
    fireEvent.contextMenu(link, { clientX: 140, clientY: 200 });
    expect(open).toHaveBeenLastCalledWith({ id: 12, title: 'Work' }, { x: 140, y: 200 }, undefined);
    open.mockClear();
    fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][1]).toEqual({ x: 16, y: 16 });
  });

  it('selects instead of navigating only for an unmodified click in selection mode', () => {
    const select = vi.fn();
    const { link, click, target } = renderTarget({ onSelect: select, selected: true });
    expect(target).toHaveAttribute('data-selected', 'true');
    expect(fireEvent.click(link)).toBe(false);
    expect(select).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(link, { metaKey: true });
    expect(click).toHaveBeenCalledOnce();
    pointer(target, 'pointerdown');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('supports Space and Enter selection with checkbox state and a single focus target', () => {
    const select = vi.fn();
    render(
      <GalleryActionsContext.Provider value={actions}>
        <GalleryActionTarget gallery={{ id: 12, title: 'Work' }} selected={false} onSelect={select}>
          <Link href="/gallery/12" tabIndex={-1}>
            Work
          </Link>
        </GalleryActionTarget>
      </GalleryActionsContext.Provider>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Work' });
    expect(checkbox).toHaveAttribute('tabindex', '0');
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('link')).toHaveAttribute('tabindex', '-1');
    checkbox.focus();
    expect(fireEvent.keyDown(checkbox, { key: ' ' })).toBe(false);
    expect(select).toHaveBeenCalledOnce();
    expect(fireEvent.keyDown(checkbox, { key: 'Enter' })).toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it('makes a failed card with plain content reachable for the keyboard context menu', () => {
    render(
      <GalleryActionsContext.Provider value={actions}>
        <GalleryActionTarget gallery={{ id: 12 }} focusable>
          <span>Unavailable</span>
        </GalleryActionTarget>
      </GalleryActionsContext.Provider>,
    );
    const target = screen.getByRole('group', { name: '#12' });
    expect(target).toHaveAttribute('tabindex', '0');
    target.focus();
    expect(target).toHaveFocus();
    expect(fireEvent.keyDown(target, { key: 'ContextMenu' })).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toEqual({ id: 12 });
  });
});

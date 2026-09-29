// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ActionMenu } from '../ActionMenu';
import { ConfirmActionDialog } from '../ConfirmActionDialog';
let mobile = false;
vi.mock('@/shared/hooks/useIsMobile', () => ({ useIsMobile: () => mobile }));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));
const items = [
  { key: 'read', label: 'Read', action: vi.fn() },
  { key: 'delete', label: 'Delete files', action: vi.fn(), destructive: true },
];
beforeEach(() => {
  mobile = false;
});
afterEach(cleanup);

describe('common menu accessibility', () => {
  it('traps focus, supports context-menu arrows/Escape and restores the trigger', async () => {
    const close = vi.fn();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <ActionMenu title="Work" items={items} onClose={close} anchor={{ x: 10, y: 20 }} />,
    );
    expect(screen.getByRole('menu')).toHaveAccessibleName('Work');
    expect(screen.getByLabelText('actions.cancel')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Read' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Delete files' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByLabelText('actions.cancel')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
    trigger.remove();
  });

  it('uses a modal bottom sheet on mobile with the same actions', () => {
    mobile = true;
    render(<ActionMenu title="Work" items={items} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete files' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('exposes mutation errors and disables actions while busy', () => {
    render(
      <ActionMenu title="Work" items={items} onClose={vi.fn()} error="Storage unavailable" busy />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
    expect(screen.getByRole('menuitem', { name: 'Delete files' })).toBeDisabled();
    expect(screen.getByRole('menu')).toHaveFocus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(screen.getByRole('menu')).toHaveFocus();
  });
});

describe('explicit destructive confirmation', () => {
  it('cancels on Android overlay back before navigation and never confirms implicitly', () => {
    const cancel = vi.fn();
    const confirm = vi.fn();
    render(
      <ConfirmActionDialog
        title="Remove saved work?"
        message="Local files will also be removed."
        onCancel={cancel}
        onConfirm={confirm}
      />,
    );
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
      'Local files will also be removed.',
    );
    expect(screen.getByRole('button', { name: 'actions.cancel' })).toHaveFocus();
    const event = new Event('hipago:overlay-back', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps an in-flight destructive operation protected from accidental dismissal', () => {
    const cancel = vi.fn();
    render(<ConfirmActionDialog title="Delete" onCancel={cancel} onConfirm={vi.fn()} busy />);
    fireEvent.keyDown(document, { key: 'Escape' });
    window.dispatchEvent(new Event('hipago:overlay-back', { cancelable: true }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'actions.cancel' })).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toHaveFocus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false);
    expect(screen.getByRole('alertdialog')).toHaveFocus();
  });
});

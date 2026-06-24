// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadQueueView } from '../DownloadQueueView';
import type { QueueItem } from '@/lib/store/download-progress';

let latestDragEnd: ((event: unknown) => void) | null = null;

const state = {
  queue: [] as QueueItem[],
  globalPaused: false,
  refreshQueue: vi.fn(async () => {}),
  reorder: vi.fn(async () => {}),
  pauseAll: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  cancel: vi.fn(),
};

vi.mock('@/lib/store/download-progress', () => ({
  useDownloadProgressStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd: (event: unknown) => void;
  }) => {
    latestDragEnd = onDragEnd;
    return <div data-testid="dnd-context">{children}</div>;
  },
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sortable-context">{children}</div>
  ),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
  arrayMove: <T,>(items: T[], from: number, to: number): T[] => {
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/shared/components/Spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/shared/components/AbortableImage', () => ({
  AbortableImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} />,
}));

describe('DownloadQueueView', () => {
  beforeEach(() => {
    state.queue = [];
    state.globalPaused = false;
    latestDragEnd = null;
    vi.clearAllMocks();
  });

  it('renders every active downloading row in the status panel', () => {
    state.queue = [
      {
        id: 1,
        title: 'First download',
        thumbnail: '',
        status: 'downloading',
        position: null,
        progress: { current: 2, total: 10 },
      },
      {
        id: 2,
        title: 'Second download',
        thumbnail: '',
        status: 'downloading',
        position: null,
        progress: { current: 1, total: 4 },
      },
    ];

    render(<DownloadQueueView />);

    expect(screen.getByText('First download')).toBeTruthy();
    expect(screen.getByText('Second download')).toBeTruthy();
    expect(screen.getByText('2/10 · 20%')).toBeTruthy();
    expect(screen.getByText('1/4 · 25%')).toBeTruthy();
    expect(screen.getByText('(2)')).toBeTruthy();
  });

  it('routes active pause and cancel buttons to the store actions', () => {
    state.queue = [
      {
        id: 10,
        title: 'Active download',
        thumbnail: '',
        status: 'downloading',
        position: null,
        progress: { current: 2, total: 10 },
      },
    ];

    render(<DownloadQueueView />);

    fireEvent.click(screen.getByRole('button', { name: 'library.queue.pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'library.queue.cancel' }));

    expect(state.pause).toHaveBeenCalledWith(10);
    expect(state.cancel).toHaveBeenCalledWith(10);
  });

  it('routes queued pause and paused resume buttons to the store actions', () => {
    state.queue = [
      {
        id: 20,
        title: 'Queued download',
        thumbnail: '',
        status: 'queued',
        position: 1,
        progress: null,
      },
      {
        id: 21,
        title: 'Paused download',
        thumbnail: '',
        status: 'paused',
        position: 2,
        progress: null,
      },
    ];

    render(<DownloadQueueView />);

    fireEvent.click(screen.getByRole('button', { name: 'library.queue.pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'library.queue.resume' }));

    expect(state.pause).toHaveBeenCalledWith(20);
    expect(state.resume).toHaveBeenCalledWith(21);
  });

  it('toggles pauseAll and resumeAll from the header button', () => {
    state.queue = [
      {
        id: 30,
        title: 'Queued download',
        thumbnail: '',
        status: 'queued',
        position: 1,
        progress: null,
      },
    ];

    const { rerender } = render(<DownloadQueueView />);

    fireEvent.click(screen.getByRole('button', { name: /library.queue.pauseAll/ }));
    expect(state.pauseAll).toHaveBeenCalled();

    state.globalPaused = true;
    rerender(<DownloadQueueView />);

    fireEvent.click(screen.getByRole('button', { name: /library.queue.resumeAll/ }));
    expect(state.resumeAll).toHaveBeenCalled();
  });

  it('reorders pending rows by sparse queue positions while ignoring active rows', () => {
    state.queue = [
      {
        id: 99,
        title: 'Active download',
        thumbnail: '',
        status: 'downloading',
        position: null,
        progress: { current: 1, total: 10 },
      },
      {
        id: 1,
        title: 'First pending',
        thumbnail: '',
        status: 'queued',
        position: 10,
        progress: null,
      },
      {
        id: 2,
        title: 'Second pending',
        thumbnail: '',
        status: 'queued',
        position: 20,
        progress: null,
      },
      {
        id: 3,
        title: 'Third pending',
        thumbnail: '',
        status: 'paused',
        position: 30,
        progress: null,
      },
    ];

    render(<DownloadQueueView />);

    expect(latestDragEnd).toBeTruthy();
    latestDragEnd?.({ active: { id: 3 }, over: { id: 1 } });

    expect(state.reorder).toHaveBeenCalledWith(3, 9);
  });
});

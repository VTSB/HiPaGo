'use client';

import { useEffect, useMemo } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Spinner } from '@/shared/components/Spinner';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { useT } from '@/lib/i18n/useT';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import { useDownloadProgressStore, type QueueItem } from '@/lib/store/download-progress';

// ---------------------------------------------------------------------------
// Shared row chrome
// ---------------------------------------------------------------------------

/** A small square cover thumbnail for a queue row. Falls back to the id when no thumb. */
function QueueThumb({ item }: { item: QueueItem }) {
  const src = item.thumbnail ? resolveThumbnailUrl(item.thumbnail) : null;
  return (
    <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded-md bg-zinc-200 dark:bg-zinc-700">
      {src ? (
        <AbortableImage src={src} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center text-[10px] text-zinc-400">
          #{item.id}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  destructive = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 transition-colors active:bg-zinc-200 sm:hover:bg-zinc-200 dark:text-zinc-300 dark:active:bg-zinc-700 dark:sm:hover:bg-zinc-700 ${
        destructive ? 'hover:text-red-600 dark:hover:text-red-400' : ''
      }`}
    >
      {children}
    </button>
  );
}

const PauseIcon = (
  <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <rect x="4" y="3" width="3" height="10" rx="1" />
    <rect x="9" y="3" width="3" height="10" rx="1" />
  </svg>
);
const ResumeIcon = (
  <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <path d="M5 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 5 3.5z" />
  </svg>
);
const CancelIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
);
const DragIcon = (
  <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
    <circle cx="6" cy="4" r="1.1" /><circle cx="10" cy="4" r="1.1" />
    <circle cx="6" cy="8" r="1.1" /><circle cx="10" cy="8" r="1.1" />
    <circle cx="6" cy="12" r="1.1" /><circle cx="10" cy="12" r="1.1" />
  </svg>
);

// ---------------------------------------------------------------------------
// Active (in-flight) item — live progress bar, NOT draggable.
// ---------------------------------------------------------------------------

function ActiveRow({ item }: { item: QueueItem }) {
  const t = useT();
  const pause = useDownloadProgressStore((s) => s.pause);
  const cancel = useDownloadProgressStore((s) => s.cancel);

  const current = item.progress?.current ?? 0;
  const total = item.progress?.total ?? 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className="flex items-center gap-3 rounded-xl bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800/60">
      <QueueThumb item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <h4 className="line-clamp-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {item.title || `#${item.id}`}
          </h4>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div
              className="h-full rounded-full bg-blue-600 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {current}/{total} · {pct}%
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <IconButton label={t('library.queue.pause')} onClick={() => void pause(item.id)}>
          {PauseIcon}
        </IconButton>
        <IconButton label={t('library.queue.cancel')} onClick={() => cancel(item.id)} destructive>
          {CancelIcon}
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending (queued/paused) item — sortable via drag handle.
// ---------------------------------------------------------------------------

function PendingRow({ item }: { item: QueueItem }) {
  const t = useT();
  const pause = useDownloadProgressStore((s) => s.pause);
  const resume = useDownloadProgressStore((s) => s.resume);
  const cancel = useDownloadProgressStore((s) => s.cancel);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const isPaused = item.status === 'paused';
  const statusLabel = isPaused ? t('library.queue.paused') : t('library.queue.queued');

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-xl bg-white px-2 py-2 dark:bg-zinc-900 ${
        isDragging ? 'z-10 shadow-lg ring-1 ring-zinc-300 dark:ring-zinc-600' : ''
      }`}
    >
      <button
        type="button"
        aria-label={t('library.queue.reorder')}
        title={t('library.queue.reorder')}
        className="inline-flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center text-zinc-400 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        {DragIcon}
      </button>
      <QueueThumb item={item} />
      <div className="min-w-0 flex-1">
        <h4 className="line-clamp-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {item.title || `#${item.id}`}
        </h4>
        <span
          className={`text-xs ${
            isPaused ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {statusLabel}
        </span>
      </div>
      <div className="flex shrink-0 items-center">
        {isPaused ? (
          <IconButton label={t('library.queue.resume')} onClick={() => void resume(item.id)}>
            {ResumeIcon}
          </IconButton>
        ) : (
          <IconButton label={t('library.queue.pause')} onClick={() => void pause(item.id)}>
            {PauseIcon}
          </IconButton>
        )}
        <IconButton label={t('library.queue.cancel')} onClick={() => cancel(item.id)} destructive>
          {CancelIcon}
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view — active item (fixed top) + drag-sortable pending list.
// ---------------------------------------------------------------------------

export function DownloadQueueView() {
  const t = useT();
  const queue = useDownloadProgressStore((s) => s.queue);
  const globalPaused = useDownloadProgressStore((s) => s.globalPaused);
  const refreshQueue = useDownloadProgressStore((s) => s.refreshQueue);
  const reorder = useDownloadProgressStore((s) => s.reorder);
  const pauseAll = useDownloadProgressStore((s) => s.pauseAll);
  const resumeAll = useDownloadProgressStore((s) => s.resumeAll);

  // Seed the queue from the DB on mount (the processor refreshes it thereafter).
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const active = queue.find((q) => q.status === 'downloading') ?? null;
  const pending = useMemo(() => queue.filter((q) => q.status !== 'downloading'), [queue]);
  const pendingIds = useMemo(() => pending.map((p) => p.id), [pending]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active: dragged, over } = e;
    if (!over || dragged.id === over.id) return;
    const oldIndex = pendingIds.indexOf(Number(dragged.id));
    const newIndex = pendingIds.indexOf(Number(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    // Compute the new ordering and translate the target slot into a concrete
    // queuePosition. Place the dragged item between its new neighbours so the
    // relative order matches what the user sees (positions are sparse).
    const reordered = arrayMove(pending, oldIndex, newIndex);
    const prev = reordered[newIndex - 1]?.position ?? null;
    const nextItem = reordered[newIndex + 1]?.position ?? null;
    let target: number;
    if (prev !== null && nextItem !== null) target = (prev + nextItem) / 2;
    else if (prev !== null) target = prev + 1;
    else if (nextItem !== null) target = nextItem - 1;
    else target = 0;

    void reorder(Number(dragged.id), target);
  };

  // Empty → render nothing (the section is hidden).
  if (queue.length === 0) return null;

  return (
    <section className="mb-5 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {t('library.queue.title')}
          <span className="ml-1.5 font-normal text-zinc-500">({queue.length})</span>
        </h2>
        <button
          type="button"
          onClick={() => void (globalPaused ? resumeAll() : pauseAll())}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-zinc-100 px-3 text-xs font-medium text-zinc-700 active:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:active:bg-zinc-700"
        >
          {globalPaused ? ResumeIcon : PauseIcon}
          {globalPaused ? t('library.queue.resumeAll') : t('library.queue.pauseAll')}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {active && <ActiveRow item={active} />}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={pendingIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {pending.map((item) => (
                <PendingRow key={item.id} item={item} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}

import { describe, it, expect } from 'vitest';
import { ImageLoadScheduler, viewportDistance } from '../imageLoadScheduler';

const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); };

describe('ImageLoadScheduler', () => {
  it('holds background dispatch until a display grant has actually started', async () => {
    const scheduler = new ImageLoadScheduler({ start: 4, min: 4, max: 4 });
    const order: string[] = [];
    const warm = scheduler.acquire(() => 1, { background: () => true });
    warm.granted.then(() => order.push('warm'));
    const display = scheduler.acquire(() => 0, { awaitStart: true });
    display.granted.then(() => order.push('display grant'));
    await flush();
    expect(order).toEqual(['display grant']);
    expect(scheduler.activeCount).toBe(1);
    display.markStarted();
    await flush();
    expect(order).toEqual(['display grant', 'warm']);
    display.release();
    warm.release();
  });

  it('unblocks background work if a display disappears before acknowledging its start', async () => {
    const scheduler = new ImageLoadScheduler({ start: 4, min: 4, max: 4 });
    const display = scheduler.acquire(() => 0, { awaitStart: true });
    const warm = scheduler.acquire(() => 1, { background: () => true });
    let started = false;
    warm.granted.then(() => { started = true; });
    await flush();
    expect(started).toBe(false);
    display.release();
    await flush();
    expect(started).toBe(true);
    warm.release();
  });

  it('batches cold starts so visible demand wins over earlier distant mounts', async () => {
    const scheduler = new ImageLoadScheduler({ start: 2, min: 2, max: 2 });
    const order: string[] = [];
    scheduler.acquire(() => 400).granted.then(() => order.push('far'));
    scheduler.acquire(() => 20).granted.then(() => order.push('near'));
    scheduler.acquire(() => 0).granted.then(() => order.push('visible'));
    expect(scheduler.activeCount).toBe(0);
    await flush();
    expect(order).toEqual(['visible', 'near']);
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.pendingCount).toBe(1);
  });

  it('re-evaluates distance when capacity becomes available after scrolling', async () => {
    const scheduler = new ImageLoadScheduler({ start: 1, min: 1, max: 1 });
    const active = scheduler.acquire(() => 0);
    await flush();
    let distance = 100;
    const order: string[] = [];
    scheduler.acquire(() => 50).granted.then(() => order.push('old-near'));
    scheduler.acquire(() => distance).granted.then(() => order.push('now-visible'));
    distance = 0;
    active.release();
    await flush();
    expect(order).toEqual(['now-visible']);
  });

  it('reserves demand capacity even when only background work arrived first', async () => {
    const scheduler = new ImageLoadScheduler({ start: 3, min: 3, max: 3 });
    const order: string[] = [];
    for (let i = 0; i < 6; i++) scheduler.acquire(() => i, { background: () => true });
    await flush();
    expect(scheduler.activeCount).toBe(2);
    scheduler.acquire(() => 500).granted.then(() => order.push('demand'));
    await flush();
    expect(order).toEqual(['demand']);
    expect(scheduler.activeCount).toBe(3);
  });

  it('promotes an existing queued background job without a duplicate grant', async () => {
    const scheduler = new ImageLoadScheduler({ start: 2, min: 2, max: 2 });
    scheduler.acquire(() => 0, { background: () => true });
    await flush();
    let background = true;
    let granted = false;
    scheduler.acquire(() => 0, { background: () => background }).granted.then(() => { granted = true; });
    await flush();
    expect(granted).toBe(false);
    background = false;
    scheduler.refresh();
    await flush();
    expect(granted).toBe(true);
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('cancels queued work and releases grants idempotently without reducing the cap', async () => {
    const scheduler = new ImageLoadScheduler({ start: 3, min: 1, max: 4 });
    const cancelled = scheduler.acquire(() => 0);
    cancelled.cancel();
    const active = scheduler.acquire(() => 0);
    const other = scheduler.acquire(() => 0);
    await flush();
    expect(scheduler.activeCount).toBe(2);
    active.release();
    active.release();
    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.concurrencyLimit).toBe(3);
    other.release();
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('eventually dispatches all demand without exceeding the cap', async () => {
    const scheduler = new ImageLoadScheduler({ start: 2, min: 2, max: 2 });
    let completed = 0;
    for (let i = 0; i < 12; i++) {
      const handle = scheduler.acquire(() => i);
      void handle.granted.then(() => {
        expect(scheduler.activeCount).toBeLessThanOrEqual(2);
        completed++;
        handle.release();
      });
    }
    for (let i = 0; i < 15; i++) await flush();
    expect(completed).toBe(12);
    expect(scheduler.activeCount).toBe(0);
  });

  it('adapts only on real completion samples, within configured limits', async () => {
    const scheduler = new ImageLoadScheduler({ start: 2, min: 1, max: 3 });
    for (let i = 0; i < 12; i++) scheduler.acquire(() => 0);
    await flush();
    scheduler.release({ ok: true, ms: 200 });
    await flush();
    scheduler.release({ ok: true, ms: 100 });
    await flush();
    expect(scheduler.concurrencyLimit).toBe(3);
    scheduler.release({ ok: true, ms: 40 });
    await flush();
    expect(scheduler.concurrencyLimit).toBe(3);
    scheduler.release({ ok: false, ms: 5000 });
    await flush();
    expect(scheduler.concurrencyLimit).toBe(1);
    scheduler.release({ ok: false, ms: 5000 });
    expect(scheduler.concurrencyLimit).toBe(1);
  });
});

describe('viewportDistance', () => {
  it('uses the nearest edge above or below, regardless of image height', () => {
    expect(viewportDistance({ top: -500, bottom: -5, left: 20, right: 40 }, 100, 100)).toBe(5);
    expect(viewportDistance({ top: 110, bottom: 610, left: 20, right: 40 }, 100, 100)).toBe(10);
  });
  it('ranks edge-only contact after visible overlap', () => {
    expect(viewportDistance({ top: -100, bottom: 0, left: 20, right: 40 }, 100, 100)).toBeGreaterThan(0);
    expect(viewportDistance({ top: 20, bottom: 40, left: 100, right: 200 }, 100, 100)).toBeGreaterThan(0);
    expect(viewportDistance({ top: -100, bottom: 1, left: 20, right: 40 }, 100, 100)).toBe(0);
  });
  it('accounts for horizontal distance and diagonal separation', () => {
    expect(viewportDistance({ top: 10, bottom: 30, left: 110, right: 210 }, 100, 100)).toBe(10);
    expect(viewportDistance({ top: 140, bottom: 150, left: 130, right: 150 }, 100, 100)).toBe(50);
    expect(viewportDistance({ top: -20, bottom: 30, left: -20, right: 30 }, 100, 100)).toBe(0);
  });
});

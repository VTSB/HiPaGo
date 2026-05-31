import { describe, it, expect } from 'vitest';
import { ImageLoadScheduler } from '../imageLoadScheduler';

const flush = () => Promise.resolve();

describe('ImageLoadScheduler — concurrency + priority', () => {
  it('grants up to the limit immediately and queues the overflow', () => {
    const s = new ImageLoadScheduler({ start: 2, min: 1, max: 4 });
    s.acquire(() => 0);
    s.acquire(() => 0);
    s.acquire(() => 0);
    expect(s.activeCount).toBe(2);
    expect(s.pendingCount).toBe(1);
  });

  it('never exceeds the limit and dispatches the best-priority waiter on release', async () => {
    const s = new ImageLoadScheduler({ start: 2, min: 1, max: 4 });
    const order: string[] = [];
    const mk = (name: string, pri: number) => {
      s.acquire(() => pri).granted.then(() => order.push(name));
    };
    mk('a', 0); // immediate
    mk('b', 0); // immediate
    mk('c', 10); // queued
    mk('d', 5); // queued
    await flush();
    expect(order).toEqual(['a', 'b']);
    expect(s.activeCount).toBe(2);

    s.release({ ok: true, ms: 100 }); // free 1 -> dispatch min(c:10,d:5) = d
    await flush();
    expect(order).toEqual(['a', 'b', 'd']);
    expect(s.activeCount).toBe(2);

    s.release({ ok: true, ms: 100 });
    await flush();
    expect(order).toEqual(['a', 'b', 'd', 'c']);
  });

  it('re-evaluates priority at dispatch time (a now-on-screen waiter jumps the queue)', async () => {
    const s = new ImageLoadScheduler({ start: 1, min: 1, max: 4 });
    const order: string[] = [];
    const x = { p: 100 };
    s.acquire(() => 0).granted.then(() => order.push('first')); // immediate
    s.acquire(() => x.p).granted.then(() => order.push('x')); // queued, far
    s.acquire(() => 50).granted.then(() => order.push('y')); // queued, nearer
    await flush();
    expect(order).toEqual(['first']);

    x.p = 1; // user scrolls x into view
    s.release({ ok: true, ms: 100 }); // dispatch min(x:1, y:50) = x
    await flush();
    expect(order).toEqual(['first', 'x']);
  });

  it('cancel() removes a waiting entry so it never grants', async () => {
    const s = new ImageLoadScheduler({ start: 1, min: 1, max: 2 });
    const order: string[] = [];
    s.acquire(() => 0).granted.then(() => order.push('a')); // immediate
    const c = s.acquire(() => 0);
    c.granted.then(() => order.push('c'));
    c.cancel();
    s.release({ ok: true, ms: 100 });
    await flush();
    expect(order).toEqual(['a']);
    expect(s.pendingCount).toBe(0);
  });

  it('eventually grants every acquire as releases happen (no deadlock)', async () => {
    const s = new ImageLoadScheduler({ start: 2, min: 1, max: 4 });
    let granted = 0;
    const N = 12;
    for (let i = 0; i < N; i += 1) s.acquire(() => i).granted.then(() => (granted += 1));
    await flush();
    while (s.activeCount > 0) {
      s.release({ ok: true, ms: 100 });
      await flush();
    }
    expect(granted).toBe(N);
    expect(s.pendingCount).toBe(0);
  });
});

describe('ImageLoadScheduler — adaptive cap', () => {
  it('grows on fast saturated samples, clamped to max', () => {
    const s = new ImageLoadScheduler({ start: 2, min: 1, max: 3 });
    for (let i = 0; i < 10; i += 1) s.acquire(() => 0); // stays saturated
    expect(s.concurrencyLimit).toBe(2);
    s.release({ ok: true, ms: 200 }); // first sample sets ewma=200, no growth
    expect(s.concurrencyLimit).toBe(2);
    s.release({ ok: true, ms: 100 }); // 100 < 200*0.9 -> grow to 3
    expect(s.concurrencyLimit).toBe(3);
    s.release({ ok: true, ms: 40 }); // fast again but clamp at max 3
    expect(s.concurrencyLimit).toBe(3);
  });

  it('backs off on error/timeout, clamped to min', () => {
    const s = new ImageLoadScheduler({ start: 3, min: 1, max: 4 });
    for (let i = 0; i < 10; i += 1) s.acquire(() => 0);
    s.release({ ok: false, ms: 5000 }); // 3 - 2 = 1
    expect(s.concurrencyLimit).toBe(1);
    s.release({ ok: false, ms: 5000 }); // clamp at min 1
    expect(s.concurrencyLimit).toBe(1);
  });

  it('eases off when latency climbs', () => {
    const s = new ImageLoadScheduler({ start: 3, min: 1, max: 4 });
    for (let i = 0; i < 10; i += 1) s.acquire(() => 0);
    s.release({ ok: true, ms: 100 }); // ewma=100
    s.release({ ok: true, ms: 300 }); // 300 > 100*1.5 -> ease to 2
    expect(s.concurrencyLimit).toBe(2);
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient } from '../client';

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: the ApiClient singleton is shared, so each test MUST fully resolve
// every in-flight and queued fetch before returning.  We track ALL resolvers in
// a module-level array that afterEach drains to guarantee zero leaked slots.
// ─────────────────────────────────────────────────────────────────────────────

let allResolvers: Array<(r: Response) => void> = [];

function okResponse(): Response {
  return new Response('ok', { status: 200 });
}

/** Create a fetch mock that records a resolver into allResolvers. */
function makeSuspendingFetch(executionLog?: string[], urlLabel?: string) {
  return vi.fn().mockImplementation((url: string) => {
    if (executionLog !== undefined) executionLog.push(urlLabel ?? (url as string));
    return new Promise<Response>((resolve) => {
      allResolvers.push(resolve);
    });
  });
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Drain all tracked resolvers so the singleton's slot counter resets. */
async function drainAll(): Promise<void> {
  // Resolve in a loop because resolving one slot can trigger the next queued
  // request which adds another resolver.
  for (let i = 0; i < 20; i++) {
    const batch = allResolvers.splice(0);
    if (batch.length === 0) break;
    batch.forEach((res) => res(okResponse()));
    await tick(20);
  }
}

describe('ApiClient priority queue', () => {
  beforeEach(() => {
    allResolvers = [];
  });

  afterEach(async () => {
    // Drain all pending resolvers so the singleton resets to 0 active requests
    await drainAll();
    vi.unstubAllGlobals();
    await tick(30);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: Priority ordering — priority-0 runs before priority-1
  // ─────────────────────────────────────────────────────────────────────────
  it('priority-0 request runs before priority-1 when a slot becomes free', async () => {
    const fetchMock = makeSuspendingFetch();
    vi.stubGlobal('fetch', fetchMock);

    // Fill all 6 concurrency slots
    const slotPromises = Array.from({ length: 6 }, (_, i) =>
      apiClient.fetchUrl(`https://example.com/slot-${i}`),
    );
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // Track which queued requests actually start fetching
    const executionOrder: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      executionOrder.push(url as string);
      return new Promise<Response>((resolve) => { allResolvers.push(resolve); });
    }));

    // Queue low priority first, then high priority
    const queuedLow = apiClient.fetchUrl('https://example.com/low', { queuePriority: 1 });
    const queuedHigh = apiClient.fetchUrl('https://example.com/high', { queuePriority: 0 });

    // Free one slot — the priority-0 (high urgency) request should run first
    allResolvers[0](okResponse());
    await tick();

    expect(executionOrder).toHaveLength(1);
    expect(executionOrder[0]).toBe('https://example.com/high');

    // Cleanup: resolve everything so afterEach drain has nothing to do
    await drainAll();
    await Promise.allSettled([...slotPromises, queuedLow, queuedHigh]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Abort while queued — rejects with AbortError, slot not consumed
  // ─────────────────────────────────────────────────────────────────────────
  it('aborting a queued request rejects with AbortError and does not consume a slot', async () => {
    vi.stubGlobal('fetch', makeSuspendingFetch());

    // Fill all 6 slots
    const slotPromises = Array.from({ length: 6 }, (_, i) =>
      apiClient.fetchUrl(`https://example.com/abort-fill-${i}`),
    );
    await tick();
    expect(allResolvers).toHaveLength(6);

    // Queue a 7th with an AbortController we will fire immediately
    const controller = new AbortController();
    const queuedPromise = apiClient.fetchUrl('https://example.com/abortable', {
      signal: controller.signal,
    });

    // Abort while still queued (no slot free yet)
    controller.abort();

    await expect(queuedPromise).rejects.toMatchObject({ name: 'AbortError' });

    // Track fetch call count before freeing a slot
    const fetchCallsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Now free one slot — the aborted request was removed from queue, so nothing new should start
    allResolvers[0](okResponse());
    await tick();

    // fetch call count must NOT have increased (aborted request was removed from queue)
    const fetchCallsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(fetchCallsAfter).toBe(fetchCallsBefore);

    // Cleanup
    await drainAll();
    await Promise.allSettled(slotPromises);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Pre-aborted signal rejects immediately, no slot consumed
  // ─────────────────────────────────────────────────────────────────────────
  it('pre-aborted signal rejects immediately without consuming a slot', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort(); // already aborted before the call

    const promise = apiClient.fetchUrl('https://example.com/pre-aborted', {
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: FIFO within same priority
  // ─────────────────────────────────────────────────────────────────────────
  it('two requests with the same priority are served in insertion order (FIFO)', async () => {
    vi.stubGlobal('fetch', makeSuspendingFetch());

    // Fill all 6 slots
    const slotPromises = Array.from({ length: 6 }, (_, i) =>
      apiClient.fetchUrl(`https://example.com/fifo-fill-${i}`),
    );
    await tick();
    expect(allResolvers).toHaveLength(6);

    // Queue two requests with identical priority
    const executionOrder: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      executionOrder.push(url as string);
      return new Promise<Response>((resolve) => { allResolvers.push(resolve); });
    }));

    const first = apiClient.fetchUrl('https://example.com/first', { queuePriority: 1 });
    const second = apiClient.fetchUrl('https://example.com/second', { queuePriority: 1 });

    // Free one slot — first-inserted should start
    allResolvers[0](okResponse());
    await tick();
    expect(executionOrder).toHaveLength(1);
    expect(executionOrder[0]).toBe('https://example.com/first');

    // Free another — second should start
    allResolvers[1](okResponse());
    await tick();
    expect(executionOrder).toHaveLength(2);
    expect(executionOrder[1]).toBe('https://example.com/second');

    // Cleanup
    await drainAll();
    await Promise.allSettled([...slotPromises, first, second]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// On Android the WebView interceptor (BypassWebViewClient) handles CDN images,
// so AbortableImage must load them as a plain <img src={realUrl}> — NOT via the
// JS native-fetch / objectURL path used on iOS/Tauri. Full module shape.
vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => true),
  isNativePlatform: vi.fn(() => true),
  isAndroid: vi.fn(() => true),
}));

const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
function MockIntersectionObserver(this: IntersectionObserver) {
  (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
  (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
}

import { AbortableImage, __resetAbortableImageCacheForTests } from '../AbortableImage';

const CDN = 'https://aa.gold-usergeneratedcontent.net/img/0001.webp';

beforeEach(() => {
  __resetAbortableImageCacheForTests();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AbortableImage on Android', () => {
  it('loads a CDN image as a plain <img src> (interceptor bypasses; no objectURL)', () => {
    const { container } = render(<AbortableImage src={CDN} alt="t" loading="eager" />);
    const img = container.querySelector('img') as HTMLImageElement;
    // The real CDN URL is emitted directly — proof the native-fetch/objectURL
    // branch was skipped on Android.
    expect(img.getAttribute('src')).toBe(CDN);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { GalleryGridById } from '../GalleryGrid';
import { PAGE_SIZE } from '@/lib/utils/constants';

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (sel: (s: { gridColumns: number }) => unknown) => sel({ gridColumns: 0 }),
}));

vi.mock('../GalleryCard', () => ({
  GalleryCardById: ({ id }: { id: number }) => <div data-testid={`card-${id}`} />,
}));

const IDS = [10, 20, 30];

describe('GalleryGridById', () => {
  // -------------------------------------------------------------------------
  // isLoading skeleton
  // -------------------------------------------------------------------------

  it('renders full skeleton grid when isLoading=true and ids is empty', () => {
    const { container } = render(<GalleryGridById ids={[]} isLoading={true} />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    // SkeletonGrid renders PAGE_SIZE cards, each has 2 animate-pulse divs
    expect(skeletons.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-item-index]')).toHaveLength(0);
  });

  it('does not render skeleton grid when ids are present even if isLoading=true', () => {
    const { container } = render(<GalleryGridById ids={IDS} isLoading={true} />);
    expect(container.querySelectorAll('[data-item-index]')).toHaveLength(IDS.length);
  });

  // -------------------------------------------------------------------------
  // data-item-index (no offset)
  // -------------------------------------------------------------------------

  it('sets data-item-index starting at 0 by default', () => {
    const { container } = render(<GalleryGridById ids={IDS} isLoading={false} />);
    const wrappers = container.querySelectorAll('[data-item-index]');
    expect(wrappers).toHaveLength(IDS.length);
    IDS.forEach((_, idx) => {
      expect(wrappers[idx].getAttribute('data-item-index')).toBe(String(idx));
    });
  });

  // -------------------------------------------------------------------------
  // indexOffset
  // -------------------------------------------------------------------------

  it('applies indexOffset to data-item-index', () => {
    const offset = PAGE_SIZE * 3; // e.g., starting from page 4
    const { container } = render(
      <GalleryGridById ids={IDS} isLoading={false} indexOffset={offset} />,
    );
    const wrappers = container.querySelectorAll('[data-item-index]');
    IDS.forEach((_, idx) => {
      expect(wrappers[idx].getAttribute('data-item-index')).toBe(String(idx + offset));
    });
  });

  it('data-item-index is present even when card content has not loaded (wrapper always exists)', () => {
    const { container } = render(
      <GalleryGridById ids={[999]} isLoading={false} indexOffset={50} />,
    );
    const wrapper = container.querySelector('[data-item-index="50"]');
    expect(wrapper).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // isFetchingNextPage skeleton overlay
  // -------------------------------------------------------------------------

  it('renders no extra skeletons when isFetchingNextPage is false (default)', () => {
    const { container } = render(<GalleryGridById ids={IDS} isLoading={false} />);
    // Only real cards, no skeleton-next keys
    const skeletonKeys = Array.from(container.querySelectorAll('[class*="animate-pulse"]'));
    expect(skeletonKeys).toHaveLength(0);
  });

  it('renders PAGE_SIZE skeleton cards appended when isFetchingNextPage=true', () => {
    const { container } = render(
      <GalleryGridById ids={IDS} isLoading={false} isFetchingNextPage={true} />,
    );
    // Each SkeletonCard has 2 animate-pulse divs (image + title)
    const pulseDivs = container.querySelectorAll('.animate-pulse');
    expect(pulseDivs.length).toBe(PAGE_SIZE * 2);
  });

  it('real card wrappers are still present when isFetchingNextPage=true', () => {
    const { container } = render(
      <GalleryGridById ids={IDS} isLoading={false} isFetchingNextPage={true} />,
    );
    expect(container.querySelectorAll('[data-item-index]')).toHaveLength(IDS.length);
  });

  it('skeleton cards disappear when isFetchingNextPage toggles back to false', () => {
    const { container, rerender } = render(
      <GalleryGridById ids={IDS} isLoading={false} isFetchingNextPage={true} />,
    );
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);

    rerender(<GalleryGridById ids={IDS} isLoading={false} isFetchingNextPage={false} />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });
});

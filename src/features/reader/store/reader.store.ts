import { create } from 'zustand';
import type { GalleryImage } from '@/lib/utils/types';

interface ReaderStoreState {
  galleryId: number | null;
  images: GalleryImage[];
  currentPage: number;
  totalPages: number;
  mode: 'page' | 'scroll';
  scrollPosition: number;
  isLoading: boolean;
  error: string | null;
  setGallery: (id: number, images: GalleryImage[]) => void;
  setCurrentPage: (page: number) => void;
  setMode: (mode: 'page' | 'scroll') => void;
  setScrollPosition: (position: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  nextPage: () => void;
  prevPage: () => void;
  reset: () => void;
}

export const useReaderStore = create<ReaderStoreState>((set) => ({
  galleryId: null,
  images: [],
  currentPage: 0,
  totalPages: 0,
  mode: 'page',
  scrollPosition: 0,
  isLoading: false,
  error: null,
  setGallery: (id, images) =>
    set({
      galleryId: id,
      images,
      totalPages: images.length,
      currentPage: 0,
      scrollPosition: 0,
      isLoading: false,
      error: null,
    }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setMode: (mode) => set({ mode }),
  setScrollPosition: (position) => set({ scrollPosition: position }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  nextPage: () =>
    set((s) => ({ currentPage: Math.min(s.currentPage + 1, s.totalPages - 1) })),
  prevPage: () =>
    set((s) => ({ currentPage: Math.max(s.currentPage - 1, 0) })),
  reset: () =>
    set({
      galleryId: null,
      images: [],
      currentPage: 0,
      totalPages: 0,
      mode: 'page',
      scrollPosition: 0,
      isLoading: false,
      error: null,
    }),
}));

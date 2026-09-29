'use client';

import { createContext, useContext } from 'react';

export interface GalleryActionGallery {
  id: number;
  title?: string;
  thumbnail?: string;
  tags?: Record<string, string[]>;
}

export interface GalleryActionAnchor {
  x: number;
  y: number;
}

export interface GalleryActions {
  open: (
    gallery: GalleryActionGallery,
    anchor?: GalleryActionAnchor,
    onBeginSelection?: () => void,
  ) => void;
  close: () => void;
  save: (gallery: GalleryActionGallery) => Promise<void>;
  download: (gallery: GalleryActionGallery) => Promise<void>;
  remove: (gallery: GalleryActionGallery | GalleryActionGallery[]) => Promise<void>;
  deleteFiles: (gallery: GalleryActionGallery | GalleryActionGallery[]) => Promise<void>;
  collections: (gallery: GalleryActionGallery) => void;
}

export const GalleryActionsContext = createContext<GalleryActions | null>(null);

export function useGalleryActions(): GalleryActions {
  const actions = useContext(GalleryActionsContext);
  if (!actions) throw new Error('GalleryActionsProvider is required.');
  return actions;
}

'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addFavorite, removeFavorite, isFavorite } from '@/lib/db/gallery';

export function useFavoriteToggle(id: number) {
  const [isFav, setIsFav] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    isFavorite(id).then(setIsFav).catch((e) => console.warn('[detail] Favorite check failed:', e));
  }, [id]);

  const mutation = useMutation({
    mutationFn: async ({ wasFav }: { wasFav: boolean }) => {
      if (wasFav) await removeFavorite(id);
      else await addFavorite(id);
      return !wasFav;
    },
    onSuccess: (newFav) => {
      setIsFav(newFav);
      queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });

  return { isFav, isPending: mutation.isPending, toggle: () => mutation.mutate({ wasFav: isFav }) };
}

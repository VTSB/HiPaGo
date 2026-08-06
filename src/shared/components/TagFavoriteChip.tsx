'use client';

import { TagChip } from '@/shared/components/TagChip';
import { TagFavoriteButton } from '@/shared/components/TagFavoriteButton';
import { getTagColor } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';

interface TagFavoriteChipProps {
  tag: string;
  type: TagType;
  displayName?: string;
  linked?: boolean;
  size?: 'sm' | 'md' | 'lg';
  wrap?: boolean;
  onSelect?: () => void;
  className?: string;
}

/** A single chip surface with separate, valid label and favorite controls. */
export function TagFavoriteChip({
  tag,
  type,
  displayName,
  linked = true,
  size = 'sm',
  wrap = false,
  onSelect,
  className = '',
}: TagFavoriteChipProps) {
  const favoriteSize = size === 'lg' ? 'md' : size === 'md' ? 'sm' : 'xs';
  const label = (
    <TagChip
      tag={tag}
      type={type}
      displayName={displayName}
      linked={onSelect ? false : linked}
      size={size}
      wrap={wrap}
      embedded
    />
  );

  return (
    <span
      data-tag-favorite-chip
      className={`inline-flex min-w-0 max-w-full items-center rounded-full align-middle ${getTagColor(type)} ${className}`}
    >
      {onSelect ? (
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className="pointer-events-auto min-w-0 rounded-l-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {label}
        </button>
      ) : (
        label
      )}
      <TagFavoriteButton tag={tag} type={type} size={favoriteSize} tone="chip" />
    </span>
  );
}

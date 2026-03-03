'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChipInput } from '@/shared/components/ChipInput';
import { SuggestionDropdown } from '@/features/search/components/SuggestionDropdown';
import { parseToken } from '@/features/search/components/RecentSearchesDropdown';
import { searchLocalTags } from '@/lib/db/search-local';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import type { TagType, Suggestion } from '@/lib/utils/types';

export interface FilterBarProps {
  onFilterChange: (filters: { tags: Array<{ type: TagType; name: string }>; titleQuery: string }) => void;
  placeholder?: string;
}

interface Snapshot {
  chips: string[];
  activeInput: string;
}

export function FilterBar({ onFilterChange, placeholder }: FilterBarProps) {
  const [chips, setChips] = useState<string[]>([]);
  const [activeInput, setActiveInput] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const ignoreMouseRef = useRef(false);
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);

  const pushUndo = useCallback(() => {
    undoStack.current.push({ chips: [...chips], activeInput });
    redoStack.current = [];
  }, [chips, activeInput]);

  const handleClickOutside = useCallback(() => {
    setShowDropdown(false);
    if (editingIndex !== null) {
      setEditingIndex(null);
      setActiveInput('');
    }
  }, [editingIndex]);
  useClickOutside([inputRef, dropdownRef], handleClickOutside);

  // Debounced autocomplete
  useEffect(() => {
    const colonIdx = activeInput.indexOf(':');
    const searchTerm = colonIdx > 0 ? activeInput.slice(colonIdx + 1) : activeInput;

    if (searchTerm.length < 2) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      const typeFilter = colonIdx > 0 ? (activeInput.slice(0, colonIdx) as TagType) : undefined;
      const results = await searchLocalTags(searchTerm, typeFilter, 10);
      setSuggestions(results);
      setShowDropdown(results.length > 0);
    }, 200);

    return () => clearTimeout(timer);
  }, [activeInput]);

  // Notify parent when chips or active input change
  useEffect(() => {
    const tags: Array<{ type: TagType; name: string }> = [];
    for (const chip of chips) {
      const parsed = parseToken(chip);
      if (parsed) {
        tags.push({ type: parsed.type, name: parsed.tag });
      }
    }
    const titleQuery = activeInput.trim();
    onFilterChange({ tags, titleQuery });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips, activeInput]);

  // Only commits tag-formatted values (type:name) as chips
  const commitTag = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!parseToken(trimmed)) return;

    pushUndo();
    if (editingIndex !== null) {
      setChips((prev) => {
        const next = [...prev];
        next[editingIndex] = trimmed;
        return next;
      });
      setEditingIndex(null);
    } else {
      setChips((prev) => [...prev, trimmed]);
    }

    setActiveInput('');
    setSuggestions([]);
    setShowDropdown(false);
    setSelectedIndex(-1);
  }, [editingIndex, pushUndo]);

  const handleSuggestionClick = useCallback((tag: string, tagType: string) => {
    commitTag(`${tagType}:${tag}`);
    inputRef.current?.focus();
  }, [commitTag]);

  const editChip = useCallback((index: number) => {
    pushUndo();
    setEditingIndex(index);
    setActiveInput(chips[index]);
    setShowDropdown(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [chips, pushUndo]);

  const handleInputChange = useCallback((text: string) => {
    setActiveInput(text);
    setSelectedIndex(-1);
  }, []);

  const handleRemoveChip = useCallback((index: number) => {
    pushUndo();
    setChips((prev) => prev.filter((_, i) => i !== index));
  }, [pushUndo]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const tokens = text.trim().split(/[\s\n]+/).filter(Boolean);
    const hasTag = tokens.some((t) => parseToken(t));
    if (!hasTag) return;
    e.preventDefault();
    pushUndo();
    const newChips: string[] = [];
    const textParts: string[] = [];
    for (const token of tokens) {
      if (parseToken(token)) {
        newChips.push(token);
      } else {
        textParts.push(token);
      }
    }
    if (newChips.length > 0) setChips((prev) => [...prev, ...newChips]);
    if (textParts.length > 0) setActiveInput((prev) => prev + textParts.join(' '));
  }, [pushUndo]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;

    // Ctrl+Z: undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undoStack.current.length > 0) {
        redoStack.current.push({ chips: [...chips], activeInput });
        const prev = undoStack.current.pop()!;
        setChips(prev.chips);
        setActiveInput(prev.activeInput);
        setEditingIndex(null);
      }
      return;
    }

    // Ctrl+Shift+Z / Ctrl+Y: redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      if (redoStack.current.length > 0) {
        undoStack.current.push({ chips: [...chips], activeInput });
        const next = redoStack.current.pop()!;
        setChips(next.chips);
        setActiveInput(next.activeInput);
        setEditingIndex(null);
      }
      return;
    }

    // Enter: accept suggestion or commit tag
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showDropdown && selectedIndex >= 0 && suggestions[selectedIndex]) {
        const s = suggestions[selectedIndex];
        handleSuggestionClick(s.tag, s.tagType);
      } else {
        commitTag(activeInput);
      }
      return;
    }

    // Escape: close dropdown / cancel editing
    if (e.key === 'Escape') {
      setShowDropdown(false);
      setSuggestions([]);
      setSelectedIndex(-1);
      if (editingIndex !== null) {
        setEditingIndex(null);
        setActiveInput('');
      }
      return;
    }

    // ArrowDown/Up: navigate suggestions
    if (showDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
        return;
      }
    }
  }, [activeInput, chips, editingIndex, handleSuggestionClick, showDropdown, selectedIndex, suggestions, commitTag, pushUndo]);

  return (
    <div className="relative w-full">
      <ChipInput
        chips={chips}
        activeInput={activeInput}
        onInputChange={handleInputChange}
        onRemoveChip={handleRemoveChip}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
        onEditChip={editChip}
        onPaste={handlePaste}
        editingIndex={editingIndex}
        placeholder={placeholder}
        inputRef={inputRef}
      />
      {showDropdown && suggestions.length > 0 && (
        <div ref={dropdownRef}>
          <SuggestionDropdown
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            onSelect={handleSuggestionClick}
            onHover={setSelectedIndex}
            ignoreMouseRef={ignoreMouseRef}
          />
        </div>
      )}
    </div>
  );
}

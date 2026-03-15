// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchGalleryInfo,
  fetchGalleryBlockHtmlById,
  fetchGalleryBlockDetailed,
  fetchGalleryImages,
  fetchBrowseIds,
  fetchSearchIds,
  fetchLanguages,
  fetchIndexVersion,
  createLoadingBlock,
  filesToGalleryImages,
} from '../gallery';
import { GalleryBlockType, ImageType } from '@/lib/utils/types';

// Mock all dependencies
vi.mock('../client', () => ({
  apiClient: {
    fetchLtnText: vi.fn(),
  },
}));

vi.mock('../parser', () => ({
  parseGalleryJson: vi.fn(),
  parseGalleryBlockHtml: vi.fn(),
  galleryInfoToBlock: vi.fn(),
  galleryInfoToImages: vi.fn(),
  parseLanguageSupport: vi.fn(),
  parseIndexVersion: vi.fn(),
}));

vi.mock('../nozomi', () => ({
  fetchGalleryIds: vi.fn(),
  fetchGalleryIdsByTag: vi.fn(),
}));

import { apiClient } from '../client';
import {
  parseGalleryJson,
  parseGalleryBlockHtml,
  galleryInfoToBlock,
  galleryInfoToImages,
  parseLanguageSupport,
  parseIndexVersion,
} from '../parser';
import { fetchGalleryIds, fetchGalleryIdsByTag } from '../nozomi';

describe('createLoadingBlock', () => {
  it('returns correct id', () => {
    const block = createLoadingBlock(12345);
    expect(block.id).toBe(12345);
  });

  it('type is GalleryBlockType.LOADING', () => {
    const block = createLoadingBlock(999);
    expect(block.type).toBe(GalleryBlockType.LOADING);
  });

  it('title is empty string', () => {
    const block = createLoadingBlock(1);
    expect(block.title).toBe('');
  });

  it('date is a Date instance', () => {
    const block = createLoadingBlock(1);
    expect(block.date).toBeInstanceOf(Date);
  });

  it('tags is empty object', () => {
    const block = createLoadingBlock(1);
    expect(block.tags).toEqual({});
  });

  it('thumbnail is empty string', () => {
    const block = createLoadingBlock(1);
    expect(block.thumbnail).toBe('');
  });

  it('related is empty array', () => {
    const block = createLoadingBlock(1);
    expect(block.related).toEqual([]);
  });
});

describe('fetchGalleryInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SAMPLE_GALLERY_JS = `var galleryinfo = {
    "language_localname": "日本語",
    "language": "japanese",
    "date": "2024-01-15 12:30",
    "files": [
      {
        "width": 1280,
        "height": 1800,
        "haswebp": 1,
        "hasavifsmalltn": 1,
        "hasavif": 1,
        "name": "001.jpg",
        "hash": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
      }
    ],
    "tags": [
      { "male": "0", "female": "0", "url": "artist/testartist-all.html", "tag": "testartist" }
    ],
    "japanese_title": "テストタイトル",
    "title": "Test Title",
    "id": "12345",
    "type": "doujinshi"
  }`;

  it('calls apiClient.fetchLtnText with correct path', async () => {
    const mockGalleryInfo = {
      languageLocalName: '日本語',
      language: 'japanese',
      date: '2024-01-15 12:30',
      files: [],
      tags: [],
      japaneseTitle: 'テストタイトル',
      title: 'Test Title',
      id: 12345,
      type: 'doujinshi',
      related: [],
      artists: [],
      groups: [],
      characters: [],
      parodys: [],
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(SAMPLE_GALLERY_JS);
    vi.mocked(parseGalleryJson).mockReturnValue(mockGalleryInfo);

    await fetchGalleryInfo(12345);

    expect(apiClient.fetchLtnText).toHaveBeenCalledWith('galleries/12345.js');
  });

  it('returns parsed GalleryInfo with correct fields', async () => {
    const mockGalleryInfo = {
      languageLocalName: '日本語',
      language: 'japanese',
      date: '2024-01-15 12:30',
      files: [
        {
          width: 1280,
          height: 1800,
          haswebp: 1,
          hasavifsmalltn: 1,
          hasavif: 1,
          name: '001.jpg',
          hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      ],
      tags: [
        {
          male: '0',
          female: '0',
          url: 'artist/testartist-all.html',
          tag: 'testartist',
        },
      ],
      japaneseTitle: 'テストタイトル',
      title: 'Test Title',
      id: 12345,
      type: 'doujinshi',
      related: [],
      artists: [],
      groups: [],
      characters: [],
      parodys: [],
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(SAMPLE_GALLERY_JS);
    vi.mocked(parseGalleryJson).mockReturnValue(mockGalleryInfo);

    const result = await fetchGalleryInfo(12345);

    expect(parseGalleryJson).toHaveBeenCalledWith(SAMPLE_GALLERY_JS);
    expect(result).toEqual(mockGalleryInfo);
    expect(result.id).toBe(12345);
    expect(result.title).toBe('Test Title');
    expect(result.language).toBe('japanese');
    expect(result.files).toHaveLength(1);
    expect(result.tags).toHaveLength(1);
  });
});

describe('fetchGalleryBlockHtmlById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on success: returns GalleryBlock with NOT_DETAILED type', async () => {
    const mockHtml = '<div class="lillie"><a>Test Gallery</a></div>';
    const mockBlock = {
      id: 999,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'Test Gallery',
      date: new Date('2024-01-01'),
      tags: {},
      thumbnail: 'https://example.com/thumb.jpg',
      related: [],
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(mockHtml);
    vi.mocked(parseGalleryBlockHtml).mockReturnValue(mockBlock);

    const result = await fetchGalleryBlockHtmlById(999);

    expect(apiClient.fetchLtnText).toHaveBeenCalledWith('galleryblock/999.html', { signal: undefined });
    expect(parseGalleryBlockHtml).toHaveBeenCalledWith(mockHtml, 999);
    expect(result).toEqual(mockBlock);
    expect(result.type).toBe(GalleryBlockType.NOT_DETAILED);
  });

  it('on error: returns FAILED block without throwing', async () => {
    vi.mocked(apiClient.fetchLtnText).mockRejectedValue(
      new Error('Network error'),
    );

    const result = await fetchGalleryBlockHtmlById(404);

    expect(result.id).toBe(404);
    expect(result.type).toBe(GalleryBlockType.FAILED);
    expect(result.title).toBe('');
    expect(result.date).toBeInstanceOf(Date);
    expect(result.tags).toEqual({});
    expect(result.thumbnail).toBe('');
    expect(result.related).toEqual([]);
  });

  it('on error: does not call parseGalleryBlockHtml', async () => {
    vi.mocked(apiClient.fetchLtnText).mockRejectedValue(
      new Error('Not found'),
    );

    await fetchGalleryBlockHtmlById(404);

    expect(parseGalleryBlockHtml).not.toHaveBeenCalled();
  });
});

describe('fetchGalleryBlockDetailed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on success: returns DETAILED block from gallery info', async () => {
    const mockGalleryInfo = {
      languageLocalName: 'English',
      language: 'english',
      date: '2024-01-15 12:30',
      files: [],
      tags: [],
      japaneseTitle: '',
      title: 'Detailed Gallery',
      id: 555,
      type: 'manga',
      related: [],
      artists: [],
      groups: [],
      characters: [],
      parodys: [],
    };

    const mockBlock = {
      id: 555,
      type: GalleryBlockType.DETAILED,
      title: 'Detailed Gallery',
      date: new Date('2024-01-15'),
      tags: {},
      thumbnail: 'https://example.com/thumb.jpg',
      related: [],
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(
      'var galleryinfo = {}',
    );
    vi.mocked(parseGalleryJson).mockReturnValue(mockGalleryInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(mockBlock);

    const result = await fetchGalleryBlockDetailed(555);

    expect(galleryInfoToBlock).toHaveBeenCalledWith(mockGalleryInfo);
    expect(result).toEqual(mockBlock);
    expect(result.type).toBe(GalleryBlockType.DETAILED);
  });

  it('on error: returns FAILED block without throwing', async () => {
    vi.mocked(apiClient.fetchLtnText).mockRejectedValue(
      new Error('Server error'),
    );

    const result = await fetchGalleryBlockDetailed(500);

    expect(result.id).toBe(500);
    expect(result.type).toBe(GalleryBlockType.FAILED);
    expect(result.title).toBe('');
    expect(result.date).toBeInstanceOf(Date);
    expect(result.tags).toEqual({});
    expect(result.thumbnail).toBe('');
    expect(result.related).toEqual([]);
  });

  it('on error: does not call galleryInfoToBlock', async () => {
    vi.mocked(apiClient.fetchLtnText).mockRejectedValue(new Error('Fail'));

    await fetchGalleryBlockDetailed(500);

    expect(galleryInfoToBlock).not.toHaveBeenCalled();
  });

  it('on success: returned block has language and mediaType from GalleryInfo', async () => {
    const mockGalleryInfo = {
      languageLocalName: '日本語',
      language: 'japanese',
      date: '2024-01-15 12:30',
      files: [],
      tags: [],
      japaneseTitle: '',
      title: 'Lang Test',
      id: 777,
      type: 'doujinshi',
      related: [],
      artists: [],
      groups: [],
      characters: [],
      parodys: [],
    };

    const mockBlock = {
      id: 777,
      type: GalleryBlockType.DETAILED,
      title: 'Lang Test',
      date: new Date('2024-01-15'),
      tags: {},
      thumbnail: '',
      related: [],
      language: 'japanese',
      mediaType: 'doujinshi',
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('var galleryinfo = {}');
    vi.mocked(parseGalleryJson).mockReturnValue(mockGalleryInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(mockBlock);

    const result = await fetchGalleryBlockDetailed(777);

    expect(result.language).toBe('japanese');
    expect(result.mediaType).toBe('doujinshi');
  });
});

describe('fetchGalleryImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns GalleryImages with correct image count and types', async () => {
    const mockGalleryInfo = {
      languageLocalName: 'English',
      language: 'english',
      date: '2024-01-15',
      files: [
        {
          width: 1280,
          height: 1800,
          haswebp: 1,
          hasavifsmalltn: 1,
          hasavif: 1,
          name: '001.jpg',
          hash: 'hash1',
        },
        {
          width: 1920,
          height: 1080,
          haswebp: 1,
          hasavifsmalltn: 0,
          hasavif: 0,
          name: '002.png',
          hash: 'hash2',
        },
      ],
      tags: [],
      japaneseTitle: '',
      title: 'Image Gallery',
      id: 777,
      type: 'manga',
      related: [],
      artists: [],
      groups: [],
      characters: [],
      parodys: [],
    };

    const mockImages = {
      id: 777,
      images: [
        {
          name: '001.jpg',
          hash: 'hash1',
          width: 1280,
          height: 1800,
          types: new Set([ImageType.ORIGINAL, ImageType.WEBP, ImageType.AVIF]),
        },
        {
          name: '002.png',
          hash: 'hash2',
          width: 1920,
          height: 1080,
          types: new Set([ImageType.ORIGINAL, ImageType.WEBP]),
        },
      ],
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(
      'var galleryinfo = {}',
    );
    vi.mocked(parseGalleryJson).mockReturnValue(mockGalleryInfo);
    vi.mocked(galleryInfoToImages).mockReturnValue(mockImages);

    const result = await fetchGalleryImages(777);

    expect(galleryInfoToImages).toHaveBeenCalledWith(mockGalleryInfo);
    expect(result.id).toBe(777);
    expect(result.images).toHaveLength(2);
    expect(result.images[0].types.has(ImageType.AVIF)).toBe(true);
    expect(result.images[1].types.has(ImageType.AVIF)).toBe(false);
  });
});

describe('fetchBrowseIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to fetchGalleryIds with "index" type', async () => {
    const mockResult = { idList: [1, 2, 3], length: 100 };
    vi.mocked(fetchGalleryIds).mockResolvedValue(mockResult);

    const result = await fetchBrowseIds('japanese', 0);

    expect(fetchGalleryIds).toHaveBeenCalledWith('index', 'japanese', 0, 25, undefined);
    expect(result).toEqual(mockResult);
  });

  it('passes custom pageSize to fetchGalleryIds', async () => {
    const mockResult = { idList: [1, 2, 3, 4, 5], length: 50 };
    vi.mocked(fetchGalleryIds).mockResolvedValue(mockResult);

    const result = await fetchBrowseIds('english', 2, 10);

    expect(fetchGalleryIds).toHaveBeenCalledWith('index', 'english', 2, 10, undefined);
    expect(result).toEqual(mockResult);
  });

  it('uses default PAGE_SIZE when pageSize not provided', async () => {
    const mockResult = { idList: [], length: 0 };
    vi.mocked(fetchGalleryIds).mockResolvedValue(mockResult);

    await fetchBrowseIds('chinese', 1);

    expect(fetchGalleryIds).toHaveBeenCalledWith('index', 'chinese', 1, 25, undefined);
  });
});

describe('fetchSearchIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to fetchGalleryIdsByTag with correct parameters', async () => {
    const mockResult = { idList: [10, 20, 30], length: 200 };
    vi.mocked(fetchGalleryIdsByTag).mockResolvedValue(mockResult);

    const result = await fetchSearchIds('artist', 'testartist', 'all', 0);

    expect(fetchGalleryIdsByTag).toHaveBeenCalledWith(
      'artist',
      'testartist',
      'all',
      0,
      25,
    );
    expect(result).toEqual(mockResult);
  });

  it('passes custom pageSize to fetchGalleryIdsByTag', async () => {
    const mockResult = { idList: [1], length: 1 };
    vi.mocked(fetchGalleryIdsByTag).mockResolvedValue(mockResult);

    const result = await fetchSearchIds('tag', 'sample', 'japanese', 3, 15);

    expect(fetchGalleryIdsByTag).toHaveBeenCalledWith(
      'tag',
      'sample',
      'japanese',
      3,
      15,
    );
    expect(result).toEqual(mockResult);
  });

  it('uses default PAGE_SIZE when pageSize not provided', async () => {
    const mockResult = { idList: [], length: 0 };
    vi.mocked(fetchGalleryIdsByTag).mockResolvedValue(mockResult);

    await fetchSearchIds('series', 'testseries', 'english', 5);

    expect(fetchGalleryIdsByTag).toHaveBeenCalledWith(
      'series',
      'testseries',
      'english',
      5,
      25,
    );
  });
});

describe('fetchLanguages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and parses language support', async () => {
    const mockText = '["japanese", "english", "chinese", "korean"]';
    const mockLanguages = ['japanese', 'english', 'chinese', 'korean'];

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(mockText);
    vi.mocked(parseLanguageSupport).mockReturnValue(mockLanguages);

    const result = await fetchLanguages();

    expect(apiClient.fetchLtnText).toHaveBeenCalledWith('language_support.js');
    expect(parseLanguageSupport).toHaveBeenCalledWith(mockText);
    expect(result).toEqual(mockLanguages);
  });

  it('returns parsed language array', async () => {
    const mockLanguages = ['all', 'japanese'];
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('[]');
    vi.mocked(parseLanguageSupport).mockReturnValue(mockLanguages);

    const result = await fetchLanguages();

    expect(result).toEqual(['all', 'japanese']);
  });
});

describe('fetchIndexVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches version with cache-busting timestamp', async () => {
    const mockText = '  42  \n';
    const mockVersion = '42';

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue(mockText);
    vi.mocked(parseIndexVersion).mockReturnValue(mockVersion);

    const result = await fetchIndexVersion('galleries');

    expect(apiClient.fetchLtnText).toHaveBeenCalledWith(
      expect.stringMatching(/^galleries\/version\?_=\d+$/),
    );
    expect(parseIndexVersion).toHaveBeenCalledWith(mockText);
    expect(result).toBe('42');
  });

  it('returns trimmed version string', async () => {
    const mockVersion = '123';
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('  123  ');
    vi.mocked(parseIndexVersion).mockReturnValue(mockVersion);

    const result = await fetchIndexVersion('tagindex');

    expect(result).toBe('123');
  });

  it('includes timestamp for different index names', async () => {
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('1');
    vi.mocked(parseIndexVersion).mockReturnValue('1');

    await fetchIndexVersion('nozomiurlindex');

    expect(apiClient.fetchLtnText).toHaveBeenCalledWith(
      expect.stringMatching(/^nozomiurlindex\/version\?_=\d+$/),
    );
  });
});

describe('fetchGalleryBlockHtmlById signal handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AbortError propagates — does NOT return createFailedBlock', async () => {
    vi.mocked(apiClient.fetchLtnText).mockRejectedValue(
      new DOMException('Aborted', 'AbortError'),
    );

    await expect(fetchGalleryBlockHtmlById(111)).rejects.toMatchObject({
      name: 'AbortError',
    });
    // Confirm parse was never reached either
    expect(parseGalleryBlockHtml).not.toHaveBeenCalled();
  });

  it('network errors are swallowed and return a FAILED block', async () => {
    vi.mocked(apiClient.fetchLtnText).mockRejectedValue(new Error('Network error'));

    const result = await fetchGalleryBlockHtmlById(222);

    expect(result.id).toBe(222);
    expect(result.type).toBe(GalleryBlockType.FAILED);
  });

  it('signal option is forwarded to apiClient.fetchLtnText', async () => {
    const mockBlock = {
      id: 333,
      type: GalleryBlockType.NOT_DETAILED,
      title: 'Test',
      date: new Date(),
      tags: {},
      thumbnail: '',
      related: [],
    };
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('<div>html</div>');
    vi.mocked(parseGalleryBlockHtml).mockReturnValue(mockBlock);

    const controller = new AbortController();
    await fetchGalleryBlockHtmlById(333, controller.signal);

    expect(apiClient.fetchLtnText).toHaveBeenCalledWith(
      'galleryblock/333.html',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('filesToGalleryImages', () => {
  it('converts GalleryFile[] to GalleryImages with correct id and image count', () => {
    const files = [
      { width: 1280, height: 1800, haswebp: 1, hasavif: 1, hasavifsmalltn: 1, name: '001.jpg', hash: 'hash1' },
      { width: 800, height: 600, haswebp: 0, hasavif: 0, hasavifsmalltn: 0, name: '002.png', hash: 'hash2' },
    ];
    const result = filesToGalleryImages(12345, files);

    expect(result.id).toBe(12345);
    expect(result.images).toHaveLength(2);
  });

  it('always includes ImageType.ORIGINAL in types set', () => {
    const files = [
      { width: 100, height: 100, haswebp: 0, hasavif: 0, hasavifsmalltn: 0, name: 'a.jpg', hash: 'h1' },
    ];
    const result = filesToGalleryImages(1, files);
    expect(result.images[0].types.has(ImageType.ORIGINAL)).toBe(true);
  });

  it('adds ImageType.WEBP when haswebp=1', () => {
    const files = [
      { width: 100, height: 100, haswebp: 1, hasavif: 0, hasavifsmalltn: 0, name: 'a.jpg', hash: 'h1' },
    ];
    const result = filesToGalleryImages(1, files);
    expect(result.images[0].types.has(ImageType.WEBP)).toBe(true);
    expect(result.images[0].types.has(ImageType.AVIF)).toBe(false);
  });

  it('adds ImageType.AVIF when hasavif=1', () => {
    const files = [
      { width: 100, height: 100, haswebp: 0, hasavif: 1, hasavifsmalltn: 0, name: 'a.jpg', hash: 'h1' },
    ];
    const result = filesToGalleryImages(1, files);
    expect(result.images[0].types.has(ImageType.AVIF)).toBe(true);
    expect(result.images[0].types.has(ImageType.WEBP)).toBe(false);
  });

  it('preserves name, hash, width, height on each image', () => {
    const files = [
      { width: 1920, height: 1080, haswebp: 1, hasavif: 1, hasavifsmalltn: 0, name: 'img.jpg', hash: 'abc' },
    ];
    const result = filesToGalleryImages(99, files);
    expect(result.images[0].name).toBe('img.jpg');
    expect(result.images[0].hash).toBe('abc');
    expect(result.images[0].width).toBe(1920);
    expect(result.images[0].height).toBe(1080);
  });
});

import type { Locale } from '@/lib/store/settings';

const translations = {
  'actions.saveChanges': { en: 'Save', ko: '저장' },
  'library.filesMissing': { en: 'Files missing', ko: '파일 없음' },
  'library.manager': { en: 'Download manager', ko: '다운로드 관리' },
  'library.all': { en: 'All works', ko: '전체 작품' },
  'library.unclassified': { en: 'Unclassified', ko: '미분류' },
  'library.collectionNew': { en: 'New folder', ko: '새 폴더' },
  'library.collectionRename': { en: 'Rename folder', ko: '폴더 이름 변경' },
  'library.collectionDelete': { en: 'Delete folder', ko: '폴더 삭제' },
  'library.collectionName': { en: 'Folder name', ko: '폴더 이름' },
  'library.folderError.deleted-unsaved': {
    en: 'The folder was deleted, but could not be saved to this device. Confirm again to save.',
    ko: '폴더가 삭제되었지만 기기에 저장하지 못했습니다. 확인을 다시 눌러 저장해 주세요.',
  },
  'library.folderDeletePersistConfirm': {
    en: 'Save the completed deletion to this device. Works and files are kept.',
    ko: '삭제된 내용을 기기에 저장합니다. 작품과 파일은 그대로 유지됩니다.',
  },
  'library.folderError.name-empty': {
    en: 'Enter a folder name.',
    ko: '폴더 이름을 입력해 주세요.',
  },
  'library.folderError.missing': {
    en: 'This folder or its parent no longer exists. Choose another folder.',
    ko: '폴더 또는 상위 폴더가 사라졌습니다. 다른 폴더를 선택해 주세요.',
  },
  'library.folderError.cycle': {
    en: 'A folder cannot be moved into itself or its subfolders.',
    ko: '폴더를 자기 자신이나 하위 폴더 안으로 옮길 수 없습니다.',
  },
  'library.folderError.created-unsaved': {
    en: 'The folder was created, but could not be saved to this device. Try Save again.',
    ko: '폴더가 만들어졌지만 기기에 저장하지 못했습니다. 다시 저장해 주세요.',
  },
  'library.folderError.failed': {
    en: 'The folder action could not be completed. Please try again.',
    ko: '폴더 작업을 완료하지 못했습니다. 다시 시도해 주세요.',
  },
  'library.collectionDeleteConfirm': {
    en: 'Delete this folder? Works and files are kept. Subfolders move up one level.',
    ko: '이 폴더를 삭제할까요? 작품과 파일은 유지되고, 하위 폴더는 한 단계 위로 이동합니다.',
  },
  'library.folderMove': { en: 'Move folder', ko: '폴더 이동' },
  'library.folderActions': { en: 'Folder actions', ko: '폴더 관리' },
  'library.folders': { en: 'Folders', ko: '폴더' },
  'library.works': { en: 'Works', ko: '작품' },
  'library.location': { en: 'Current location', ko: '현재 위치' },
  'library.folderEmpty': {
    en: 'Add works here, or create a subfolder.',
    ko: '여기에 작품을 넣거나 하위 폴더를 만들어 보세요.',
  },
  'library.folderCount': { en: '{count} folders', ko: '폴더 {count}개' },
  'library.workCount': { en: '{count} works', ko: '작품 {count}개' },
  'library.managerDescription': {
    en: 'Queue and offline files',
    ko: '진행 중인 다운로드와 오프라인 파일',
  },
  'library.folderDestination': { en: 'Destination folder', ko: '이동할 폴더' },
  'library.downloadedOnly': { en: 'Downloaded only', ko: '다운로드한 작품만' },
  'library.sort': { en: 'Sort', ko: '정렬' },
  'library.sortNewest': { en: 'Recently saved', ko: '최근 저장 순' },
  'library.sortOldest': { en: 'Oldest saved', ko: '오래된 저장 순' },
  'library.sortTitle': { en: 'Title', ko: '제목 순' },
  'library.select': { en: 'Select', ko: '선택' },
  'library.done': { en: 'Done', ko: '완료' },
  'library.selectAll': { en: 'Select all', ko: '전체 선택' },
  'library.selectNone': { en: 'Clear selection', ko: '선택 해제' },
  'library.selectedCount': { en: '{count} selected', ko: '{count}개 선택' },
  'library.collectionAdd': { en: 'Add to folder', ko: '폴더에 추가' },
  'library.collectionRemove': { en: 'Remove from folder', ko: '폴더에서 제거' },
  'library.savedEmpty': {
    en: 'Save a work or download it to start your library.',
    ko: '작품을 저장하거나 다운로드하면 보관함에 모여요.',
  },
  'library.gestureHint': {
    en: 'Touch and hold a work, or right-click, to manage it. Use Select for several works.',
    ko: '작품을 길게 누르거나 우클릭해 관리하세요. 여러 작품은 선택 버튼으로 관리할 수 있어요.',
  },
  'library.failedDownloads': { en: 'Failed downloads', ko: '실패한 다운로드' },
  'library.stopRetry': { en: 'Stop automatic retry', ko: '자동 재시도 중단' },
  'library.searchSaved': { en: 'Search your library', ko: '보관함 검색' },
  'library.collectionTarget': { en: 'Choose a folder', ko: '폴더 선택' },
  'nav.more': { en: 'More', ko: '더보기' },
  'nav.main': { en: 'Main navigation', ko: '주요 메뉴' },
  'more.history.desc': {
    en: 'Recently viewed works and reading progress',
    ko: '최근 본 작품과 읽던 위치',
  },
  'more.settings.desc': {
    en: 'App, reading, content and storage preferences',
    ko: '앱·읽기·콘텐츠·저장 공간 설정',
  },
  'settings.needsAttention': { en: 'Needs attention', ko: '확인 필요' },
  'library.failed': { en: 'Failed', ko: '실패' },
  'library.pending': { en: 'Pending', ko: '대기 중' },
  'actions.title': { en: 'Work management', ko: '작품 관리' },
  'actions.save': { en: 'Add to library', ko: '보관함에 추가' },
  'actions.saved': { en: 'Saved in library', ko: '보관함에 저장됨' },
  'actions.manageCollections': { en: 'Folders', ko: '폴더 관리' },
  'actions.download': { en: 'Download', ko: '다운로드' },
  'actions.retry': { en: 'Retry download', ko: '다운로드 재시도' },
  'actions.export': { en: 'Export ZIP', ko: 'ZIP 내보내기' },
  'actions.share': { en: 'Share', ko: '공유' },
  'actions.copied': { en: 'Link copied', ko: '링크를 복사했어요' },
  'actions.deleteFiles': { en: 'Delete downloaded files', ko: '다운로드 파일 삭제' },
  'actions.remove': { en: 'Remove from library', ko: '보관함에서 제거' },
  'actions.confirmFiles': {
    en: 'Delete downloaded files? Works stay in your library.',
    ko: '다운로드 파일을 삭제할까요? 작품은 보관함에 남아요.',
  },
  'actions.confirmRemove': {
    en: 'Remove selected works from your library?',
    ko: '선택한 작품을 보관함에서 제거할까요?',
  },
  'actions.confirmRemoveFiles': {
    en: 'Remove works and their downloaded files? Reading history is kept.',
    ko: '작품을 보관함에서 제거하고 다운로드 파일도 삭제할까요? 읽기 기록은 남아요.',
  },
  'actions.busy': {
    en: 'Stop the download in Download manager before deleting files.',
    ko: '다운로드 관리에서 다운로드를 중단한 후 삭제해 주세요.',
  },
  'actions.failed': {
    en: 'The action failed. Try again.',
    ko: '처리하지 못했어요. 다시 시도해 주세요.',
  },
  'actions.loading': { en: 'Loading\u2026', ko: '불러오는 중…' },
  'actions.select': { en: 'Select', ko: '선택' },
  'actions.cancel': { en: 'Cancel', ko: '취소' },
  'actions.confirm': { en: 'Confirm', ko: '확인' },
  'actions.done': { en: 'Done', ko: '완료' },
  'actions.emptyCollections': {
    en: 'Create a folder in your library first.',
    ko: '보관함에서 폴더를 먼저 만들어 주세요.',
  },
  'actions.addCollection': { en: 'Add to collection', ko: '컬렉션에 추가' },
  'actions.removeCollection': { en: 'Remove from collection', ko: '컬렉션에서 제거' },
  'actions.read': { en: 'Read', ko: '읽기' },
  'actions.continue': { en: 'Continue reading', ko: '이어 읽기' },
  'history.clear': { en: 'Clear history', ko: '기록 전체 삭제' },
  'history.remove': { en: 'Delete selected history', ko: '선택한 기록 삭제' },
  'history.confirmDelete': {
    en: 'Delete reading history? Reading positions will reset. Saved works and downloaded files are kept.',
    ko: '기록을 삭제하면 읽던 위치도 초기화돼요. 보관함과 다운로드 파일은 유지됩니다.',
  },
  'settings.section.general': { en: 'General', ko: '일반' },
  'settings.section.reader': { en: 'Reading', ko: '읽기' },
  'settings.section.content': { en: 'Content', ko: '콘텐츠' },
  'settings.section.privacy': { en: 'Privacy', ko: '개인정보' },
  'settings.section.storage': { en: 'Storage', ko: '저장 공간' },
  'settings.section.about': { en: 'About', ko: '앱 정보' },
  'settings.section.general.desc': { en: 'App language', ko: '앱 표시 언어' },
  'settings.section.reader.desc': {
    en: 'Reader mode and image format',
    ko: '읽기 방식과 이미지 형식',
  },
  'settings.section.content.desc': {
    en: 'Work language, filters and tag database',
    ko: '작품 언어·필터·태그 데이터베이스',
  },
  'settings.section.privacy.desc': {
    en: 'Screen protection and blurred tags',
    ko: '화면 보호와 가릴 태그',
  },
  'settings.section.storage.desc': {
    en: 'Image cache and download location',
    ko: '이미지 캐시와 다운로드 위치',
  },
  'settings.section.about.desc': {
    en: 'Updates and open-source licenses',
    ko: '업데이트와 오픈소스 라이선스',
  },
  'settings.subtitle': {
    en: 'Make your reading space your own.',
    ko: '나에게 맞는 읽기 환경을 설정하세요.',
  },
  'settings.group.experience': { en: 'Your experience', ko: '사용 환경' },
  'settings.group.content': { en: 'Content and privacy', ko: '콘텐츠와 보호' },
  'settings.group.app': { en: 'App management', ko: '앱 관리' },
  // Header nav
  'nav.browse': { en: 'Browse', ko: '둘러보기' },
  'nav.search': { en: 'Search', ko: '검색' },
  'nav.favorites': { en: 'Favorites', ko: '즐겨찾기' },
  'nav.history': { en: 'History', ko: '기록' },
  'nav.library': { en: 'Library', ko: '보관함' },
  'nav.saved': { en: 'Library', ko: '보관함' },
  'nav.settings': { en: 'Settings', ko: '설정' },

  // 보관함 hub — segmented control (mobile merged tab)
  'saved.title': { en: 'Library', ko: '보관함' },
  'saved.seg.favorites': { en: 'Favorites', ko: '즐겨찾기' },
  'saved.seg.history': { en: 'History', ko: '기록' },
  'saved.seg.downloads': { en: 'Downloads', ko: '다운로드' },

  // Sort sheet (mobile)
  'sort.sheet.title': { en: 'Sort by', ko: '정렬' },

  // Search
  'search.placeholder': { en: 'Search tags... (Ctrl+K)', ko: '태그 검색... (Ctrl+K)' },
  'search.title': { en: 'Search', ko: '검색' },
  'search.results': { en: 'results', ko: '개' },
  'search.searching': { en: 'Searching...', ko: '검색 중...' },
  'search.noResults': { en: 'No results', ko: '결과 없음' },
  'search.langFallback': {
    en: 'No results in selected language. Showing all languages.',
    ko: '선택한 언어의 결과가 없어 전체 언어로 표시합니다.',
  },
  'search.otherResults': { en: 'Other results', ko: '다른 결과' },
  'search.recentSearches': { en: 'Recent Searches', ko: '최근 검색' },
  'search.clearHistory': { en: 'Clear all', ko: '전체 삭제' },
  'search.sortUnavailable': {
    en: 'Sorting is only available for single-tag searches',
    ko: '정렬은 단일 태그 검색에서만 사용 가능합니다',
  },
  'search.tagSuggestions': { en: 'Tag Suggestions', ko: '태그 제안' },
  'search.popularTags': { en: 'Popular Tags', ko: '인기 태그' },
  'search.koreanNeedsDb': {
    en: 'Korean search needs the local tag DB',
    ko: '한국어 검색은 로컬 태그 DB가 필요합니다',
  },

  // Tag DB sync status
  'sync.syncing': { en: 'Syncing tag DB', ko: '태그 DB 동기화 중' },
  'sync.failed': { en: 'Tag DB sync failed', ko: '태그 DB 동기화 실패' },
  'sync.failed.desc': {
    en: 'Tag autocomplete and popular tags need the tag DB. The sync failed — tap retry, or copy the error below.',
    ko: '태그 자동완성과 추천 태그는 태그 DB가 필요해요. 동기화가 실패했어요 — 재시도하거나 아래 오류를 복사해 주세요.',
  },
  'sync.retry': { en: 'Retry', ko: '재시도' },

  // Gallery detail
  'detail.back': { en: 'Back', ko: '뒤로' },
  'detail.read': { en: 'Read', ko: '읽기' },
  'detail.addFavorite': { en: 'Add to library', ko: '보관함에 추가' },
  'detail.removeFavorite': { en: 'Remove from library', ko: '보관함에서 제거' },
  'detail.content': { en: 'Content', ko: '내용' },
  'detail.related': { en: 'Related', ko: '관련 작품' },
  'detail.noImage': { en: 'No image', ko: '이미지 없음' },
  'detail.loadFailed': { en: 'Failed to load gallery', ko: '갤러리 로딩 실패' },
  'detail.unavailable': {
    en: 'This gallery has been removed or is temporarily unavailable.',
    ko: '이 갤러리는 삭제되었거나 일시적으로 이용할 수 없습니다.',
  },
  'detail.invalidId': { en: 'Invalid gallery ID', ko: '잘못된 갤러리 ID' },
  'detail.download': { en: 'Download', ko: '다운로드' },
  'detail.downloaded': { en: 'Downloaded', ko: '다운로드됨' },
  'detail.redownload': { en: 'Download again', ko: '다시 다운로드' },
  'detail.redownloadConfirm': {
    en: 'This gallery is already downloaded. Download it again?',
    ko: '이미 다운로드된 갤러리입니다. 다시 받을까요?',
  },
  'detail.filesMissing': { en: 'Files missing · Re-download', ko: '로컬 파일 없음 · 다시 받기' },
  'detail.copyId': { en: 'Copy ID', ko: 'ID 복사' },
  'detail.copied': { en: 'ID copied!', ko: 'ID 복사됨!' },

  // Gallery card
  'card.failed': { en: 'Failed', ko: '실패' },

  // Favorites / History
  'favorites.title': { en: 'Favorites', ko: '즐겨찾기' },
  'favorites.empty': {
    en: 'No favorites yet. Browse galleries and add some!',
    ko: '즐겨찾기가 없습니다. 갤러리를 둘러보고 추가해보세요!',
  },
  'history.title': { en: 'History', ko: '기록' },
  'history.search.placeholder': { en: 'Search your history', ko: '기록 검색' },
  'history.empty': { en: 'No recently viewed galleries.', ko: '최근 본 갤러리가 없습니다.' },
  'history.today': { en: 'Today', ko: '오늘' },
  'history.yesterday': { en: 'Yesterday', ko: '어제' },
  'history.thisWeek': { en: 'This Week', ko: '이번 주' },
  'history.lastWeek': { en: 'Last Week', ko: '지난주' },
  'history.thisMonth': { en: 'This Month', ko: '이번 달' },
  'history.older': { en: 'Older', ko: '더 이전' },
  'db.error.title': {
    en: 'Local database unavailable',
    ko: '로컬 데이터베이스를 사용할 수 없습니다',
  },
  'db.error.desc': {
    en: 'History and favorites are stored on this device and need the local database, which failed to start. Try restarting the app.',
    ko: '기록과 즐겨찾기는 이 기기에 저장되며 로컬 데이터베이스가 필요한데, 시작에 실패했습니다. 앱을 다시 시작해 보세요.',
  },
  'db.preparing': {
    en: 'Preparing database…',
    ko: '데이터베이스 준비 중…',
  },
  'db.error.copy': { en: 'Copy error', ko: '에러 복사' },
  'db.error.copied': { en: 'Copied', ko: '복사됨' },
  'db.error.copyPrompt': { en: 'Copy this error:', ko: '이 에러를 복사하세요:' },
  'db.error.dismiss': { en: 'Dismiss', ko: '닫기' },

  // Library (offline downloads)
  'library.title': { en: 'Library', ko: '라이브러리' },
  'library.empty': { en: 'No downloaded galleries yet.', ko: '다운로드된 갤러리가 없습니다.' },
  'library.storageUsed': { en: 'Storage used', ko: '사용 중인 저장 공간' },
  'library.pages': { en: 'pages', ko: '페이지' },
  'library.open': { en: 'Open', ko: '열기' },
  'library.delete': { en: 'Delete', ko: '삭제' },
  'library.exportZip': { en: 'Export ZIP', ko: 'ZIP 내보내기' },
  'library.exportFailed': {
    en: 'Could not export ZIP. Some downloaded files may be missing.',
    ko: 'ZIP을 내보낼 수 없습니다. 일부 다운로드 파일이 없을 수 있습니다.',
  },
  'library.confirmDelete': { en: 'Delete this download?', ko: '이 다운로드를 삭제하시겠습니까?' },
  'library.retry': { en: 'Retry', ko: '재시도' },
  'library.retrying': { en: 'Retrying', ko: '재시도 중' },
  // Staged auto-restart of failed downloads (Task E). `{time}`/`{k}`/`{max}` are
  // interpolated by the caller (the t() helper does plain key lookup only).
  'library.retry.autoIn': { en: 'Auto-retry in {time}', ko: '{time} 후 자동 재시도' },
  'library.retry.attempt': { en: 'attempt {k}/{max}', ko: '시도 {k}/{max}' },
  'library.retry.now': { en: 'Auto-retry imminent', ko: '곧 자동 재시도' },
  'library.retry.unit.minute': { en: 'm', ko: '분' },
  'library.retry.unit.second': { en: 's', ko: '초' },
  'library.errorPrefix': { en: 'Error', ko: '오류' },
  'library.more': { en: 'More actions', ko: '더보기' },
  'library.status.downloading': { en: 'Downloading', ko: '다운로드 중' },
  'library.status.complete': { en: 'Complete', ko: '완료' },
  'library.status.failed': { en: 'Failed', ko: '실패' },
  'library.search.placeholder': { en: 'Search downloads...', ko: '다운로드 검색...' },

  // Download manager / queue (top of the Downloads tab)
  'library.queue.title': { en: 'Downloading', ko: '다운로드 중' },
  'library.queue.active': { en: 'Now downloading', ko: '현재 다운로드' },
  'library.queue.queued': { en: 'Queued', ko: '대기 중' },
  'library.queue.paused': { en: 'Paused', ko: '일시중지됨' },
  'library.queue.downloading': { en: 'Downloading', ko: '다운로드 중' },
  'library.queue.pause': { en: 'Pause', ko: '일시중지' },
  'library.queue.resume': { en: 'Resume', ko: '재개' },
  'library.queue.cancel': { en: 'Remove from queue', ko: '대기열에서 제거' },
  'library.queue.pauseAll': { en: 'Pause all', ko: '모두 일시중지' },
  'library.queue.resumeAll': { en: 'Resume all', ko: '모두 재개' },
  'library.queue.empty': { en: 'No active downloads', ko: '진행 중인 다운로드 없음' },
  'library.queue.reorder': { en: 'Drag to reorder', ko: '드래그하여 순서 변경' },
  'library.queue.position': { en: 'Position', ko: '순서' },
  'library.queue.of': { en: 'of', ko: '/' },

  // Pagination
  'page.shown': { en: 'shown', ko: '표시' },

  // Sort
  'sort.date_added': { en: 'Date Added', ko: '등록순' },
  'sort.popular_year': { en: 'Popular: Year', ko: '인기: 연간' },
  'sort.popular_month': { en: 'Popular: Month', ko: '인기: 월간' },
  'sort.popular_week': { en: 'Popular: Week', ko: '인기: 주간' },
  'sort.popular_day': { en: 'Popular: Day', ko: '인기: 일간' },

  // Reader
  'reader.back': { en: 'Back', ko: '뒤로' },
  'reader.prev': { en: 'Prev', ko: '이전' },
  'reader.next': { en: 'Next', ko: '다음' },
  'reader.scroll': { en: 'Scroll', ko: '스크롤' },
  'reader.page': { en: 'Page', ko: '페이지' },

  // Settings
  'settings.title': { en: 'Settings', ko: '설정' },
  'settings.locale': { en: 'System Language', ko: '시스템 언어' },
  'settings.locale.desc': {
    en: 'Change UI and tag display language',
    ko: 'UI 및 태그 표시 언어 변경',
  },
  'settings.locale.en': { en: 'English', ko: 'English' },
  'settings.locale.ko': { en: '한국어', ko: '한국어' },
  'settings.langFilter': { en: 'Language Filter', ko: '언어 필터' },
  'settings.langFilter.desc': { en: 'Filter galleries by language', ko: '언어별 갤러리 필터' },
  'settings.langFilter.all': { en: 'All Languages', ko: '전체' },
  'settings.langFilter.japanese': { en: 'Japanese', ko: '일본어' },
  'settings.langFilter.english': { en: 'English', ko: '영어' },
  'settings.langFilter.chinese': { en: 'Chinese', ko: '중국어' },
  'settings.langFilter.korean': { en: 'Korean', ko: '한국어' },
  'settings.libraryInitialTab': { en: 'Library Start Tab', ko: '라이브러리 시작 탭' },
  'settings.libraryInitialTab.desc': {
    en: 'Choose which tab opens first when entering Library',
    ko: '라이브러리에 들어갈 때 처음 열 탭을 선택합니다',
  },
  'settings.tagDb': { en: 'Tag DB', ko: '태그 DB' },
  'settings.tagDb.desc': {
    en: 'Local tag autocomplete, Korean search, and popular tags use this database',
    ko: '태그 자동완성, 한국어 검색, 인기 태그가 이 로컬 DB를 사용합니다',
  },
  'settings.tagDb.status.ready': { en: 'Synced', ko: '동기화 완료' },
  'settings.tagDb.status.syncing': { en: 'Syncing', ko: '동기화 중' },
  'settings.tagDb.status.failed': { en: 'Failed', ko: '실패' },
  'settings.tagDb.status.stale': { en: 'Refresh needed', ko: '갱신 필요' },
  'settings.tagDb.status.preparing': { en: 'Preparing', ko: '준비 중' },
  'settings.tagDb.status.idle': { en: 'Not ready', ko: '준비 안 됨' },
  'settings.tagDb.tags': { en: 'Tags', ko: '태그 수' },
  'settings.tagDb.lastSync': { en: 'Last sync', ko: '마지막 동기화' },
  'settings.tagDb.neverSynced': { en: 'Never', ko: '없음' },
  'settings.tagDb.unknown': { en: 'Unknown', ko: '알 수 없음' },
  'settings.tagDb.start': { en: 'Start sync', ko: '동기화 시작' },
  'settings.tagDb.resync': { en: 'Sync again', ko: '다시 동기화' },
  'settings.tagDb.progress': { en: 'Progress', ko: '진행률' },
  'settings.tagDb.initStage': { en: 'DB init', ko: 'DB 초기화' },
  'settings.defaultFilter': { en: 'Default Filter', ko: '기본 필터' },
  'settings.defaultFilter.desc': {
    en: 'Apply this query to every list and search result',
    ko: '모든 목록과 검색 결과에 적용할 쿼리',
  },
  'settings.defaultFilter.placeholder': {
    en: 'Example: -male:yaoi',
    ko: '예: -male:yaoi',
  },
  'settings.theme': { en: 'Theme', ko: '테마' },
  'settings.theme.desc': { en: 'Choose your preferred color scheme', ko: '색상 테마 선택' },
  'settings.theme.light': { en: 'Light', ko: '라이트' },
  'settings.theme.dark': { en: 'Dark', ko: '다크' },
  'settings.reader': { en: 'Reader Mode', ko: '뷰어 모드' },
  'settings.reader.desc': { en: 'Choose how to view gallery pages', ko: '갤러리 페이지 보기 방식' },
  'settings.reader.page': { en: 'Page', ko: '페이지' },
  'settings.reader.scroll': { en: 'Scroll', ko: '스크롤' },
  'settings.imageFormat': { en: 'Image Format', ko: '이미지 형식' },
  'settings.imageFormat.desc': { en: 'Preferred image format for loading', ko: '이미지 로딩 형식' },
  'settings.secureScreen': { en: 'Secure Screen', ko: '보안 화면' },
  'settings.secureScreen.desc': {
    en: 'Hide app content from Android screenshots, screen recording, and recent apps',
    ko: 'Android 스크린샷, 화면 녹화, 최근 앱 화면에서 앱 내용을 숨깁니다',
  },
  'settings.secureScreen.off': { en: 'Off', ko: '끔' },
  'settings.secureScreen.on': { en: 'On', ko: '켬' },
  'settings.imageCache': { en: 'Image Cache', ko: '이미지 캐시' },
  'settings.imageCache.desc': {
    en: 'Cache full-size images so they load instantly next time',
    ko: '원본 이미지를 캐시해 다음엔 즉시 로딩',
  },
  'settings.imageCache.used': { en: 'used', ko: '사용 중' },
  'settings.imageCache.max': { en: 'Max size (MB)', ko: '최대 크기 (MB)' },
  'settings.imageCache.unlimited': { en: 'Unlimited', ko: '무제한' },
  'settings.imageCache.off': { en: '0 = off', ko: '0 = 끔' },
  'settings.imageCache.clear': { en: 'Clear cache', ko: '캐시 비우기' },
  'settings.blurTags': { en: 'Blur Tags', ko: '블러 태그' },
  'settings.blurTags.desc': {
    en: 'Galleries with these tags will be blurred',
    ko: '해당 태그가 포함된 작품은 블러 처리됩니다',
  },
  'settings.blurTags.placeholder': { en: 'Search tag to add...', ko: '추가할 태그 검색...' },
  'settings.blurTags.empty': { en: 'No blur tags set', ko: '설정된 블러 태그 없음' },

  // Settings → Download location (Android only)
  'settings.downloadLocation': { en: 'Download Location', ko: '다운로드 위치' },
  'settings.downloadLocation.desc': {
    en: 'Pick a folder for offline galleries. The app creates a HiPaGo subfolder inside it. Files stay visible in a file manager and persist after uninstall, but are hidden from the Gallery app (.nomedia). You only choose the folder once.',
    ko: '오프라인 갤러리를 저장할 폴더를 선택하세요. 그 안에 HiPaGo 하위 폴더를 앱이 자동으로 만듭니다. 파일 관리자에서는 보이고 앱 삭제 후에도 유지되지만, 갤러리 앱에는 표시되지 않습니다(.nomedia). 폴더는 한 번만 고르면 됩니다.',
  },
  'settings.downloadLocation.current': { en: 'Current folder', ko: '현재 폴더' },
  'settings.downloadLocation.notSelected': { en: 'Not selected yet', ko: '아직 선택 안 됨' },
  'settings.downloadLocation.select': { en: 'Select folder', ko: '폴더 선택' },
  'settings.downloadLocation.change': { en: 'Change folder', ko: '폴더 변경' },
  'settings.downloadLocation.clear': { en: 'Clear', ko: '해제' },
  'settings.downloadLocation.hint': {
    en: 'If not set, you will be asked to pick a folder on your first download.',
    ko: '설정하지 않으면 첫 다운로드 시 폴더를 선택하라는 창이 뜹니다.',
  },

  // Gallery list
  'list.loadMore': { en: 'More', ko: '더보기' },

  // Language filter (header)
  'langFilter.label': { en: 'Language filter', ko: '언어 필터' },

  // Mobile drawer + empty-state CTAs
  'mobile.menu.close': { en: 'Close menu', ko: '메뉴 닫기' },
  'mobile.menu.open': { en: 'Open menu', ko: '메뉴 열기' },

  // Floating page nav — page-jump modal + ARIA
  'pageJump.title': { en: 'Go to page', ko: '페이지 이동' },
  'pageJump.current': { en: 'Current', ko: '현재' },
  'pageJump.go': { en: 'Go', ko: '이동' },
  'pageJump.cancel': { en: 'Cancel', ko: '취소' },
  'pageJump.close': { en: 'Close dialog', ko: '대화상자 닫기' },
  'pageNav.prev': { en: 'Previous page', ko: '이전 페이지' },
  'pageNav.next': { en: 'Next page', ko: '다음 페이지' },
  'pageNav.shrinkGrid': { en: 'Larger cards', ko: '카드 크게' },
  'pageNav.growGrid': { en: 'Smaller cards', ko: '카드 작게' },
  'pageNav.jumpToPage': { en: 'Jump to page', ko: '페이지 이동' },
  'empty.browseGalleries': { en: 'Browse galleries', ko: '갤러리 둘러보기' },
  'licenses.search.clear': { en: 'Clear filter', ko: '필터 지우기' },
  'reader.jumpToPage': { en: 'Jump to page', ko: '페이지 이동' },

  // Open-source licenses page + settings link card
  'licenses.title': { en: 'Open-source licenses', ko: '오픈소스 라이선스' },
  'licenses.search.placeholder': {
    en: 'Filter by name or license…',
    ko: '이름이나 라이선스로 필터…',
  },
  'licenses.empty': { en: 'No matches', ko: '일치하는 항목 없음' },
  'licenses.npm.heading': { en: 'JavaScript / npm', ko: 'JavaScript / npm' },
  'licenses.cargo.heading': { en: 'Rust / cargo', ko: 'Rust / cargo' },
  'licenses.viewRepo': { en: 'Repository', ko: '저장소' },
  'licenses.about': { en: 'Open-source licenses', ko: '오픈소스 라이선스' },
  'licenses.about.desc': {
    en: 'See every bundled dependency and its license',
    ko: '번들된 모든 라이브러리와 라이선스 보기',
  },

  // Update banner (top of layout, on-mount check)
  'update.banner.title': { en: 'New version available', ko: '새 버전 사용 가능' },
  'update.banner.install': { en: 'Install', ko: '설치' },
  'update.banner.viewOnGitHub': { en: 'View on GitHub', ko: 'GitHub에서 보기' },
  'update.banner.later': { en: 'Later', ko: '나중에' },
  'update.banner.installing': { en: 'Installing…', ko: '설치 중…' },
  'update.banner.downloading': { en: 'Downloading', ko: '다운로드 중' },
  'update.banner.permissionRequired': {
    en: 'Allow installs in Settings, then tap Install again.',
    ko: '설정에서 설치 권한을 허용한 뒤 다시 설치를 눌러주세요.',
  },
  'update.banner.installerStarted': {
    en: 'Installer opened. If you cancelled it, tap Install again.',
    ko: '설치 화면을 열었습니다. 취소했다면 다시 설치를 눌러주세요.',
  },
  'update.banner.installFailed': {
    en: "Couldn't start the update. Please try again.",
    ko: '업데이트를 시작하지 못했습니다. 다시 시도해주세요.',
  },

  // Settings → About / Update
  'update.about': { en: 'Updates', ko: '업데이트' },
  'update.beta': { en: 'Beta', ko: '베타' },
  'update.receiveBeta': { en: 'Receive beta updates', ko: '베타 업데이트 받기' },
  'update.receiveBeta.help': {
    en: 'Try public beta releases before stable. They may have bugs. Turning this off will not downgrade an installed beta.',
    ko: '정식 출시 전 공개 베타를 받습니다. 오류가 있을 수 있으며, 꺼도 설치된 베타가 이전 버전으로 내려가지 않습니다.',
  },
  'update.about.desc': {
    en: 'Current version and manual update check',
    ko: '현재 버전 및 수동 업데이트 확인',
  },
  'update.about.currentVersion': { en: 'Current version', ko: '현재 버전' },
  'update.about.check': { en: 'Check for updates', ko: '업데이트 확인' },
  'update.about.checking': { en: 'Checking…', ko: '확인 중…' },
  'update.about.upToDate': { en: "You're on the latest version", ko: '최신 버전입니다' },
  'update.about.newAvailable': { en: 'available', ko: '버전이 출시되었습니다' },
  'update.about.checkFailed': {
    en: "Couldn't check for updates",
    ko: '업데이트를 확인하지 못했습니다',
  },

  // Error pages
  'error.title': { en: 'Something went wrong', ko: '문제가 발생했습니다' },
  'error.tryAgain': { en: 'Try again', ko: '다시 시도' },
  'error.galleryFailed': { en: 'Failed to load gallery', ko: '갤러리 로딩 실패' },
  'error.backHome': { en: 'Back to home', ko: '홈으로' },
  'error.unexpected': {
    en: 'An unexpected error occurred. Please try again.',
    ko: '예기치 않은 오류가 발생했습니다. 다시 시도해주세요.',
  },
} as const;

export type TranslationKey = keyof typeof translations;

export function t(key: TranslationKey, locale: Locale): string {
  return translations[key][locale];
}

import type { Locale } from '@/lib/store/settings';

const translations = {
  // Header nav
  'nav.browse': { en: 'Browse', ko: '둘러보기' },
  'nav.favorites': { en: 'Favorites', ko: '즐겨찾기' },
  'nav.history': { en: 'History', ko: '기록' },
  'nav.library': { en: 'Library', ko: '라이브러리' },
  'nav.settings': { en: 'Settings', ko: '설정' },

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
  'sync.retry': { en: 'Retry', ko: '재시도' },

  // Gallery detail
  'detail.back': { en: 'Back', ko: '뒤로' },
  'detail.read': { en: 'Read', ko: '읽기' },
  'detail.addFavorite': { en: 'Add to Favorites', ko: '즐겨찾기 추가' },
  'detail.removeFavorite': { en: 'Remove from Favorites', ko: '즐겨찾기 해제' },
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
  'history.empty': { en: 'No recently viewed galleries.', ko: '최근 본 갤러리가 없습니다.' },
  'history.today': { en: 'Today', ko: '오늘' },
  'history.yesterday': { en: 'Yesterday', ko: '어제' },
  'history.thisWeek': { en: 'This Week', ko: '이번 주' },
  'history.lastWeek': { en: 'Last Week', ko: '지난주' },
  'history.thisMonth': { en: 'This Month', ko: '이번 달' },
  'history.older': { en: 'Older', ko: '더 이전' },

  // Library (offline downloads)
  'library.title': { en: 'Library', ko: '라이브러리' },
  'library.empty': { en: 'No downloaded galleries yet.', ko: '다운로드된 갤러리가 없습니다.' },
  'library.storageUsed': { en: 'Storage used', ko: '사용 중인 저장 공간' },
  'library.pages': { en: 'pages', ko: '페이지' },
  'library.open': { en: 'Open', ko: '열기' },
  'library.delete': { en: 'Delete', ko: '삭제' },
  'library.exportZip': { en: 'Export ZIP', ko: 'ZIP 내보내기' },
  'library.confirmDelete': { en: 'Delete this download?', ko: '이 다운로드를 삭제하시겠습니까?' },
  'library.status.downloading': { en: 'Downloading', ko: '다운로드 중' },
  'library.status.complete': { en: 'Complete', ko: '완료' },
  'library.status.failed': { en: 'Failed', ko: '실패' },
  'library.search.placeholder': { en: 'Search downloads...', ko: '다운로드 검색...' },

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
  'settings.blurTags': { en: 'Blur Tags', ko: '블러 태그' },
  'settings.blurTags.desc': {
    en: 'Galleries with these tags will be blurred',
    ko: '해당 태그가 포함된 작품은 블러 처리됩니다',
  },
  'settings.blurTags.placeholder': { en: 'Search tag to add...', ko: '추가할 태그 검색...' },
  'settings.blurTags.empty': { en: 'No blur tags set', ko: '설정된 블러 태그 없음' },

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

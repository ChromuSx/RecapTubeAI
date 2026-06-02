// constants.js - RecapTube AI application constants

// Palette for AI-generated chapter markers on the progress bar (cycled by index)
export const CHAPTER_MARKER_COLORS = [
  '#3ea6ff', // blue
  '#7e57c2', // purple
  '#26a69a', // teal
  '#ffa726', // orange
  '#ec407a', // pink
  '#66bb6a'  // green
];

// DOM Selectors
export const SELECTORS = {
  VIDEO: 'video',
  PLAYER: '#movie_player, .html5-video-player',
  PROGRESS_BAR: '.ytp-progress-bar',
  CHANNEL_NAME: 'ytd-channel-name a',
  VIDEO_TITLE: 'h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string',

  // Anchors for injecting the in-page panel (first match wins). Sidebar first, below-video fallback.
  PANEL_ANCHORS: ['#secondary-inner', '#secondary', '#below', 'ytd-watch-metadata'],

  // --- Transcript extraction (reused from SkipTube, resilient to redesigns) ---
  // Description expander ("...more") that reveals the "Show transcript" button.
  // YouTube moved the transcript button inside the (collapsed) description in 2024-2026.
  DESCRIPTION_EXPANDER: '#expand, tp-yt-paper-button#expand, ytd-text-inline-expander #expand',
  // "Show transcript" button lives in the description's transcript section.
  TRANSCRIPT_BUTTON_SECTION: 'ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer ytd-button-renderer button',
  // Engagement panel. target-id substring "transcript" matches all known variants:
  // PAmodern_transcript_view (2026 "modern" panel), engagement-panel-searchable-transcript, engagement-panel-transcript.
  TRANSCRIPT_PANEL: 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
  // Two coexisting transcript UIs (YouTube is migrating gradually):
  //   - legacy Polymer: ytd-transcript-segment-renderer  (.segment-timestamp / .segment-text)
  //   - modern view-model: transcript-segment-view-model  (.ytwTranscriptSegmentViewModelTimestamp / .ytAttributedStringHost)
  // The class sets are disjoint, so combining them is safe (only one matches per segment).
  TRANSCRIPT_SEGMENTS: 'ytd-transcript-segment-renderer, transcript-segment-view-model',
  SEGMENT_TIMESTAMP: '.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp, [class*="timestamp"]',
  SEGMENT_TEXT: '.segment-text, [class*="segment-text"], [class*="cue-text"], .ytAttributedStringHost',

  // --- Native chapter detection / reading ---
  // Player chapter ticks (≥2 means the video already has chapters).
  PLAYER_CHAPTERS: '.ytp-chapters-container .ytp-chapter-hover-container',
  // Chapters engagement panel + its rows.
  NATIVE_CHAPTERS_PANEL: 'ytd-macro-markers-list-renderer, ytd-engagement-panel-section-list-renderer[target-id*="chapters"], ytd-engagement-panel-section-list-renderer[target-id*="macro-markers"]',
  NATIVE_CHAPTER_ITEM: 'ytd-macro-markers-list-item-renderer',
  // Inside a native chapter item: the title and the timestamp text.
  NATIVE_CHAPTER_TITLE: '#details h4, h4.macro-markers, #details .macro-markers, [id="details"] h4',
  NATIVE_CHAPTER_TIME: '#time, .macro-markers#time, [id="time"]'
};

// MAIN-world transcript interceptor message contract (see src/content/transcript-interceptor.js)
// NOTE: distinct from SkipTube's YSS_* contract so both extensions can coexist on a page.
export const INTERCEPTOR = {
  MESSAGE_SOURCE: 'RT_INTERCEPTOR',
  MESSAGE_TYPE: 'RT_TRANSCRIPT'
};

// Message actions for chrome.runtime messaging
export const MESSAGE_ACTIONS = {
  GENERATE_RECAP: 'generateRecap',
  HEAL_SELECTORS: 'healSelectors',
  UPDATE_API_KEY: 'updateAPIKey',
  UPDATE_PROVIDER: 'updateProvider',
  GET_API_KEY_STATUS: 'getAPIKeyStatus',
  UPDATE_SETTINGS: 'updateSettings',
  UPDATE_ADVANCED_SETTINGS: 'updateAdvancedSettings',
  MANUAL_RECAP: 'manualRecap',
  GET_CURRENT_CHANNEL: 'getCurrentChannel'
};

// Notification types
export const NOTIFICATION_TYPES = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error'
};

// Notification colors
export const NOTIFICATION_COLORS = {
  [NOTIFICATION_TYPES.INFO]: '#3ea6ff',
  [NOTIFICATION_TYPES.SUCCESS]: '#27ae60',
  [NOTIFICATION_TYPES.WARNING]: '#f39c12',
  [NOTIFICATION_TYPES.ERROR]: '#e74c3c'
};

// CSS class names (rt- prefix, distinct from SkipTube's yss-)
export const CSS_CLASSES = {
  PANEL: 'rt-panel',
  CHAPTER_MARKER: 'rt-chapter-marker', // legacy thin marker (kept for cleanup)
  CHAPTER_TRACK: 'rt-chapter-track',   // overlay container on the progress bar
  CHAPTER_SEG: 'rt-chapter-seg',       // one chapter band inside the track
  TOOLTIP: 'rt-tooltip',
  NOTIFICATION: 'rt-notification',
  STYLE_TAG: 'rt-styles'
};

// Storage keys
export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  ADVANCED_SETTINGS: 'advancedSettings',
  DARK_MODE: 'darkMode',
  HEALED_SELECTORS: 'healedSelectors'
};

// YouTube-specific constants
export const YOUTUBE = {
  URL_PATTERN: /youtube\.com\/watch/,
  VIDEO_ID_PARAM: 'v',
  TRANSCRIPT_BUTTON_TEXT: ['trascrizione', 'transcript'],
  MESSAGE_TYPE: INTERCEPTOR.MESSAGE_TYPE
};

// Error messages
export const ERROR_MESSAGES = {
  API_KEY_NOT_CONFIGURED: 'API key not configured. Set your Claude/OpenAI key in the RecapTube popup.',
  NO_TRANSCRIPT: '⚠️ Transcript not available for this video. RecapTube only works with videos that have subtitles.',
  RECAP_ERROR: '❌ Error while generating the recap',
  API_ERROR: '❌ AI error: {error}. Check your API key in the popup.',
  CHANNEL_NOT_FOUND: '⚠️ Channel element not found',
  CONTENT_SCRIPT_UNAVAILABLE: '⚠️ Content script not available: {error}'
};

// Success messages
export const SUCCESS_MESSAGES = {
  RECAP_LOADED: '✅ Recap loaded from cache',
  RECAP_READY: '✅ Summary ready ({count} chapters)',
  RECAP_READY_NO_CHAPTERS: '✅ Summary ready',
  CACHE_CLEARED: 'Recap cache cleared! Reload the page to regenerate.'
};

// Info messages
export const INFO_MESSAGES = {
  GENERATING: '🧠 Summarizing the video with AI…',
  TRANSCRIPT_LOADING: '✓ Transcript loaded: {count} segments. Summarizing…',
  CHANNEL_WHITELISTED: 'ℹ️ Channel excluded by advanced settings',
  NATIVE_CHAPTERS: 'ℹ️ Native chapters detected → skipping AI chapters',
  NOT_YOUTUBE: 'ℹ️ Not on a YouTube watch page'
};

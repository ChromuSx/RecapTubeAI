// config.js - Centralized configuration
export const CONFIG = {
  // AI Provider Configuration
  AI_PROVIDERS: {
    CLAUDE: {
      NAME: 'claude',
      ENDPOINT: 'https://api.anthropic.com/v1/messages',
      VERSION: '2023-06-01',
      TIMEOUT: 60000,
      MODELS: {
        HAIKU: 'claude-haiku-4-5-20251001',
        SONNET: 'claude-sonnet-4-6'
      }
    },
    OPENAI: {
      NAME: 'openai',
      ENDPOINT: 'https://api.openai.com/v1/chat/completions',
      TIMEOUT: 60000,
      MODELS: {
        GPT_5_5: 'gpt-5.5',
        GPT_5_4_MINI: 'gpt-5.4-mini',
        GPT_5_4_NANO: 'gpt-5.4-nano'
      }
    }
  },

  // Legacy API Configuration (for backwards compatibility)
  API: {
    ENDPOINT: 'https://api.anthropic.com/v1/messages',
    VERSION: '2023-06-01',
    TIMEOUT: 30000,
    MODELS: {
      HAIKU: 'claude-haiku-4-5-20251001',
      SONNET: 'claude-sonnet-4-6'
    },
    MAX_TOKENS: 1000
  },

  // Transcript extraction settings
  TRANSCRIPT: {
    RETRY_COUNT: 10,
    RETRY_DELAY_MS: 800,
    WAIT_FOR_INTERCEPT_MS: 10000,
    SEGMENT_DEFAULT_DURATION: 5
  },

  // Cache settings
  CACHE: {
    MAX_AGE_DAYS: 30,
    KEY_PREFIX: 'recap_'
  },

  // Stronger models forced for high-stakes tasks (self-heal)
  STRONG_MODEL: {
    claude: 'sonnet',
    openai: 'gpt-5.5'
  },

  // Video / page settings
  VIDEO: {
    INITIAL_LOAD_DELAY_MS: 2000
  },

  // UI settings
  UI: {
    NOTIFICATION_DURATION_MS: 3500,
    TOAST_DURATION_MS: 3500,
    MARKER_OPACITY: 0.65,
    MARKER_HOVER_OPACITY: 0.95,
    TOOLTIP_MAX_WIDTH: 320
  },

  // Default settings
  DEFAULTS: {
    SETTINGS: {
      enabled: true,                 // master on/off
      autoGenerate: true,            // generate on each video automatically; if false, wait for a button click (saves API cost)
      generateSummary: true,         // produce the AI summary
      generateChapters: true,        // produce AI chapters when the video has none
      showProgressMarkers: true,     // draw chapter markers on the progress bar
      autoOpenPanel: true,           // open the in-page panel automatically
      summaryLength: 'medium',       // 'short' | 'medium' | 'long'
      outputLanguage: 'auto'         // 'auto' (browser language) or a BCP-47 code ('it', 'en', ...)
    },
    ADVANCED_SETTINGS: {
      aiProvider: 'claude',          // 'claude' or 'openai'
      aiModel: 'haiku',
      channelWhitelist: []
    }
  }
};

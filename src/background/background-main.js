// background-main.js - Service Worker entry point (RecapTube AI)
import { CONFIG } from '../shared/config.js';
import { RecapService } from '../shared/services/recap-service.js';
import { Transcript } from '../shared/models/transcript.js';
import { logger } from '../shared/logger/index.js';

const RECAP_PREFIX = CONFIG.CACHE.KEY_PREFIX; // 'recap_'
const MAX_AGE_MS = CONFIG.CACHE.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * BackgroundService - Main service worker handler
 */
class BackgroundService {
  constructor() {
    this.recapService = null;
    this.initialized = false;
    this.init();
  }

  async init() {
    try {
      await this.loadAPIKey();
      this.initialized = true;
      logger.info('Background service initialized');
    } catch (error) {
      logger.error('Failed to initialize background service', { error: error.message });
    }
  }

  /**
   * Load the API key for the selected provider and (re)create the recap service.
   */
  async loadAPIKey() {
    try {
      const result = await chrome.storage.local.get(['claudeApiKey', 'openaiApiKey', 'apiKey', 'advancedSettings']);
      const advancedSettings = result.advancedSettings || {};
      const selectedProvider = advancedSettings.aiProvider || CONFIG.AI_PROVIDERS.CLAUDE.NAME;

      let apiKey = null;
      if (selectedProvider === CONFIG.AI_PROVIDERS.OPENAI.NAME) {
        apiKey = result.openaiApiKey;
      } else {
        // Default to Claude; migrate legacy `apiKey` if present
        apiKey = result.claudeApiKey || result.apiKey;
      }

      if (apiKey && apiKey.length >= 20) {
        this.createRecapService(apiKey, selectedProvider);
      } else {
        logger.warn('No valid API key found in storage');
      }
    } catch (error) {
      logger.error('Error loading API key', { error: error.message });
    }
  }

  createRecapService(apiKey, provider = null) {
    const selectedProvider = provider || CONFIG.AI_PROVIDERS.CLAUDE.NAME;
    this.recapService = new RecapService(apiKey, selectedProvider);
    logger.info('Recap service created', { provider: selectedProvider });
  }

  setupMessageListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // keep channel open for async response
    });
  }

  async handleMessage(message, sender, sendResponse) {
    try {
      const { action, data } = message;
      switch (action) {
        case 'generateRecap':
          await this.handleGenerateRecap(data, sendResponse);
          break;
        case 'answerQuestion':
          await this.handleAnswerQuestion(data, sendResponse);
          break;
        case 'healSelectors':
          await this.handleHealSelectors(data, sendResponse);
          break;
        case 'updateAPIKey':
          await this.handleAPIKeyUpdate(data, sendResponse);
          break;
        case 'updateProvider':
          await this.handleProviderChange(data, sendResponse);
          break;
        case 'getAPIKeyStatus':
          this.handleGetAPIKeyStatus(sendResponse);
          break;
        case 'clearRecapCache':
          await this.handleClearRecapCache(data, sendResponse);
          break;
        default:
          logger.warn('Unknown action received', { action });
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      logger.error('Error handling message', { error: error.message, action: message.action });
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * Generate (or return cached) recap for a video.
   * data: { videoId, segments, title, durationSec, needChapters, summaryLength, lang }
   */
  async handleGenerateRecap(data, sendResponse) {
    try {
      const {
        videoId,
        segments = [],
        title = '',
        durationSec = 0,
        needChapters = true,
        summaryLength = 'medium',
        lang = 'en',
        force = false
      } = data || {};

      const baseLang = this.normalizeLang(lang);
      const cacheKey = `${RECAP_PREFIX}${videoId}_${baseLang}`;

      // Cache check (unless a forced regeneration was requested)
      if (!force) {
        const cached = await this.getCachedRecap(cacheKey);
        if (cached) {
          logger.info('Returning cached recap', { videoId, lang: baseLang });
          sendResponse({ success: true, recap: cached.recap, cached: true });
          return;
        }
      }

      if (!this.recapService) {
        await this.loadAPIKey();
        if (!this.recapService) {
          sendResponse({
            success: false,
            error: 'API key not configured. Please set your API key in the extension popup.'
          });
          return;
        }
      }

      // Resolve the model from advanced settings at call time
      const stored = await chrome.storage.local.get(['advancedSettings']);
      const aiModel = (stored.advancedSettings && stored.advancedSettings.aiModel) || undefined;

      const transcript = Transcript.fromDOM(segments, videoId, '');
      const recap = await this.recapService.generateRecap(transcript, {
        targetLanguage: this.languageName(baseLang),
        needChapters,
        summaryLength,
        aiModel,
        durationSec,
        title
      });

      await this.setCachedRecap(cacheKey, { recap, lang: baseLang, title, createdAt: Date.now() });

      sendResponse({ success: true, recap, cached: false });
    } catch (error) {
      logger.error('Recap failed', { error: error.message, videoId: data && data.videoId });
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * Answer a free-form question about a video using its transcript.
   * data: { videoId, segments, question, lang }
   */
  async handleAnswerQuestion(data, sendResponse) {
    try {
      const { segments = [], question = '', lang = 'en', durationSec = 0, videoId = '' } = data || {};
      if (!question.trim()) {
        sendResponse({ success: false, error: 'Empty question' });
        return;
      }
      if (!Array.isArray(segments) || segments.length === 0) {
        sendResponse({ success: false, error: 'No transcript available' });
        return;
      }
      if (!this.recapService) {
        await this.loadAPIKey();
        if (!this.recapService) {
          sendResponse({ success: false, error: 'API key not configured. Please set your API key in the extension popup.' });
          return;
        }
      }

      const stored = await chrome.storage.local.get(['advancedSettings']);
      const aiModel = (stored.advancedSettings && stored.advancedSettings.aiModel) || undefined;
      const baseLang = this.normalizeLang(lang);

      const transcript = Transcript.fromDOM(segments, videoId || 'q', '');
      const result = await this.recapService.answerQuestion(transcript, {
        question,
        targetLanguage: this.languageName(baseLang),
        aiModel,
        durationSec
      });

      sendResponse({ success: true, answer: result.answer, citations: result.citations });
    } catch (error) {
      logger.error('Q&A failed', { error: error.message });
      sendResponse({ success: false, error: error.message });
    }
  }

  async handleHealSelectors(data, sendResponse) {
    try {
      if (!this.recapService) {
        await this.loadAPIKey();
        if (!this.recapService) {
          sendResponse({ success: false, error: 'API key not configured' });
          return;
        }
      }
      const { snapshot, url } = data;
      const healed = await this.recapService.healSelectors(snapshot, url);
      sendResponse({ success: true, selectors: healed });
    } catch (error) {
      logger.error('Selector healing failed', { error: error.message });
      sendResponse({ success: false, error: error.message });
    }
  }

  async handleAPIKeyUpdate(data, sendResponse) {
    try {
      const { apiKey, provider } = data;
      const targetProvider = provider || CONFIG.AI_PROVIDERS.CLAUDE.NAME;

      if (!apiKey || apiKey.length < 20) {
        sendResponse({ success: false, error: 'Invalid API key' });
        return;
      }

      const storageKey = targetProvider === CONFIG.AI_PROVIDERS.OPENAI.NAME ? 'openaiApiKey' : 'claudeApiKey';
      await chrome.storage.local.set({ [storageKey]: apiKey });
      this.createRecapService(apiKey, targetProvider);
      sendResponse({ success: true });
    } catch (error) {
      logger.error('Failed to update API key', { error: error.message });
      sendResponse({ success: false, error: error.message });
    }
  }

  async handleProviderChange(data, sendResponse) {
    try {
      const { provider } = data;
      const validProviders = [CONFIG.AI_PROVIDERS.CLAUDE.NAME, CONFIG.AI_PROVIDERS.OPENAI.NAME];
      if (!validProviders.includes(provider)) {
        sendResponse({ success: false, error: 'Invalid provider' });
        return;
      }

      const result = await chrome.storage.local.get(['claudeApiKey', 'openaiApiKey']);
      const apiKey = provider === CONFIG.AI_PROVIDERS.OPENAI.NAME ? result.openaiApiKey : result.claudeApiKey;

      if (apiKey && apiKey.length >= 20) {
        this.createRecapService(apiKey, provider);
      } else {
        this.recapService = null;
      }
      sendResponse({ success: true });
    } catch (error) {
      logger.error('Failed to change provider', { error: error.message });
      sendResponse({ success: false, error: error.message });
    }
  }

  handleGetAPIKeyStatus(sendResponse) {
    const hasService = this.recapService !== null;
    chrome.storage.local.get(['claudeApiKey', 'openaiApiKey', 'apiKey', 'advancedSettings'], (result) => {
      const advancedSettings = result.advancedSettings || {};
      const selectedProvider = advancedSettings.aiProvider || CONFIG.AI_PROVIDERS.CLAUDE.NAME;
      const claudeConfigured = !!(result.claudeApiKey && result.claudeApiKey.length >= 20) ||
        !!(result.apiKey && result.apiKey.length >= 20);
      const openaiConfigured = !!(result.openaiApiKey && result.openaiApiKey.length >= 20);

      sendResponse({
        configured: selectedProvider === CONFIG.AI_PROVIDERS.OPENAI.NAME ? openaiConfigured : claudeConfigured,
        hasAIService: hasService,
        selectedProvider,
        availableKeys: { claude: claudeConfigured, openai: openaiConfigured }
      });
    });
  }

  /**
   * Clear recap cache: a specific video (all languages) or everything.
   * data: { videoId } | { all: true }
   */
  async handleClearRecapCache(data, sendResponse) {
    try {
      const all = await chrome.storage.local.get(null);
      const toRemove = Object.keys(all).filter(k => {
        if (!k.startsWith(RECAP_PREFIX)) return false;
        if (data && data.all) return true;
        if (data && data.videoId) return k.startsWith(`${RECAP_PREFIX}${data.videoId}_`);
        return false;
      });
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
      sendResponse({ success: true, removed: toRemove.length });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  }

  // ---- Recap cache helpers (chrome.storage.local, keyed recap_<videoId>_<lang>) ----
  async getCachedRecap(cacheKey) {
    try {
      const data = await chrome.storage.local.get(cacheKey);
      const entry = data[cacheKey];
      if (!entry || !entry.recap) return null;
      if (entry.createdAt && (Date.now() - entry.createdAt) > MAX_AGE_MS) {
        await chrome.storage.local.remove(cacheKey);
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  async setCachedRecap(cacheKey, entry) {
    try {
      await chrome.storage.local.set({ [cacheKey]: entry });
    } catch (error) {
      logger.warn('Failed to cache recap', { error: error.message });
    }
  }

  normalizeLang(lang) {
    if (!lang || typeof lang !== 'string') return 'en';
    return lang.toLowerCase().split('-')[0];
  }

  /** BCP-47 base code -> English language name for the AI prompt ('it' -> 'Italian'). */
  languageName(baseLang) {
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'language' });
      return dn.of(baseLang) || baseLang;
    } catch {
      return baseLang;
    }
  }

  schedulePeriodicMaintenance() {
    setInterval(() => this.performMaintenance(), 24 * 60 * 60 * 1000);
  }

  async performMaintenance() {
    try {
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter(k =>
        k.startsWith(RECAP_PREFIX) &&
        all[k] &&
        all[k].createdAt &&
        (Date.now() - all[k].createdAt) > MAX_AGE_MS
      );
      if (stale.length) await chrome.storage.local.remove(stale);
      logger.info('Maintenance completed', { removed: stale.length });
    } catch (error) {
      logger.error('Maintenance failed', { error: error.message });
    }
  }
}

// Initialize
const backgroundService = new BackgroundService();
backgroundService.setupMessageListeners();
backgroundService.schedulePeriodicMaintenance();

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed/updated', { reason: details.reason });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

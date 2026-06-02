// popup-main.js - RecapTube AI settings popup
import { CONFIG } from '../shared/config.js';
import { STORAGE_KEYS } from '../shared/constants.js';

const DEFAULT_MODEL = { claude: 'haiku', openai: 'gpt-5.4-mini' };

class PopupManager {
  constructor() {
    this.isLoading = true;
    this.settings = { ...CONFIG.DEFAULTS.SETTINGS };
    this.advanced = { ...CONFIG.DEFAULTS.ADVANCED_SETTINGS };
    this.init();
  }

  async init() {
    await this.loadTheme();
    await this.loadAll();
    this.bindEvents();
    setTimeout(() => { this.isLoading = false; }, 80);
  }

  $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- loading
  async loadAll() {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.SETTINGS, STORAGE_KEYS.ADVANCED_SETTINGS, 'claudeApiKey', 'openaiApiKey'
    ]);
    this.settings = { ...CONFIG.DEFAULTS.SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
    this.advanced = { ...CONFIG.DEFAULTS.ADVANCED_SETTINGS, ...(data[STORAGE_KEYS.ADVANCED_SETTINGS] || {}) };

    // Toggles
    this.$('enabled').checked = this.settings.enabled;
    this.$('autoGenerate').checked = this.settings.autoGenerate;
    this.$('generateSummary').checked = this.settings.generateSummary;
    this.$('generateChapters').checked = this.settings.generateChapters;
    this.$('showProgressMarkers').checked = this.settings.showProgressMarkers;
    this.$('autoOpenPanel').checked = this.settings.autoOpenPanel;
    this.$('summaryLength').value = this.settings.summaryLength;
    this.$('outputLanguage').value = this.settings.outputLanguage;

    // Provider / model
    this.$('provider').value = this.advanced.aiProvider;
    this.updateModelOptions(this.advanced.aiProvider, this.advanced.aiModel);
    this.updateProviderKeysUI(this.advanced.aiProvider);

    // Key status
    this.refreshKeyStatus(data);
    this.renderWhitelist();
  }

  async loadTheme() {
    const { darkMode } = await chrome.storage.local.get('darkMode');
    const dark = darkMode !== false; // default dark
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    this.$('theme-btn').textContent = dark ? '☀️' : '🌙';
  }

  refreshKeyStatus(data) {
    const setStatus = (el, ok) => {
      el.textContent = ok ? 'Configured' : 'Not configured';
      el.className = 'status ' + (ok ? 'ok' : 'err');
    };
    setStatus(this.$('claude-status'), !!(data.claudeApiKey && data.claudeApiKey.length >= 20));
    setStatus(this.$('openai-status'), !!(data.openaiApiKey && data.openaiApiKey.length >= 20));
  }

  updateModelOptions(provider, selected) {
    const select = this.$('model');
    let firstValid = null;
    Array.from(select.options).forEach(opt => {
      const match = opt.dataset.provider === provider;
      opt.hidden = !match;
      if (match && firstValid === null) firstValid = opt.value;
    });
    const validValues = Array.from(select.options).filter(o => o.dataset.provider === provider).map(o => o.value);
    select.value = validValues.includes(selected) ? selected : (firstValid || DEFAULT_MODEL[provider]);
    this.advanced.aiModel = select.value;
  }

  updateProviderKeysUI(provider) {
    this.$('claude-keys').classList.toggle('active', provider === 'claude');
    this.$('openai-keys').classList.toggle('active', provider === 'openai');
  }

  // ----------------------------------------------------------------- events
  bindEvents() {
    // Theme
    this.$('theme-btn').addEventListener('click', () => this.toggleTheme());

    // Feature toggles / selects -> settings
    const settingControls = [
      ['enabled', 'checkbox'], ['autoGenerate', 'checkbox'], ['generateSummary', 'checkbox'],
      ['generateChapters', 'checkbox'], ['showProgressMarkers', 'checkbox'], ['autoOpenPanel', 'checkbox'],
      ['summaryLength', 'value'], ['outputLanguage', 'value']
    ];
    settingControls.forEach(([id, kind]) => {
      this.$(id).addEventListener('change', () => {
        if (this.isLoading) return;
        this.settings[id] = kind === 'checkbox' ? this.$(id).checked : this.$(id).value;
        this.saveSettings();
      });
    });

    // Provider
    this.$('provider').addEventListener('change', async () => {
      if (this.isLoading) return;
      const provider = this.$('provider').value;
      this.advanced.aiProvider = provider;
      this.updateModelOptions(provider, this.advanced.aiModel);
      this.updateProviderKeysUI(provider);
      await this.saveAdvanced();
      await this.sendToBackground({ action: 'updateProvider', data: { provider } });
      this.toast('Provider updated');
    });

    // Model
    this.$('model').addEventListener('change', () => {
      if (this.isLoading) return;
      this.advanced.aiModel = this.$('model').value;
      this.saveAdvanced();
    });

    // API keys
    this.$('save-claude').addEventListener('click', () => this.saveKey('claude', 'claude-key', 'claude-status'));
    this.$('save-openai').addEventListener('click', () => this.saveKey('openai', 'openai-key', 'openai-status'));

    // Whitelist
    this.$('add-current').addEventListener('click', () => this.addCurrentChannel());

    // Cache
    this.$('regen').addEventListener('click', () => this.regenCurrent());
    this.$('clear-current').addEventListener('click', () => this.clearCurrent());
    this.$('clear-all').addEventListener('click', () => this.clearAll());
  }

  async toggleTheme() {
    const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    this.$('theme-btn').textContent = dark ? '☀️' : '🌙';
    await chrome.storage.local.set({ darkMode: dark });
  }

  // ------------------------------------------------------------------ saves
  async saveSettings() {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: this.settings });
    await this.sendToActiveTab({ action: 'updateSettings' });
  }

  async saveAdvanced() {
    await chrome.storage.local.set({ [STORAGE_KEYS.ADVANCED_SETTINGS]: this.advanced });
    await this.sendToActiveTab({ action: 'updateAdvancedSettings' });
  }

  async saveKey(provider, inputId, statusId) {
    const apiKey = this.$(inputId).value.trim();
    if (!apiKey || apiKey.length < 20) {
      this.toast('Enter a valid API key (≥20 chars)');
      return;
    }
    const res = await this.sendToBackground({ action: 'updateAPIKey', data: { provider, apiKey } });
    if (res && res.success) {
      const el = this.$(statusId);
      el.textContent = 'Configured';
      el.className = 'status ok';
      this.$(inputId).value = '';
      this.toast('API key saved');
    } else {
      this.toast((res && res.error) || 'Failed to save key');
    }
  }

  // -------------------------------------------------------------- whitelist
  renderWhitelist() {
    const list = this.advanced.channelWhitelist || [];
    const container = this.$('whitelist-list');
    container.innerHTML = list.length
      ? list.map((c, i) => `<div class="wl-item"><span>${this.escape(c)}</span><button data-i="${i}" title="Remove">×</button></div>`).join('')
      : '<div class="hint">No excluded channels.</div>';
    container.querySelectorAll('button[data-i]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        this.advanced.channelWhitelist.splice(i, 1);
        this.saveAdvanced();
        this.renderWhitelist();
      });
    });
  }

  async addCurrentChannel() {
    const tab = await this.getActiveTab();
    if (!tab) { this.toast('Open a YouTube video first'); return; }
    const res = await this.sendToTab(tab.id, { action: 'getCurrentChannel' });
    const ch = res && res.channel;
    const value = ch && (ch.handle || ch.name || ch.id);
    if (!value) { this.toast('Could not detect the channel'); return; }
    this.advanced.channelWhitelist = this.advanced.channelWhitelist || [];
    if (!this.advanced.channelWhitelist.some(c => c.toLowerCase() === value.toLowerCase())) {
      this.advanced.channelWhitelist.push(value);
      await this.saveAdvanced();
      this.renderWhitelist();
      this.toast(`Excluded ${value}`);
    } else {
      this.toast('Already excluded');
    }
  }

  // ------------------------------------------------------------------ cache
  async regenCurrent() {
    const tab = await this.getActiveTab();
    if (!tab) { this.toast('Open a YouTube video first'); return; }
    await this.sendToTab(tab.id, { action: 'manualRecap' });
    this.toast('Regenerating…');
  }

  async clearCurrent() {
    const tab = await this.getActiveTab();
    const videoId = this.parseVideoId(tab && tab.url);
    if (!videoId) { this.toast('Open a YouTube video first'); return; }
    await this.sendToBackground({ action: 'clearRecapCache', data: { videoId } });
    this.toast('Cleared this video');
  }

  async clearAll() {
    await this.sendToBackground({ action: 'clearRecapCache', data: { all: true } });
    this.toast('Cleared all recaps');
  }

  // ---------------------------------------------------------------- helpers
  getActiveTab() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs && tabs[0]));
    });
  }

  parseVideoId(url) {
    if (!url) return null;
    try { return new URL(url).searchParams.get('v'); } catch { return null; }
  }

  sendToBackground(message) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(message, res => {
        if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
        else resolve(res);
      });
    });
  }

  sendToTab(tabId, message) {
    return new Promise(resolve => {
      try {
        chrome.tabs.sendMessage(tabId, message, res => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch { resolve(null); }
    });
  }

  async sendToActiveTab(message) {
    const tab = await this.getActiveTab();
    if (tab && tab.id && tab.url && tab.url.includes('youtube.com')) {
      await this.sendToTab(tab.id, message);
    }
  }

  escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  toast(msg) {
    const t = this.$('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
}

document.addEventListener('DOMContentLoaded', () => new PopupManager());

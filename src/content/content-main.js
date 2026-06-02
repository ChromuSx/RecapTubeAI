// content-main.js - RecapTube AI content script (ISOLATED world)
//
// Orchestrates: video detection (SPA navigation), transcript extraction (reused 3-layer
// TranscriptService), native-chapter detection, the AI recap request to the background,
// and rendering of the in-page panel + progress-bar chapter markers.
import { TranscriptService } from '../shared/services/transcript-service.js';
import { CONFIG } from '../shared/config.js';
import {
  SELECTORS,
  CSS_CLASSES,
  CHAPTER_MARKER_COLORS,
  NOTIFICATION_TYPES,
  STORAGE_KEYS,
  INFO_MESSAGES,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES
} from '../shared/constants.js';
import { logger } from '../shared/logger/index.js';

class RecapManager {
  constructor() {
    this.logger = logger.child('RecapManager');
    this.transcriptService = new TranscriptService();

    this.currentVideoId = null;
    this.isProcessing = false;
    this.settings = { ...CONFIG.DEFAULTS.SETTINGS };
    this.advancedSettings = { ...CONFIG.DEFAULTS.ADVANCED_SETTINGS };
    this.lastRecap = null;

    this.init();
  }

  async init() {
    try {
      this.injectStyles();
      // Listen for MAIN-world interceptor transcripts as early as possible.
      this.transcriptService.setupInterceptorBridge();
      this.transcriptService.setNotifier((msg, type) => this.showToast(msg, type));

      await this.loadSettings();
      this.setupMessageListener();
      this.observeNavigation();

      this.logger.info('RecapTube content script ready');
    } catch (error) {
      this.logger.error('Init failed', { error: error.message });
    }
  }

  // ---------------------------------------------------------------- settings
  async loadSettings() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.ADVANCED_SETTINGS]);
      this.settings = { ...CONFIG.DEFAULTS.SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
      this.advancedSettings = { ...CONFIG.DEFAULTS.ADVANCED_SETTINGS, ...(data[STORAGE_KEYS.ADVANCED_SETTINGS] || {}) };
    } catch (error) {
      this.logger.warn('Could not load settings, using defaults', { error: error.message });
    }
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      (async () => {
        try {
          switch (message.action) {
            case 'updateSettings':
            case 'updateAdvancedSettings':
              await this.loadSettings();
              sendResponse({ success: true });
              break;
            case 'manualRecap':
              if (this.currentVideoId) {
                this.processVideo(this.currentVideoId, { force: true });
              }
              sendResponse({ success: true });
              break;
            case 'getCurrentChannel':
              sendResponse({ success: true, channel: this.getChannelInfo() });
              break;
            default:
              sendResponse({ success: false, error: 'Unknown action' });
          }
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    });
  }

  // -------------------------------------------------------------- navigation
  observeNavigation() {
    // YouTube fires this on every SPA navigation.
    window.addEventListener('yt-navigate-finish', () => this.onNavigate());
    // Fallback: observe the body for the video id changing.
    const observer = new MutationObserver(() => this.onNavigate());
    observer.observe(document.body, { childList: true, subtree: true });
    // Initial load.
    this.onNavigate();
  }

  onNavigate() {
    if (!this.isWatchPage()) {
      this.cleanup();
      this.currentVideoId = null;
      return;
    }
    const videoId = this.getVideoId();
    if (videoId && videoId !== this.currentVideoId) {
      this.currentVideoId = videoId;
      this.cleanup();
      // Small delay so the player/metadata settle after navigation.
      setTimeout(() => this.processVideo(videoId), CONFIG.VIDEO.INITIAL_LOAD_DELAY_MS);
    }
  }

  isWatchPage() {
    return location.pathname === '/watch' && !!this.getVideoId();
  }

  getVideoId() {
    try {
      return new URLSearchParams(location.search).get('v') || null;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------- main pipeline
  async processVideo(videoId, { force = false } = {}) {
    if (this.isProcessing) return;
    if (!this.settings.enabled) return;
    if (videoId !== this.getVideoId()) return; // navigated away during the delay

    // Channel whitelist
    if (this.isWhitelisted()) {
      this.showToast(INFO_MESSAGES.CHANNEL_WHITELISTED, NOTIFICATION_TYPES.INFO);
      return;
    }

    // Manual mode: don't spend an API call until the user asks for it.
    if (!force && this.settings.autoGenerate === false) {
      this.renderPanel({ state: 'idle' });
      return;
    }

    this.isProcessing = true;
    try {
      const hasNative = this.hasNativeChapters();
      const needChapters = this.settings.generateChapters && !hasNative;
      if (hasNative) this.logger.info(INFO_MESSAGES.NATIVE_CHAPTERS);

      if (this.settings.autoOpenPanel || force) {
        this.renderPanel({ state: 'loading', hasNative });
      }

      // Extract transcript (interceptor -> DOM -> AI self-heal, all reused).
      const channel = this.getChannelInfo();
      let transcript;
      try {
        transcript = await this.transcriptService.extractFromDOM(videoId, channel.id || '');
      } catch (err) {
        this.logger.warn('Transcript extraction failed', { error: err.message });
        this.renderPanel({ state: 'error', message: ERROR_MESSAGES.NO_TRANSCRIPT, hasNative });
        return;
      }

      if (!transcript || !transcript.segments || transcript.segments.length === 0) {
        this.renderPanel({ state: 'error', message: ERROR_MESSAGES.NO_TRANSCRIPT, hasNative });
        return;
      }

      // Keep the transcript around for the Q&A feature.
      this.lastTranscriptSegments = transcript.segments;

      this.showToast(
        INFO_MESSAGES.TRANSCRIPT_LOADING.replace('{count}', transcript.segments.length),
        NOTIFICATION_TYPES.INFO
      );

      const lang = this.resolveLang();
      const durationSec = this.getDurationSec();
      const title = this.getTitle();

      const response = await this.sendMessage({
        action: 'generateRecap',
        data: {
          videoId,
          segments: transcript.segments,
          title,
          durationSec,
          needChapters,
          summaryLength: this.settings.summaryLength,
          lang,
          force
        }
      });

      if (videoId !== this.getVideoId()) return; // navigated away while waiting

      if (!response || !response.success) {
        const msg = response && response.error ? response.error : ERROR_MESSAGES.RECAP_ERROR;
        this.renderPanel({ state: 'error', message: msg, hasNative });
        return;
      }

      this.lastRecap = response.recap;
      this.renderPanel({ state: 'ready', recap: response.recap, hasNative });

      const chapterCount = (response.recap.chapters || []).length;
      if (needChapters && chapterCount > 0 && this.settings.showProgressMarkers) {
        this.drawChapterMarkers(response.recap.chapters, durationSec);
      }

      this.showToast(
        chapterCount > 0
          ? SUCCESS_MESSAGES.RECAP_READY.replace('{count}', chapterCount)
          : SUCCESS_MESSAGES.RECAP_READY_NO_CHAPTERS,
        NOTIFICATION_TYPES.SUCCESS
      );
    } catch (error) {
      this.logger.error('processVideo failed', { error: error.message });
      this.renderPanel({ state: 'error', message: ERROR_MESSAGES.RECAP_ERROR });
    } finally {
      this.isProcessing = false;
    }
  }

  resolveLang() {
    const setting = this.settings.outputLanguage;
    if (!setting || setting === 'auto') {
      return navigator.language || 'en';
    }
    return setting;
  }

  // --------------------------------------------------------- native chapters
  hasNativeChapters() {
    try {
      const ticks = document.querySelectorAll(SELECTORS.PLAYER_CHAPTERS);
      if (ticks && ticks.length >= 2) return true;
      const panel = document.querySelector(SELECTORS.NATIVE_CHAPTERS_PANEL);
      if (panel && panel.querySelector(SELECTORS.NATIVE_CHAPTER_ITEM)) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Read the creator's chapters from the DOM (chapters engagement panel).
   * Returns [{ start, title }] sorted by start, or [] if not readable.
   */
  readNativeChapters() {
    try {
      const items = document.querySelectorAll(SELECTORS.NATIVE_CHAPTER_ITEM);
      const out = [];
      items.forEach((item) => {
        const titleEl = item.querySelector(SELECTORS.NATIVE_CHAPTER_TITLE) ||
          item.querySelector('h4') || item.querySelector('#details');
        const timeEl = item.querySelector(SELECTORS.NATIVE_CHAPTER_TIME) ||
          item.querySelector('#time');
        const title = titleEl ? (titleEl.textContent || '').trim() : '';
        const timeText = timeEl ? (timeEl.textContent || '').trim() : '';
        const start = this.parseTimeText(timeText);
        if (title && start !== null) out.push({ start, title });
      });
      // Dedupe + sort (DOM order is already chronological, but be safe).
      const seen = new Set();
      return out
        .sort((a, b) => a.start - b.start)
        .filter(c => { if (seen.has(c.start)) return false; seen.add(c.start); return true; });
    } catch {
      return [];
    }
  }

  /** Parse a "m:ss" / "h:mm:ss" chapter timestamp to seconds (null if invalid). */
  parseTimeText(t) {
    const s = (t || '').trim();
    if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(s)) return null;
    const parts = s.split(':').map(n => parseInt(n, 10));
    if (parts.some(n => isNaN(n))) return null;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }

  // ----------------------------------------------------------- page metadata
  getChannelInfo() {
    try {
      const a =
        document.querySelector('ytd-video-owner-renderer ytd-channel-name a') ||
        document.querySelector(SELECTORS.CHANNEL_NAME) ||
        document.querySelector('#channel-name a');
      if (!a) return { name: '', handle: '', id: '' };
      const href = a.getAttribute('href') || '';
      let handle = '';
      let id = '';
      if (href.includes('/@')) handle = '@' + href.split('/@')[1].split('/')[0];
      if (href.includes('/channel/')) id = href.split('/channel/')[1].split('/')[0];
      return { name: (a.textContent || '').trim(), handle, id };
    } catch {
      return { name: '', handle: '', id: '' };
    }
  }

  isWhitelisted() {
    const list = this.advancedSettings.channelWhitelist || [];
    if (!list.length) return false;
    const { name, handle, id } = this.getChannelInfo();
    const norm = (s) => (s || '').toLowerCase().trim();
    const set = list.map(norm);
    return [name, handle, id].some(v => v && set.includes(norm(v)));
  }

  getTitle() {
    const el = document.querySelector(SELECTORS.VIDEO_TITLE) || document.querySelector('h1.ytd-watch-metadata');
    return el ? (el.textContent || '').trim() : (document.title || '').replace(/ - YouTube$/, '');
  }

  getDurationSec() {
    const v = document.querySelector(SELECTORS.VIDEO);
    const d = v && v.duration;
    return Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
  }

  // ------------------------------------------------------------------- panel
  getPanelAnchor() {
    for (const sel of SELECTORS.PANEL_ANCHORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  ensurePanel() {
    let panel = document.querySelector('.' + CSS_CLASSES.PANEL);
    if (panel) return panel;

    const anchor = this.getPanelAnchor();
    if (!anchor) return null;

    panel = document.createElement('div');
    panel.className = CSS_CLASSES.PANEL;
    panel.innerHTML = `
      <div class="rt-head">
        <span class="rt-brand"><span class="rt-brand-mark">▶</span> RecapTube AI</span>
        <span class="rt-lang"></span>
        <span class="rt-head-actions">
          <button class="rt-btn rt-copy" title="Copy recap">⧉</button>
          <button class="rt-btn rt-regen" title="Regenerate">⟳</button>
          <button class="rt-btn rt-toggle" title="Collapse">▾</button>
        </span>
      </div>
      <div class="rt-body"></div>`;

    // Insert at the very top of the sidebar / chosen anchor.
    anchor.insertBefore(panel, anchor.firstChild);

    panel.querySelector('.rt-toggle').addEventListener('click', () => {
      panel.classList.toggle('rt-collapsed');
      const t = panel.querySelector('.rt-toggle');
      t.textContent = panel.classList.contains('rt-collapsed') ? '▸' : '▾';
    });
    panel.querySelector('.rt-regen').addEventListener('click', () => {
      if (this.currentVideoId) this.processVideo(this.currentVideoId, { force: true });
    });
    panel.querySelector('.rt-copy').addEventListener('click', (e) => this.copyRecap(e.currentTarget));

    return panel;
  }

  /** Format the current recap as clean plain text for the clipboard. */
  buildRecapText() {
    const r = this.lastRecap;
    if (!r) return '';
    const lines = [];
    const title = this.getTitle();
    if (title) lines.push(title, '');
    if (r.summary) { lines.push('SUMMARY', r.summary.trim(), ''); }
    if (Array.isArray(r.keyPoints) && r.keyPoints.length) {
      lines.push('KEY POINTS');
      r.keyPoints.forEach(p => {
        const text = typeof p === 'string' ? p : (p && p.text) || '';
        const start = typeof p === 'object' && p && Number.isFinite(p.start) ? p.start : null;
        lines.push('• ' + (start !== null ? `[${this.formatTime(start)}] ` : '') + text);
      });
      lines.push('');
    }
    if (Array.isArray(r.chapters) && r.chapters.length) {
      lines.push('CHAPTERS');
      r.chapters.forEach(c => lines.push(`${this.formatTime(c.start)}  ${c.title}`));
      lines.push('');
    }
    const url = (this.currentVideoId ? `https://www.youtube.com/watch?v=${this.currentVideoId}` : '');
    if (url) lines.push(url);
    return lines.join('\n').trim();
  }

  /** Copy the recap to the clipboard with brief button feedback. */
  async copyRecap(btn) {
    const text = this.buildRecapText();
    if (!text) { this.showToast('Nothing to copy yet', NOTIFICATION_TYPES.WARNING); return; }
    const ok = await this.writeClipboard(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = ok ? '✓' : '✕';
      btn.classList.toggle('rt-copied', ok);
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('rt-copied'); }, 1400);
    }
    this.showToast(ok ? 'Recap copied to clipboard' : 'Copy failed', ok ? NOTIFICATION_TYPES.SUCCESS : NOTIFICATION_TYPES.ERROR);
  }

  /** Clipboard write with a textarea fallback (navigator.clipboard can be blocked). */
  async writeClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  renderPanel({ state, recap, message, hasNative }) {
    const panel = this.ensurePanel();
    if (!panel) return;
    const body = panel.querySelector('.rt-body');
    const langEl = panel.querySelector('.rt-lang');
    const copyBtn = panel.querySelector('.rt-copy');

    // Copy button only makes sense once a recap is on screen.
    if (copyBtn) copyBtn.style.display = state === 'ready' ? '' : 'none';

    if (state === 'idle') {
      body.innerHTML = `<div class="rt-idle">
          <div class="rt-note">Manual mode is on.</div>
          <button class="rt-cta rt-generate">🧠 Generate recap</button>
        </div>`;
      body.querySelector('.rt-generate').addEventListener('click', () => {
        if (this.currentVideoId) this.processVideo(this.currentVideoId, { force: true });
      });
      return;
    }

    if (state === 'loading') {
      body.innerHTML = `<div class="rt-loading"><span class="rt-spinner"></span> ${INFO_MESSAGES.GENERATING}</div>`;
      return;
    }

    if (state === 'error') {
      body.innerHTML = `<div class="rt-error">${this.escape(message || ERROR_MESSAGES.RECAP_ERROR)}</div>
        <button class="rt-btn rt-retry">Retry</button>`;
      body.querySelector('.rt-retry').addEventListener('click', () => {
        if (this.currentVideoId) this.processVideo(this.currentVideoId, { force: true });
      });
      return;
    }

    // state === 'ready'
    if (recap && recap.language) langEl.textContent = String(recap.language).toUpperCase();

    const summaryHtml = recap && recap.summary
      ? `<div class="rt-section">
           <div class="rt-section-title">Summary</div>
           <div class="rt-summary">${this.escape(recap.summary)}</div>
           ${(recap.keyPoints && recap.keyPoints.length)
             ? `<ul class="rt-keypoints">${recap.keyPoints.map(p => this.keyPointRow(p)).join('')}</ul>`
             : ''}
         </div>`
      : '';

    let chaptersHtml = '';
    const chapters = (recap && recap.chapters) || [];
    if (chapters.length > 0) {
      chaptersHtml = `<div class="rt-section">
          <div class="rt-section-title">Chapters <span class="rt-badge-ai">AI</span></div>
          <div class="rt-chapters">${chapters.map((c, i) => this.chapterRow(c, i)).join('')}</div>
        </div>`;
    } else if (hasNative) {
      // The video has creator chapters: list them (read from the DOM) instead of
      // just noting their existence. The chapters panel may not be in the DOM yet,
      // so we render what we have now and refresh asynchronously below.
      chaptersHtml = `<div class="rt-section rt-chapters-section">${this.nativeChaptersInner(this.readNativeChapters())}</div>`;
    } else {
      // needChapters was true but the AI returned none (or all were invalid).
      chaptersHtml = `<div class="rt-section">
          <div class="rt-section-title">Chapters</div>
          <div class="rt-note">No chapters were generated for this video. Try <button class="rt-btn rt-regen-inline" style="padding:2px 6px;border:1px solid currentColor;border-radius:6px;cursor:pointer;background:transparent;color:inherit;">regenerating</button>.</div>
        </div>`;
    }

    const qaHtml = (this.lastTranscriptSegments && this.lastTranscriptSegments.length)
      ? `<div class="rt-section rt-qa">
           <div class="rt-section-title">Ask the video</div>
           <div class="rt-qa-row">
             <input class="rt-qa-input" type="text" placeholder="Ask anything about this video…" />
             <button class="rt-qa-send" title="Ask">➤</button>
           </div>
           <div class="rt-qa-answer" style="display:none;"></div>
         </div>`
      : '';

    const transcriptHtml = (this.lastTranscriptSegments && this.lastTranscriptSegments.length)
      ? `<div class="rt-section rt-transcript">
           <div class="rt-section-title">
             Transcript
             <button class="rt-btn rt-tr-toggle" style="margin-left:auto;font-size:12px;">Show ▾</button>
           </div>
           <div class="rt-tr-body" style="display:none;"></div>
         </div>`
      : '';

    body.innerHTML = summaryHtml + chaptersHtml + qaHtml + transcriptHtml;

    const regenInline = body.querySelector('.rt-regen-inline');
    if (regenInline) {
      regenInline.addEventListener('click', () => {
        if (this.currentVideoId) this.processVideo(this.currentVideoId, { force: true });
      });
    }

    // Q&A wiring
    const qaInput = body.querySelector('.rt-qa-input');
    const qaSend = body.querySelector('.rt-qa-send');
    if (qaInput && qaSend) {
      const submit = () => this.askQuestion(qaInput.value, body);
      qaSend.addEventListener('click', submit);
      qaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }

    // Transcript toggle wiring (lazy translate on first open)
    const trToggle = body.querySelector('.rt-tr-toggle');
    if (trToggle) {
      trToggle.addEventListener('click', () => this.toggleTranscript(body));
    }

    this.wireChapterClicks(body);

    // Native chapters may not be in the DOM yet at first render; refresh the
    // section once the chapters panel loads.
    if (hasNative && (chapters.length === 0)) {
      this.refreshNativeChapters(body);
    }
  }

  wireChapterClicks(scope) {
    scope.querySelectorAll('.rt-chapter, .rt-kp-jump').forEach(el => {
      if (el.dataset.rtWired === '1') return;
      el.dataset.rtWired = '1';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.seekTo(Number(el.dataset.start));
      });
    });
  }

  /** Inner HTML for the native-chapters section (list if readable, else note). */
  nativeChaptersInner(native) {
    if (native && native.length > 0) {
      return `<div class="rt-section-title">Chapters <span class="rt-badge-creator">Creator</span></div>
          <div class="rt-chapters">${native.map((c, i) => this.chapterRow(c, i)).join('')}</div>`;
    }
    return `<div class="rt-section-title">Chapters</div>
        <div class="rt-note">📑 This video already has chapters from the creator.</div>`;
  }

  /** Poll briefly for the creator chapters panel, then populate the section. */
  refreshNativeChapters(body, attempt = 0) {
    const section = body.querySelector('.rt-chapters-section');
    if (!section) return;
    const native = this.readNativeChapters();
    if (native.length > 0) {
      section.innerHTML = this.nativeChaptersInner(native);
      this.wireChapterClicks(section);
      return;
    }
    if (attempt < 6) {
      setTimeout(() => this.refreshNativeChapters(body, attempt + 1), 700);
    }
  }

  chapterRow(c, i) {
    const color = CHAPTER_MARKER_COLORS[i % CHAPTER_MARKER_COLORS.length];
    return `<div class="rt-chapter" data-start="${c.start}" title="Jump to ${this.formatTime(c.start)}">
        <span class="rt-dot" style="background:${color}"></span>
        <span class="rt-time">${this.formatTime(c.start)}</span>
        <span class="rt-ch-title">${this.escape(c.title)}</span>
      </div>`;
  }

  keyPointRow(p) {
    // Back-compat: p may be a plain string (old cache) or { text, start }.
    const text = typeof p === 'string' ? p : (p && p.text) || '';
    const start = typeof p === 'object' && p && Number.isFinite(p.start) ? p.start : null;
    const chip = start !== null
      ? `<button class="rt-kp-jump" data-start="${start}" title="Jump to ${this.formatTime(start)}">${this.formatTime(start)}</button> `
      : '';
    return `<li>${chip}<span class="rt-kp-text">${this.escape(text)}</span></li>`;
  }

  // ---------------------------------------------------------------- Q&A
  async askQuestion(question, body) {
    const q = (question || '').trim();
    const answerEl = body.querySelector('.rt-qa-answer');
    if (!answerEl) return;
    if (!q) { answerEl.style.display = 'none'; return; }
    if (!this.lastTranscriptSegments || !this.lastTranscriptSegments.length) {
      answerEl.style.display = 'block';
      answerEl.innerHTML = `<div class="rt-error">No transcript available for this video.</div>`;
      return;
    }

    answerEl.style.display = 'block';
    answerEl.innerHTML = `<div class="rt-loading"><span class="rt-spinner"></span> Thinking…</div>`;

    const response = await this.sendMessage({
      action: 'answerQuestion',
      data: {
        videoId: this.currentVideoId,
        segments: this.lastTranscriptSegments,
        question: q,
        lang: this.resolveLang(),
        durationSec: this.getDurationSec()
      }
    });

    if (!response || !response.success) {
      answerEl.innerHTML = `<div class="rt-error">${this.escape((response && response.error) || 'Could not answer')}</div>`;
      return;
    }
    this.renderAnswer(answerEl, response.answer, response.citations || []);
  }

  renderAnswer(answerEl, answer, citations) {
    const cites = (citations || [])
      .map(c => `<button class="rt-kp-jump" data-start="${c.start}" title="Jump to ${this.formatTime(c.start)}">${this.formatTime(c.start)}${c.label ? ' · ' + this.escape(c.label) : ''}</button>`)
      .join(' ');
    answerEl.innerHTML =
      `<div class="rt-qa-text">${this.escape(answer || '')}</div>` +
      (cites ? `<div class="rt-qa-cites">${cites}</div>` : '');
    answerEl.querySelectorAll('.rt-kp-jump').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); this.seekTo(Number(el.dataset.start)); });
    });
  }

  // ------------------------------------------------------- translated transcript
  async toggleTranscript(body) {
    const toggle = body.querySelector('.rt-tr-toggle');
    const trBody = body.querySelector('.rt-tr-body');
    if (!toggle || !trBody) return;

    const isOpen = trBody.style.display !== 'none';
    if (isOpen) {
      trBody.style.display = 'none';
      toggle.textContent = 'Show ▾';
      return;
    }

    trBody.style.display = 'block';
    toggle.textContent = 'Hide ▴';

    // Render only once.
    if (trBody.dataset.loaded === '1') return;

    if (!this.lastTranscriptSegments || !this.lastTranscriptSegments.length) {
      trBody.innerHTML = `<div class="rt-error">No transcript available.</div>`;
      return;
    }

    trBody.innerHTML = `<div class="rt-loading"><span class="rt-spinner"></span> Translating transcript…</div>`;

    const response = await this.sendMessage({
      action: 'translateTranscript',
      data: {
        videoId: this.currentVideoId,
        segments: this.lastTranscriptSegments,
        lang: this.resolveLang()
      }
    });

    if (!response || !response.success || !Array.isArray(response.lines)) {
      trBody.innerHTML = `<div class="rt-error">${this.escape((response && response.error) || 'Translation failed')}</div>`;
      return;
    }

    this.renderTranscript(trBody, response.lines);
    trBody.dataset.loaded = '1';
  }

  renderTranscript(trBody, lines) {
    const rows = lines.map(l => {
      const t = Math.max(0, Math.floor(Number(l.time) || 0));
      return `<div class="rt-tr-line" data-start="${t}">
          <span class="rt-time">${this.formatTime(t)}</span>
          <span class="rt-tr-text">${this.escape(l.text || '')}</span>
        </div>`;
    }).join('');
    trBody.innerHTML = rows;
    trBody.querySelectorAll('.rt-tr-line').forEach(row => {
      row.addEventListener('click', () => this.seekTo(Number(row.dataset.start)));
    });
  }

  // ---------------------------------------------------- progress-bar segments
  // Draw real chapter segments on the progress bar (YouTube-native style): one
  // colored band per chapter, separated by small gaps. The overlay does NOT
  // capture pointer events, so native scrubbing/seeking keeps working; we read
  // the cursor position to show a per-chapter tooltip and to seek on click.
  drawChapterMarkers(chapters, durationSec) {
    this.clearMarkers();
    const duration = durationSec || this.getDurationSec();
    if (!duration || !chapters || chapters.length === 0) return;

    const bar = document.querySelector(SELECTORS.PROGRESS_BAR);
    if (!bar) {
      // Player not ready yet; retry shortly (cap retries so we don't loop forever).
      this._markerRetries = (this._markerRetries || 0) + 1;
      if (this._markerRetries <= 8) {
        setTimeout(() => {
          if (this.currentVideoId) this.drawChapterMarkers(chapters, duration);
        }, 1200);
      }
      return;
    }
    this._markerRetries = 0;

    // Build [start, end) ranges from chapter starts, clamped to the duration.
    const ranges = chapters
      .map((c, i) => ({
        start: Math.min(duration, Math.max(0, Number(c.start) || 0)),
        end: i + 1 < chapters.length ? Math.min(duration, Number(chapters[i + 1].start) || duration) : duration,
        title: c.title,
        color: CHAPTER_MARKER_COLORS[i % CHAPTER_MARKER_COLORS.length]
      }))
      .filter(r => r.end > r.start);

    const track = document.createElement('div');
    track.className = CSS_CLASSES.CHAPTER_TRACK;
    // Overlay exactly over the progress bar; transparent to pointer events.
    track.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;z-index:32;pointer-events:none;';

    ranges.forEach((r) => {
      const leftPct = (r.start / duration) * 100;
      const widthPct = ((r.end - r.start) / duration) * 100;
      const seg = document.createElement('div');
      seg.className = CSS_CLASSES.CHAPTER_SEG;
      seg.style.cssText =
        `position:absolute;left:${leftPct}%;width:${widthPct}%;top:0;height:100%;` +
        `--rt-seg-color:${r.color};`;
      seg.dataset.start = String(r.start);
      seg.dataset.title = r.title || '';
      track.appendChild(seg);
    });

    bar.appendChild(track);
    this._chapterRanges = ranges;
    this._chapterTrack = track;
    this.attachProgressBarInteractions(bar, duration);
  }

  // Hover tooltip + click-to-seek, computed from cursor X over the progress bar.
  // Listeners live on the bar itself (which already receives pointer events).
  attachProgressBarInteractions(bar, duration) {
    this.detachProgressBarInteractions();
    const tooltip = document.createElement('div');
    tooltip.className = CSS_CLASSES.TOOLTIP;
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);
    this._chapterTooltip = tooltip;

    const ratioAt = (clientX) => {
      const rect = bar.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    };
    const chapterAt = (sec) => {
      const ranges = this._chapterRanges || [];
      return ranges.find(r => sec >= r.start && sec < r.end) || ranges[ranges.length - 1] || null;
    };

    const onMove = (e) => {
      const ranges = this._chapterRanges || [];
      if (!ranges.length) return;
      const sec = ratioAt(e.clientX) * duration;
      const ch = chapterAt(sec);
      if (!ch) { tooltip.style.display = 'none'; return; }
      // Lift the hovered segment.
      if (this._chapterTrack) {
        this._chapterTrack.querySelectorAll('.' + CSS_CLASSES.CHAPTER_SEG).forEach((s) => {
          s.classList.toggle('rt-seg-hover', Number(s.dataset.start) === ch.start);
        });
      }
      tooltip.textContent = ch.title || '';
      if (ch.title) {
        tooltip.style.display = 'block';
        tooltip.style.left = e.clientX + 'px';
        const barRect = bar.getBoundingClientRect();
        tooltip.style.top = (barRect.top - 34) + 'px';
      } else {
        tooltip.style.display = 'none';
      }
    };
    const onLeave = () => {
      tooltip.style.display = 'none';
      if (this._chapterTrack) {
        this._chapterTrack.querySelectorAll('.rt-seg-hover').forEach((s) => s.classList.remove('rt-seg-hover'));
      }
    };

    bar.addEventListener('mousemove', onMove);
    bar.addEventListener('mouseleave', onLeave);
    this._barListeners = { bar, onMove, onLeave };
  }

  detachProgressBarInteractions() {
    if (this._barListeners) {
      const { bar, onMove, onLeave } = this._barListeners;
      bar.removeEventListener('mousemove', onMove);
      bar.removeEventListener('mouseleave', onLeave);
      this._barListeners = null;
    }
    if (this._chapterTooltip) {
      this._chapterTooltip.remove();
      this._chapterTooltip = null;
    }
  }

  clearMarkers() {
    this.detachProgressBarInteractions();
    document.querySelectorAll('.' + CSS_CLASSES.CHAPTER_MARKER).forEach(m => m.remove());
    document.querySelectorAll('.' + CSS_CLASSES.CHAPTER_TRACK).forEach(t => t.remove());
    document.querySelectorAll('.' + CSS_CLASSES.TOOLTIP).forEach(t => t.remove());
    this._chapterRanges = null;
    this._chapterTrack = null;
  }

  seekTo(seconds) {
    const v = document.querySelector(SELECTORS.VIDEO);
    if (v && Number.isFinite(seconds)) {
      v.currentTime = seconds;
      if (v.paused && typeof v.play === 'function') v.play().catch(() => {});
    }
  }

  // --------------------------------------------------------------- teardown
  cleanup() {
    document.querySelectorAll('.' + CSS_CLASSES.PANEL).forEach(p => p.remove());
    this.clearMarkers();
    document.querySelectorAll('.' + CSS_CLASSES.TOOLTIP).forEach(t => t.remove());
    this.lastRecap = null;
    this.lastTranscriptSegments = null;
  }

  // --------------------------------------------------------------- messaging
  sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      } catch (error) {
        resolve({ success: false, error: error.message });
      }
    });
  }

  // ------------------------------------------------------------------ toasts
  showToast(message, type = NOTIFICATION_TYPES.INFO) {
    try {
      const toast = document.createElement('div');
      toast.className = CSS_CLASSES.NOTIFICATION + ' rt-' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, CONFIG.UI.TOAST_DURATION_MS);
    } catch {
      /* noop */
    }
  }

  // -------------------------------------------------------------- utilities
  formatTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ----------------------------------------------------------------- styles
  injectStyles() {
    if (document.getElementById(CSS_CLASSES.STYLE_TAG)) return;
    const style = document.createElement('style');
    style.id = CSS_CLASSES.STYLE_TAG;
    style.textContent = `
.${CSS_CLASSES.PANEL}{
  font-family:"Roboto","Segoe UI",Arial,sans-serif;
  background:#fff;color:#0f0f0f;border:1px solid #e5e5e5;border-radius:12px;
  margin:0 0 16px 0;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);
}
html[dark] .${CSS_CLASSES.PANEL}{background:#212121;color:#f1f1f1;border-color:#3a3a3a;}
.${CSS_CLASSES.PANEL} .rt-head{
  display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-bottom:1px solid #ececec;background:#fafafa;
}
html[dark] .${CSS_CLASSES.PANEL} .rt-head{background:#181818;border-color:#333;}
.${CSS_CLASSES.PANEL} .rt-brand{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;}
.${CSS_CLASSES.PANEL} .rt-brand-mark{color:#ff0033;}
.${CSS_CLASSES.PANEL} .rt-lang{margin-left:auto;font-size:11px;opacity:.6;letter-spacing:.04em;}
.${CSS_CLASSES.PANEL} .rt-head-actions{display:flex;gap:4px;}
.${CSS_CLASSES.PANEL} .rt-btn{
  cursor:pointer;border:none;background:transparent;color:inherit;font-size:14px;
  border-radius:6px;padding:4px 8px;line-height:1;
}
.${CSS_CLASSES.PANEL} .rt-btn:hover{background:rgba(127,127,127,.18);}
.${CSS_CLASSES.PANEL} .rt-btn.rt-copied{color:#27ae60;}
.${CSS_CLASSES.PANEL} .rt-body{padding:12px;max-height:60vh;overflow-y:auto;font-size:13px;line-height:1.5;}
.${CSS_CLASSES.PANEL}.rt-collapsed .rt-body{display:none;}
.${CSS_CLASSES.PANEL} .rt-section + .rt-section{margin-top:14px;}
.${CSS_CLASSES.PANEL} .rt-section-title{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin-bottom:6px;display:flex;align-items:center;gap:6px;}
.${CSS_CLASSES.PANEL} .rt-badge-ai{background:#3ea6ff;color:#fff;font-size:9px;padding:1px 5px;border-radius:8px;letter-spacing:.05em;}
.${CSS_CLASSES.PANEL} .rt-badge-creator{background:#27ae60;color:#fff;font-size:9px;padding:1px 5px;border-radius:8px;letter-spacing:.05em;}
.${CSS_CLASSES.PANEL} .rt-summary{white-space:pre-wrap;}
.${CSS_CLASSES.PANEL} .rt-keypoints{margin:8px 0 0;padding-left:18px;}
.${CSS_CLASSES.PANEL} .rt-keypoints li{margin:4px 0;}
.${CSS_CLASSES.PANEL} .rt-kp-jump{
  display:inline-block;font-variant-numeric:tabular-nums;font-size:11px;font-weight:600;
  color:#3ea6ff;background:rgba(62,166,255,.12);border:none;border-radius:5px;
  padding:1px 6px;margin-right:2px;cursor:pointer;vertical-align:baseline;
}
.${CSS_CLASSES.PANEL} .rt-kp-jump:hover{background:rgba(62,166,255,.25);}
.${CSS_CLASSES.PANEL} .rt-qa-row{display:flex;gap:6px;}
.${CSS_CLASSES.PANEL} .rt-qa-input{
  flex:1;background:rgba(127,127,127,.10);color:inherit;border:1px solid rgba(127,127,127,.3);
  border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit;
}
.${CSS_CLASSES.PANEL} .rt-qa-input:focus{outline:none;border-color:#3ea6ff;}
.${CSS_CLASSES.PANEL} .rt-qa-send{
  background:#3ea6ff;color:#fff;border:none;border-radius:8px;padding:0 12px;cursor:pointer;font-size:14px;
}
.${CSS_CLASSES.PANEL} .rt-qa-send:hover{filter:brightness(1.05);}
.${CSS_CLASSES.PANEL} .rt-qa-answer{margin-top:8px;font-size:13px;line-height:1.5;}
.${CSS_CLASSES.PANEL} .rt-qa-text{white-space:pre-wrap;}
.${CSS_CLASSES.PANEL} .rt-qa-cites{margin-top:6px;display:flex;flex-wrap:wrap;gap:5px;}
.${CSS_CLASSES.PANEL} .rt-tr-body{max-height:300px;overflow-y:auto;margin-top:6px;}
.${CSS_CLASSES.PANEL} .rt-tr-line{display:flex;gap:8px;padding:3px 6px;border-radius:6px;cursor:pointer;align-items:baseline;}
.${CSS_CLASSES.PANEL} .rt-tr-line:hover{background:rgba(127,127,127,.14);}
.${CSS_CLASSES.PANEL} .rt-tr-text{flex:1;}
.${CSS_CLASSES.PANEL} .rt-note{opacity:.75;font-style:italic;}
.${CSS_CLASSES.PANEL} .rt-chapter{
  display:flex;align-items:baseline;gap:8px;padding:5px 6px;border-radius:8px;cursor:pointer;
}
.${CSS_CLASSES.PANEL} .rt-chapter:hover{background:rgba(127,127,127,.14);}
.${CSS_CLASSES.PANEL} .rt-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;align-self:center;}
.${CSS_CLASSES.PANEL} .rt-time{font-variant-numeric:tabular-nums;color:#3ea6ff;font-size:12px;flex:0 0 auto;}
.${CSS_CLASSES.PANEL} .rt-ch-title{flex:1;}
.${CSS_CLASSES.PANEL} .rt-loading{display:flex;align-items:center;gap:10px;opacity:.85;padding:6px 0;}
.${CSS_CLASSES.PANEL} .rt-spinner{width:16px;height:16px;border:2px solid rgba(127,127,127,.3);border-top-color:#3ea6ff;border-radius:50%;animation:rt-spin .8s linear infinite;}
.${CSS_CLASSES.PANEL} .rt-error{color:#e74c3c;margin-bottom:8px;}
.${CSS_CLASSES.PANEL} .rt-retry{border:1px solid #3ea6ff;color:#3ea6ff;border-radius:8px;padding:5px 12px;background:transparent;cursor:pointer;}
.${CSS_CLASSES.PANEL} .rt-idle{display:flex;flex-direction:column;gap:10px;align-items:flex-start;padding:6px 0;}
.${CSS_CLASSES.PANEL} .rt-cta{background:#3ea6ff;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;}
.${CSS_CLASSES.PANEL} .rt-cta:hover{filter:brightness(1.05);}
@keyframes rt-spin{to{transform:rotate(360deg);}}
.${CSS_CLASSES.NOTIFICATION}{
  position:fixed;top:70px;right:20px;z-index:100000;max-width:340px;
  padding:11px 15px;border-radius:10px;color:#fff;font-family:"Roboto",Arial,sans-serif;font-size:13px;
  box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .3s;
}
.${CSS_CLASSES.NOTIFICATION}.rt-info{background:#3ea6ff;}
.${CSS_CLASSES.NOTIFICATION}.rt-success{background:#27ae60;}
.${CSS_CLASSES.NOTIFICATION}.rt-warning{background:#f39c12;}
.${CSS_CLASSES.NOTIFICATION}.rt-error{background:#e74c3c;}
/* Chapter segments overlaid on the progress bar (YouTube-native feel) */
.${CSS_CLASSES.CHAPTER_TRACK}{}
.${CSS_CLASSES.CHAPTER_SEG}{
  box-sizing:border-box;
  background:var(--rt-seg-color,#3ea6ff);
  opacity:.55;
  border-right:2px solid rgba(0,0,0,.65);
  transition:opacity .12s ease, transform .12s ease;
  transform-origin:center bottom;
}
.${CSS_CLASSES.CHAPTER_SEG}:last-child{border-right:none;}
.${CSS_CLASSES.CHAPTER_SEG}.rt-seg-hover{opacity:.9;transform:scaleY(1.7);}
.${CSS_CLASSES.TOOLTIP}{
  position:fixed;z-index:100001;pointer-events:none;
  transform:translateX(-50%);
  background:rgba(0,0,0,.88);color:#fff;
  font-family:"Roboto",Arial,sans-serif;font-size:12px;font-weight:500;
  padding:5px 9px;border-radius:6px;max-width:320px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.4);
}
`;
    (document.head || document.documentElement).appendChild(style);
  }
}

// Boot
if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-new
  new RecapManager();
}

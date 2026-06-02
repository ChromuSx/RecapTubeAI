// recap-service.js - AI orchestration for RecapTube (provider-agnostic)
//
// One AI call produces: a summary written directly in the target language (so translation
// is implicit), key points, and topic chapters with timestamps. Reuses the same pluggable
// provider abstraction as the analysis layer (createPayload -> sendRequest -> parseResponse).
import { CONFIG } from '../config.js';
import { createProvider } from './providers/index.js';
import { logger } from '../logger/index.js';

export class RecapService {
  constructor(apiKey, providerName = null) {
    this.apiKey = apiKey;
    this.providerName = providerName || CONFIG.AI_PROVIDERS.CLAUDE.NAME;
    const pc = CONFIG.AI_PROVIDERS[this.providerName.toUpperCase()] || CONFIG.AI_PROVIDERS.CLAUDE;
    this.provider = createProvider(this.providerName, apiKey, {
      baseUrl: pc.ENDPOINT,
      timeout: pc.TIMEOUT,
      version: pc.VERSION
    });
    this.logger = logger.child('RecapService');
  }

  /**
   * Generate a recap (summary + key points + chapters) from a transcript.
   * @param {Transcript} transcript - Transcript model (has formatForAI())
   * @param {Object} opts
   * @param {string} opts.targetLanguage - Human-readable language name for the AI ("Italian", "English"...)
   * @param {boolean} opts.needChapters - false when the video already has native chapters
   * @param {string} opts.summaryLength - 'short' | 'medium' | 'long'
   * @param {string} opts.aiModel - provider model key (e.g. 'haiku', 'gpt-5.4-mini')
   * @param {number} opts.durationSec - video duration (to clamp chapter timestamps)
   * @param {string} opts.title - video title (extra context)
   * @returns {Promise<{language:string, summary:string, keyPoints:string[], chapters:Array<{start:number,title:string}>}>}
   */
  async generateRecap(transcript, opts = {}) {
    const stopTimer = this.logger.time('generateRecap');
    const {
      targetLanguage = 'English',
      needChapters = true,
      summaryLength = 'medium',
      aiModel,
      durationSec = 0,
      title = ''
    } = opts;

    try {
      const formatted = transcript.formatForAI();
      const systemPrompt = this.buildSystemPrompt({ targetLanguage, needChapters, summaryLength });
      const userMessage = this.buildUserMessage(formatted, title);

      const payload = this.provider.createPayload(systemPrompt, userMessage, aiModel);

      this.logger.info('Requesting recap from AI', {
        provider: this.providerName,
        model: aiModel || 'default',
        targetLanguage,
        needChapters
      });

      const response = await this.provider.sendRequest(payload);
      const parsed = this.provider.parseResponse(response) || {};

      const rawChapterCount = Array.isArray(parsed.chapters) ? parsed.chapters.length : 0;
      const normalizedChapters = needChapters ? this.normalizeChapters(parsed.chapters, durationSec) : [];

      // Diagnostic: surfaces the case where the model returned chapters but they
      // were all dropped (e.g. unexpected timestamp format) vs. returned none.
      if (needChapters && rawChapterCount > 0 && normalizedChapters.length === 0) {
        this.logger.warn('All AI chapters were dropped during normalization', {
          rawChapterCount,
          sample: JSON.stringify(parsed.chapters.slice(0, 3))
        });
      }

      const result = {
        language: typeof parsed.language === 'string' ? parsed.language : targetLanguage,
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
        keyPoints: this.normalizeKeyPoints(parsed.keyPoints, durationSec),
        chapters: normalizedChapters
      };

      this.logger.info('Recap ready', {
        summaryChars: result.summary.length,
        keyPoints: result.keyPoints.length,
        chapters: result.chapters.length
      });
      stopTimer();
      return result;
    } catch (error) {
      stopTimer();
      this.logger.error('Recap generation failed', { error: error.message });
      throw error;
    }
  }

  buildSystemPrompt({ targetLanguage, needChapters, summaryLength }) {
    const lengthGuide = {
      short: '2-3 sentences and 3-4 key points',
      medium: '1-2 short paragraphs and 4-6 key points',
      long: '3-4 paragraphs and 6-10 key points'
    }[summaryLength] || '1-2 short paragraphs and 4-6 key points';

    const chaptersRule = needChapters
      ? `- "chapters": an ordered list of topic chapters covering the whole video. Each chapter is { "start": <integer number of SECONDS, NOT a "mm:ss" string>, "title": "<3-7 word title in ${targetLanguage}>" }. "start" MUST be a plain integer like 0, 95, 240 — never a string, never "1:35". The first chapter MUST have "start": 0. Create a new chapter only when the topic clearly changes (aim for one every 1-5 minutes; typically 4-15 chapters total). Read the "start" values from the [Ns] timestamps in the transcript (N is already in seconds).`
      : `- "chapters": MUST be an empty array []. This video already has chapters, so do not generate any.`;

    return `You are an expert at summarizing YouTube videos from their transcript.

Write ALL human-readable output (the summary, key points and chapter titles) in ${targetLanguage}, regardless of the transcript's original language. Translate naturally; never copy the source language if it differs.

Produce a JSON object with these fields:
- "language": the BCP-47 code of ${targetLanguage} (e.g. "it", "en").
- "summary": a faithful, neutral summary of what the video covers (${lengthGuide.split(' and ')[0]}). No marketing tone, no "in this video"; just the substance.
- "keyPoints": an array of the most important takeaways (${lengthGuide.split(' and ')[1] || 'key points'}). Each item is an object { "text": "<one concise sentence in ${targetLanguage}>", "start": <integer SECONDS where this point is discussed> }. Take "start" from the nearest [Ns] timestamp in the transcript; it MUST be a plain integer (e.g. 0, 73, 240), never a "mm:ss" string.
${chaptersRule}

RULES:
1. Base everything strictly on the transcript. Do not invent facts.
2. Output VALID JSON only — no markdown, no commentary outside the JSON.
3. Keep chapter "start" values within the video length and strictly increasing.

Output format (every "start" is an integer count of seconds):
{
  "language": "<bcp-47>",
  "summary": "<text in ${targetLanguage}>",
  "keyPoints": [ { "text": "<point>", "start": 0 }, { "text": "<point>", "start": 73 } ],
  "chapters": [ { "start": 0, "title": "<title>" }, { "start": 142, "title": "<title>" } ]
}`;
  }

  buildUserMessage(formattedTranscript, title) {
    const head = title ? `Video title: ${title}\n\n` : '';
    return `${head}Transcript (each line is "[<seconds>s] text"):\n\n${formattedTranscript}\n\nSummarize and (if requested) split into chapters. Respond with JSON only.`;
  }

  /**
   * Normalize key points to a list of { text, start } objects. Accepts both the
   * new object shape { text, start } and legacy plain strings (older cached
   * recaps), in which case `start` is null (rendered without a jump chip).
   */
  normalizeKeyPoints(rawPoints, durationSec) {
    if (!Array.isArray(rawPoints)) return [];
    const max = durationSec && durationSec > 0 ? Math.floor(durationSec) : Infinity;
    return rawPoints
      .map(p => {
        if (typeof p === 'string') {
          return p.trim() ? { text: p.trim(), start: null } : null;
        }
        if (p && typeof p === 'object') {
          const text = typeof p.text === 'string' ? p.text.trim()
            : (typeof p.point === 'string' ? p.point.trim() : '');
          if (!text) return null;
          let start = this.parseStartToSeconds(p.start !== undefined ? p.start : p.time);
          if (start !== null && start > max) start = null;
          return { text, start };
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Coerce a chapter "start" value to seconds. Accepts:
   *   - a number (seconds)                      -> 137
   *   - a numeric string "137"                  -> 137
   *   - a clock string "2:17" / "1:02:17"       -> mm:ss / h:mm:ss
   * Returns null when it cannot be parsed.
   */
  parseStartToSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (s === '') return null;

    // Plain number in a string ("137", "137.0")
    if (/^\d+(\.\d+)?$/.test(s)) {
      return Math.max(0, Math.floor(parseFloat(s)));
    }
    // Clock format mm:ss or h:mm:ss (also tolerate "1h02m03s"-free colon form)
    if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(s)) {
      const parts = s.split(':').map(n => parseInt(n, 10));
      if (parts.some(n => isNaN(n))) return null;
      let secs = 0;
      for (const p of parts) secs = secs * 60 + p;
      return Math.max(0, secs);
    }
    return null;
  }

  /**
   * Validate, sort, clamp and dedupe AI chapters. Tolerant of the many shapes
   * models return: start may be seconds, a numeric string, or a "mm:ss" clock;
   * the key may be start/startSeconds/time/timestamp/t and the label
   * title/label/name/text.
   */
  normalizeChapters(rawChapters, durationSec) {
    if (!Array.isArray(rawChapters)) return [];
    const max = durationSec && durationSec > 0 ? Math.floor(durationSec) : Infinity;

    const pickStart = (c) => {
      for (const k of ['start', 'startSeconds', 'time', 'timestamp', 'seconds', 't']) {
        if (c && c[k] !== undefined && c[k] !== null) {
          const v = this.parseStartToSeconds(c[k]);
          if (v !== null) return v;
        }
      }
      return null;
    };
    const pickTitle = (c) => {
      for (const k of ['title', 'label', 'name', 'text', 'chapter']) {
        if (c && typeof c[k] === 'string' && c[k].trim()) return c[k].trim();
      }
      return '';
    };

    const cleaned = rawChapters
      .map(c => ({ start: pickStart(c), title: pickTitle(c) }))
      .filter(c => c.start !== null && c.start <= max && c.title.length > 0)
      .sort((a, b) => a.start - b.start);

    // Drop duplicates / out-of-order starts
    const result = [];
    let lastStart = -1;
    for (const c of cleaned) {
      if (c.start <= lastStart) continue;
      result.push(c);
      lastStart = c.start;
    }

    // Anchor the first chapter at 0 (shift it rather than inventing a row).
    if (result.length > 0 && result[0].start !== 0) {
      result[0] = { start: 0, title: result[0].title };
    }
    return result;
  }

  // ---- Self-heal (AI-driven DOM selector recovery) ----
  // Returns the SAME shape TranscriptService.applyHealedSelectors() expects, so the
  // transcript layer's recovery works unchanged. A stronger model is forced.
  async healSelectors(snapshot) {
    const model = this.providerName === CONFIG.AI_PROVIDERS.OPENAI.NAME ? 'gpt-5.5' : 'sonnet';
    const systemPrompt = this.getHealSystemPrompt();
    const userMessage = `<dom_snapshot>\n${snapshot}\n</dom_snapshot>\n\nReturn ONLY the selectors JSON object.`;

    const payload = this.provider.createPayload(systemPrompt, userMessage, model);
    const response = await this.provider.sendRequest(payload);
    const parsed = this.provider.parseResponse(response);

    const result = this.normalizeHealResult(parsed);
    this.logger.info('Self-heal selectors produced', { model, keys: Object.keys(result) });
    return result;
  }

  /** Keep only string selector values from the parsed heal response. */
  normalizeHealResult(parsed) {
    const keys = [
      'descriptionExpanderSelector',
      'transcriptButtonSelector',
      'panelSelector',
      'segmentSelector',
      'timestampSelector',
      'textSelector'
    ];
    const out = {};
    for (const key of keys) {
      const value = parsed && parsed[key];
      if (typeof value === 'string' && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  }

  getHealSystemPrompt() {
    return `You are a DOM analysis expert. You are given a pruned HTML snapshot from a YouTube watch page (youtube.com/watch). Inline styles, scripts and SVGs have been stripped, but tag names, id, class, aria-label and target-id attributes are preserved.

<goal>
A browser extension needs CSS selectors to (1) expand the video description, (2) open the transcript panel, and (3) read transcript segments. YouTube periodically renames elements, breaking hard-coded selectors. Derive working selectors from the snapshot.
</goal>

<what_to_find>
- descriptionExpanderSelector: the "...more" / "Show more" button that expands the collapsed description (historically id "expand").
- transcriptButtonSelector: the "Show transcript" button (often inside ytd-video-description-transcript-section-renderer; has aria-label or text mentioning transcript).
- panelSelector: the engagement panel container that holds the transcript (an ytd-engagement-panel-section-list-renderer whose target-id contains "transcript", e.g. "PAmodern_transcript_view").
- segmentSelector: the repeated element representing one transcript line (historically ytd-transcript-segment-renderer).
- timestampSelector: the element INSIDE a segment holding the timestamp text like "1:23" (historically ".segment-timestamp").
- textSelector: the element INSIDE a segment holding the caption text (historically ".segment-text").
</what_to_find>

<rules>
- Prefer STABLE selectors: tag names, target-id substrings, aria-label, semantic ids over hashed/random class names.
- timestampSelector and textSelector must be relative to a single segment element (used via segment.querySelector).
- If an element is not present in the snapshot, set its value to null. Never invent class names you do not see.
- Return ONLY a valid JSON object, no markdown, no commentary.
</rules>

<output_format>
{
  "descriptionExpanderSelector": "<css or null>",
  "transcriptButtonSelector": "<css or null>",
  "panelSelector": "<css or null>",
  "segmentSelector": "<css or null>",
  "timestampSelector": "<css or null>",
  "textSelector": "<css or null>"
}
</output_format>`;
  }
}

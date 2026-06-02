# RecapTube AI

<div align="center">

<img src="src/icons/icon128.png" alt="RecapTube AI Logo" width="128">

**AI-powered Chrome extension that summarizes any YouTube video, translates the summary into your language, and auto-generates topic chapters — straight from the transcript.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](#)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-orange.svg)](https://chrome.google.com/webstore)

[Features](#-features) • [Installation](#-installation) • [How it works](#-how-it-works) • [Privacy](#-privacy--security)

</div>

---

## 🚀 Features

- **📝 AI Summary** — A faithful summary plus key takeaways for any video with subtitles.
- **🌍 Built-in Translation** — The summary is written directly in **your browser's language**, whatever the video's original language is. No separate translation step.
- **📑 Auto Chapters** — Generates topic chapters with timestamps **only when the creator didn't add any**. If the video already has chapters, RecapTube defers to them.
- **🎯 Jump to topic** — Click a chapter in the panel, or a marker on the progress bar, to seek the video.
- **🤖 Multiple AI Providers** — Anthropic **Claude** (Haiku/Sonnet) or **OpenAI** GPT (5.5 / 5.4-mini / 5.4-nano).
- **🪟 In-page panel** — Injected next to the video; collapsible, with a one-click regenerate.
- **💾 Smart Caching** — Results cached locally per video **and language** for 30 days; reopening is instant and free.
- **🔒 Privacy-First** — Everything local; you bring your own API key.
- **🚫 Channel exclusions** — Skip processing for channels you choose.

---

## 📦 Installation

### For users

1. **Get an API key** from your preferred provider:
   - **Anthropic Claude** — [console.anthropic.com](https://console.anthropic.com/settings/keys) (key starts with `sk-ant-`)
   - **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (key starts with `sk-`)
2. **Load the extension** (see [Development](#-development) to build `dist/`, or install from the Web Store when available).
3. **Configure**: click the RecapTube icon → pick provider → paste key → **Save** → choose model, summary length and output language.
4. Open any YouTube video **with subtitles** and the panel appears next to it.

---

## 🎬 How it works

1. **Transcript extraction** — A MAIN-world network interceptor reads YouTube's own `get_transcript` response (resilient to DOM redesigns), with DOM scraping and an AI self-heal as fallbacks.
2. **Native-chapter detection** — RecapTube checks whether the video already has creator chapters (player ticks / chapters panel).
3. **One AI call** — The transcript is sent to your provider, which returns a summary + key points **in your language** and, if needed, topic chapters with timestamps.
4. **Render** — An in-page panel shows the summary and a clickable chapter list; when chapters are AI-generated, markers are drawn on the progress bar.
5. **Cache** — The result is cached locally as `recap_<videoId>_<lang>` for 30 days.

---

## 🔒 Privacy & Security

- ✅ Your API key is stored locally in the browser.
- ✅ All settings and cache stay on your device.
- ✅ No tracking, no analytics, no backend servers.
- ✅ Only the transcript (and, rarely, a stripped page-structure snapshot for self-heal) is sent to **your chosen** AI provider.

See the full [Privacy Policy](PRIVACY.md).

---

## 🛠 Development

### Prerequisites
- Node.js v16+
- Chrome (or a Chromium browser)
- An API key from Anthropic and/or OpenAI

### Build
```bash
npm install
npm run build          # builds all bundles into dist/
npm run watch          # rebuild on change
npm run generate-icons # regenerate icons + logo from the inline SVG
```

### Load in Chrome
1. `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select the **`dist/`** folder (not the project root)

### Project structure
```
src/
  manifest.json
  content/
    content-main.js              # RecapManager — panel, markers, orchestration (ISOLATED world)
    transcript-interceptor.js    # MAIN-world network interceptor (RT_* contract)
  background/
    background-main.js           # BackgroundService — generateRecap, cache, key handling
  popup/  help/                  # UI surfaces (+ welcome.html)
  shared/
    config.js  constants.js
    services/
      transcript-service.js      # 3-layer transcript extraction (interceptor → DOM → self-heal)
      recap-service.js           # AI pipeline: summary + translation + chapters
      storage-service.js
      providers/                 # base / claude / openai
    models/ repositories/ validators/ errors/ logger/
```

### Build system
Rollup produces three IIFE bundles (`content`, `background`, `popup`). `rollup.config.popup.js` also copies `manifest.json`, the HTML pages, icons, the logo, and the (unbundled) `transcript-interceptor.js` into `dist/`.

---

## 🧰 Configuration highlights

```javascript
// src/shared/config.js
CACHE:    { MAX_AGE_DAYS: 30, KEY_PREFIX: 'recap_' }
DEFAULTS: {
  SETTINGS: {
    enabled: true, generateSummary: true, generateChapters: true,
    showProgressMarkers: true, autoOpenPanel: true,
    summaryLength: 'medium', outputLanguage: 'auto'
  },
  ADVANCED_SETTINGS: { aiProvider: 'claude', aiModel: 'haiku', channelWhitelist: [] }
}
```

Models live in `config.js` (Claude `haiku`/`sonnet`; OpenAI `gpt-5.5`/`gpt-5.4-mini`/`gpt-5.4-nano`) and the popup model selector.

---

## 🐛 Common issues

- **"Transcript not available"** — the video has no subtitles, or all extraction layers failed. RecapTube opens the transcript panel automatically to trigger it; try reloading.
- **Summary in the wrong language** — set **Output language** in the popup (`Auto` follows `navigator.language`).
- **No AI chapters** — expected when the video already has creator chapters; RecapTube won't duplicate them.
- **Nothing happens** — check the API key is saved, the master toggle is on, and the channel isn't excluded. Use **Regenerate this video**.

---

## 🤝 A sibling project

RecapTube AI shares its architecture with **SkipTube AI** (the AI sponsor-skipper). Both can run on the same page: RecapTube uses a distinct interceptor contract (`RT_*` vs `YSS_*`) and `rt-`/`yss-` DOM prefixes so they never collide.

---

## 🎨 UI / design

The interface uses a YouTube-like visual language built from **functional design
tokens** (color values, spacing, radii, type scale) and the **Roboto** font
(Apache 2.0). These are functional values, not protected by copyright; no
trademarks, logos or proprietary fonts of any platform are used. The per-product
accent (RecapTube: blue `#3ea6ff`) keeps it distinct.

## 📝 License

MIT — see [LICENSE](LICENSE).

<div align="center">

**Made with ❤️ by Giovanni Guarino**

</div>

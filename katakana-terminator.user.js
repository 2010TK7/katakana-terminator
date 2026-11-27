// ==UserScript==
// @name        片假名终结者
// @name:zh-CN  片假名终结者
// @name:ja     カタカナターミネーター
// @name:en     Katakana Terminator
// @name:ko-KR  가타카나 터미네이터
// @description 在网页中的日语外来语上方标注英文原词，并支持可配置的排除网址黑名单
// @author      Arnie97, Leimeng52mc, Izumiko, 2010TK7
// @license     MIT
// @copyright   2017-2026, Katakana Terminator Contributors (https://github.com/2010TK7/katakana-terminator/graphs/contributors)
// @namespace   https://github.com/Leimeng52mc
// @homepageURL https://github.com/2010TK7/katakana-terminator
// @supportURL  https://greasyfork.org/scripts/607314/feedback
// @icon        https://upload.wikimedia.org/wikipedia/commons/2/28/Ja-Ruby.png
// @match       *://*/*
// @run-at      document-idle
// @grant       GM.xmlHttpRequest
// @grant       GM_addStyle
// @grant       GM_registerMenuCommand
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_deleteValue
// @grant       GM_addValueChangeListener
// @connect     translate.googleapis.com
// @connect     edge.microsoft.com
// @connect     *
// @version     2026.11.25
// @description:zh-CN 在网页中的日语外来语上方标注英文原词，并支持可配置的排除网址黑名单
// @description:ja ウェブページノニホンゴガイライゴノウエニエイゴゲンゴヲルビヒョウジ、オヨビカスタマイズカノウナジョガイURLブラックリスト
// @description:en Convert Japanese loanwords (gairaigo) on web pages back to English with ruby annotations, with a configurable exclusion blacklist
// @description:ko-KR 웹페이지의 일본어 외래어 위에 영어 원어를 루비로 표시하며, 제외 URL 블랙리스트를 설정할 수 있습니다
// ==/UserScript==

(() => {
    'use strict';

    /**
     * Persistent LRU Cache with TTL support
     */
    class PersistentLRUCache {
        constructor(maxSize, ttlDays) {
            this.maxSize = maxSize;
            this.ttlMs = ttlDays * 24 * 60 * 60 * 1000; // Convert days to milliseconds
            this.cache = new Map();
            this.saveTimer = null;
            this.storageKey = 'translationCache';
            this.hasGMSupport = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

            // Load from storage
            this._load();

            if (typeof GM_addValueChangeListener === 'function') {
                GM_addValueChangeListener(this.storageKey, (name, old_value, new_value, remote) => {
                    if (name !== this.storageKey || !remote) {
                        return;
                    }
                    if (!new_value) {
                        this.cache.clear();
                        return;
                    }
                    try {
                        const data = JSON.parse(new_value);
                        Object.entries(data).forEach(([key, entry]) => {
                            if (entry.value !== null && !this._isExpired(entry)) {
                                const existing = this.cache.get(key);
                                if (!existing || entry.timestamp >= existing.timestamp) {
                                    if (existing) {
                                        this.cache.delete(key);
                                    }
                                    this.cache.set(key, entry);
                                }
                            }
                        });
                    } catch (parseError) {
                        console.error('Katakana Terminator: Failed to parse remote cache', parseError);
                    }
                });
            }
        }

        /**
         * Load cache from GM storage
         */
        _load() {
            if (!this.hasGMSupport) {
                console.debug('Katakana Terminator: GM storage not available, using memory-only cache');
                return;
            }

            try {
                const stored = GM_getValue(this.storageKey, null);
                if (stored) {
                    const data = JSON.parse(stored);
                    // Restore Map from object, skip null values
                    Object.entries(data).forEach(([key, entry]) => {
                        if (entry.value !== null && !this._isExpired(entry)) {
                            this.cache.set(key, entry);
                        }
                    });
                    console.debug('Katakana Terminator: Loaded', this.cache.size, 'cached translations from storage');
                }
            } catch (error) {
                console.error('Katakana Terminator: Failed to load cache from storage', error);
                this.cache.clear();
            }
        }

        /**
         * Save cache to GM storage (debounced)
         */
        _save() {
            if (!this.hasGMSupport) return;

            // Clear existing timer
            if (this.saveTimer) {
                clearTimeout(this.saveTimer);
            }

            // Schedule save after 1 second
            this.saveTimer = setTimeout(() => {
                this._flushSync();
            }, 1000);
        }

        /**
         * Immediately save cache to storage (merge with remote data to avoid overwriting)
         */
        _flushSync() {
            if (!this.hasGMSupport) return;

            try {
                // Read current storage data
                const stored = GM_getValue(this.storageKey, null);
                const merged = {};

                // Load remote data first
                if (stored) {
                    try {
                        const remoteData = JSON.parse(stored);
                        Object.entries(remoteData).forEach(([key, entry]) => {
                            if (entry.value !== null && !this._isExpired(entry)) {
                                merged[key] = entry;
                            }
                        });
                    } catch (parseError) {
                        console.error('Katakana Terminator: Failed to parse remote cache', parseError);
                    }
                }

                // Merge local cache (newer entries overwrite older ones)
                this.cache.forEach((entry, key) => {
                    if (entry.value !== null && !this._isExpired(entry)) {
                        const existing = merged[key];
                        if (!existing || entry.timestamp >= existing.timestamp) {
                            merged[key] = entry;
                        }
                    }
                });

                const sorted = Object.entries(merged)
                    .sort((a, b) => a[1].timestamp - b[1].timestamp);
                const sliced = this.maxSize > 0 ? sorted.slice(-this.maxSize) : sorted;

                // Write merged data
                GM_setValue(this.storageKey, JSON.stringify(Object.fromEntries(sliced)));
            } catch (error) {
                console.error('Katakana Terminator: Failed to save cache to storage', error);
            }
        }

        /**
         * Flush cache immediately (for beforeunload)
         */
        flush() {
            if (this.saveTimer) {
                clearTimeout(this.saveTimer);
                this.saveTimer = null;
            }
            this._flushSync();
        }

        /**
         * Check if entry is expired, or holds an invalid (katakana-containing) value
         */
        _isExpired(entry) {
            if (QUICK_KATAKANA_RE.test(entry.value)) return true;
            if (this.ttlMs <= 0) return false; // Never expire
            return Date.now() - entry.timestamp > this.ttlMs;
        }

        /**
         * Prune expired entries
         */
        _pruneExpired() {
            let prunedCount = 0;
            for (const [key, entry] of this.cache.entries()) {
                if (this._isExpired(entry)) {
                    this.cache.delete(key);
                    prunedCount++;
                }
            }
            if (prunedCount > 0) {
                console.debug('Katakana Terminator: Pruned', prunedCount, 'expired cache entries');
                this._save();
            }
        }

        /**
         * Check if key exists and is not expired
         */
        has(key) {
            const entry = this.cache.get(key);
            if (!entry) return false;

            if (this._isExpired(entry)) {
                this.cache.delete(key);
                this._save();
                return false;
            }

            return true;
        }

        /**
         * Get value by key
         */
        get(key) {
            const entry = this.cache.get(key);
            if (!entry) return undefined;

            if (this._isExpired(entry)) {
                this.cache.delete(key);
                this._save();
                return undefined;
            }

            // Update timestamp and move to end (LRU)
            this.cache.delete(key);
            entry.timestamp = Date.now();
            this.cache.set(key, entry);
            this._save();

            return entry.value;
        }

        /**
         * Set value by key
         */
        set(key, value) {
            // Remove if already exists (to update position)
            if (this.cache.has(key)) {
                this.cache.delete(key);
            }

            // Add new entry
            this.cache.set(key, {
                value: value,
                timestamp: Date.now()
            });

            // Enforce size limit (remove oldest)
            if (this.maxSize > 0 && this.cache.size > this.maxSize) {
                const firstKey = this.cache.keys().next().value;
                this.cache.delete(firstKey);
            }

            this._save();
        }

        /**
         * Delete entry by key
         */
        delete(key) {
            const result = this.cache.delete(key);
            if (result) {
                this._save();
            }
            return result;
        }

        /**
         * Clear all cache
         */
        clear() {
            this.cache.clear();
            if (this.hasGMSupport) {
                GM_deleteValue(this.storageKey);
            }
            console.debug('Katakana Terminator: Cache cleared');
        }

        /**
         * Get cache statistics
         */
        getStats() {
            let oldestTimestamp = Date.now();
            let totalSize = 0;

            this.cache.forEach((entry, key) => {
                if (entry.timestamp < oldestTimestamp) {
                    oldestTimestamp = entry.timestamp;
                }
                // Rough size estimation
                totalSize += key.length + (entry.value ? entry.value.length : 0) + 20;
            });

            return {
                count: this.cache.size,
                size: totalSize,
                oldestDate: this.cache.size > 0 ? new Date(oldestTimestamp).toLocaleString() : null
            };
        }
    }

    const EXCLUDE_TAGS = new Set([
        'ruby', 'script', 'style', 'noscript', 'select', 'textarea', 'input', 'option',
        'code', 'pre', 'kbd', 'samp', 'svg', 'math',
    ]);
    const QUICK_KATAKANA_RE = /[\u30A1-\u30FF\uFF66-\uFF9F]/;
    const KATAKANA_CANDIDATE_RE = /[\u30A1-\u30FA\u30FD-\u30FF][\u3099\u309A\u30A1-\u30FA\u30FC-\u30FF]*[\u3099\u309A\u30A1-\u30FA\u30FC-\u30FF]|[\uFF66-\uFF6F\uFF71-\uFF9D][\uFF66-\uFF9F]*[\uFF66-\uFF9F]/g;

    const CHUNK_SIZE = 200;
    const RESCAN_DELAY_MS = 200;
    const CONFIG_KEY = 'katakana-terminator-config-v1';
    const CONFIG_VERSION = 2.2;
    const DEFAULT_CONFIG = {
        version: CONFIG_VERSION,
        backend: 'edge', // 默认后端；合法取值来自 TRANSLATION_BACKENDS
        blacklist: [
            // 网页邮箱 —— 在写信/编辑器区域改动 DOM 可能损坏邮件
            '*://mail.qq.com/*',
            '*://*.mail.163.com/*',
            '*://*.mail.126.com/*',
            '*://mail.sina.com.cn/*',
            '*://mail.aliyun.com/*',
            // 在线办公 —— 编辑区域对 DOM 改动敏感
            '*://docs.qq.com/*',
            '*://*.feishu.cn/*',
            '*://*.larksuite.com/*',
            '*://*.yuque.com/*',
            '*://*.kdocs.cn/*',
            // 即时通讯 —— 消息完整性重要
            '*://*.wx.qq.com/*',
            '*://*.wechat.com/*',
            '*://web.q.qq.com/*',
            // 支付金融 —— 敏感页面避免任何风险
            '*://*.alipay.com/*',
            '*://*.tenpay.com/*',
            '*://*.eastmoney.com/*',
            '*://*.xueqiu.com/*',
        ],
        aiApiKey: '',     // AI API key
        aiApiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', // AI API endpoint
        aiModel: 'gemini-2.5-flash-lite',
    };

    const doc = document;
    const queue = new Map(); // 短语 -> Set<rt>
    const cache = new PersistentLRUCache(10000, 90); // 短语 -> 译文 | null（请求中）
    const pendingNodes = new Set();
    const textNodeSnapshot = new WeakMap(); // TextNode -> { value: string, ownedFragments?: Node[] }

    let observer = null;
    let flushTimer = null;
    let translatorSession = null; // { session, sourceLanguage, targetLanguage }
    let config = { ...DEFAULT_CONFIG };
    let originalHtmlLang = null;
    let translationWatchers = [];
    let dialogStyleInjected = false;

    // {"keyA": 1, "keyB": 2} => "?keyA=1&keyB=2"
    function buildQueryString(params) {
        return `?${Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')}`;
    }

    function trimEnd(text) {
        return String(text).replace(/\s+$/, '');
    }

    function getAiApiEndpointSuffix(text, mode) {
        if (trimEnd(text) !== text) {
            return '';
        }
        let url;
        try {
            url = new URL(text);
        } catch {
            return '';
        }
        if (url.search || url.hash) {
            return '';
        }
        if (url.pathname === '/') {
            return `${text.endsWith('/') ? '' : '/'}v1/${mode}`;
        }
        if (url.pathname.endsWith('/v1') || url.pathname.endsWith('/v1/')) {
            return `${text.endsWith('/') ? '' : '/'}${mode}`;
        }
        return '';
    }

    function updateRubyByCachedTranslations(phrase) {
        const translated = cache.get(phrase);
        if (!translated) {
            return;
        }

        const rtNodes = queue.get(phrase) || new Set();
        rtNodes.forEach((node) => {
            node.dataset.rt = translated;
        });
        queue.delete(phrase);
    }

    function handleTranslationWarning(providerName, err) {
        const message = err && err.message ? err.message : String(err || '未知错误');
        console.warn(`Katakana Terminator: ${providerName} 翻译失败`, message, err);
    }

    function handleTranslationFailure(providerName, err, phrases) {
        const message = err && err.message ? err.message : String(err || '未知错误');
        console.error(`Katakana Terminator: ${providerName} 翻译失败`, message, err);
        phrases.forEach((phrase) => cache.delete(phrase));
    }

    function sendRequest(requestOptions) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                ...requestOptions,
                onload: resolve,
                onerror: reject,
                onabort: reject,
                ontimeout: reject,
            });
        });
    }

    function applyTranslationsByIndex(phrases, translatedByIndex) {
        phrases.forEach((phrase, index) => {
            const translated = translatedByIndex[index];
            if (!translated || QUICK_KATAKANA_RE.test(translated)) {
                cache.delete(phrase);
                return;
            }

            cache.set(phrase, translated);
            updateRubyByCachedTranslations(phrase);
        });
    }

    // Provider 契约：raw translate(srcLang, destLang, phrases) 必须返回与 phrases
    // 按索引对齐的译文数组（'' 表示无结果，可稍后重试），失败时抛出异常。
    // translate 可为函数数组，构成 fallback 链：
    // 按序尝试，抛错即换次级，直到成功或所有级均抛错，且仅在末级抛错时清除请求中占位；
    // 抛错过的级保留原位，不影响后续调用。
    function createTranslationProvider({ name, label, translate }) {
        return {
            name,
            label: label || name,
            async translate(srcLang, destLang, phrases) {
                // 请求完成前先标记在途，避免重复发起同一 HTTP 请求
                phrases.forEach((phrase) => {
                    cache.set(phrase, null);
                });

                const translates = Array.isArray(translate) ? translate : [translate];
                for (let i = 0; i !== translates.length; ++i) {
                    try {
                        const translatedByIndex = await translates[i](srcLang, destLang, phrases);
                        applyTranslationsByIndex(phrases, translatedByIndex);
                        break;
                    } catch (err) {
                        if (i !== translates.length - 1) {
                            handleTranslationWarning(name, err);
                        } else {
                            handleTranslationFailure(name, err, phrases);
                        }
                    }
                }
            },
        };
    }

    // Chrome 内置 AI 的本地翻译 API，https://developer.chrome.com/docs/ai/translator-api
    // Edge 内置 AI 的本地翻译 API，https://learn.microsoft.com/microsoft-edge/web-platform/translator-api
    // 获取（或惰性创建）指定语言对的 Translator 会话；模型首次使用时需下载，之后常驻内存
    function getTranslatorSession(srcLang, destLang) {
        if (translatorSession && translatorSession.sourceLanguage === srcLang && translatorSession.targetLanguage === destLang) {
            return translatorSession.session;
        }

        const sessionPromise = (async () => {
            const availability = await Translator.availability({ sourceLanguage: srcLang, targetLanguage: destLang });
            if (availability === 'unavailable') {
                throw new Error(`当前浏览器不支持 Translator API（需要桌面版 Chrome 138+ / Edge 148+）：${srcLang} → ${destLang} 语言对不可用`);
            }

            return Translator.create({
                sourceLanguage: srcLang,
                targetLanguage: destLang,
                monitor: (m) => {
                    m.addEventListener('downloadprogress', (event) => {
                        console.debug('Katakana Terminator: Translator 模型下载中', Math.round((event.loaded / event.total) * 100), '%');
                    });
                },
            });
        })().catch((err) => {
            // 创建失败时清空缓存，允许下次请求重试
            translatorSession = null;
            throw err;
        });

        translatorSession = {
            sourceLanguage: srcLang,
            targetLanguage: destLang,
            session: sessionPromise,
        };
        return sessionPromise;
    }

    const translationProviders = {
        edge: createTranslationProvider({
            name: 'Edge',
            label: 'Microsoft Edge (无密钥)',
            // Edge 免鉴权直调接口，https://www.ankio.net/research/technology/microsoft-edge-translate-api
            translate: async (srcLang, destLang, phrases) => {
                const endpoint = `https://edge.microsoft.com/translate/translatetext${buildQueryString({
                    from: srcLang,
                    to: destLang,
                    isEnterpriseClient: false,
                })}`;

                const res = await sendRequest({
                    method: 'POST',
                    url: endpoint,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    data: JSON.stringify(phrases),
                });

                if (res.status < 200 || res.status >= 300) {
                    throw new Error(`请求失败：${res.status} ${res.statusText}`);
                }

                let resp;
                try {
                    resp = JSON.parse(res.responseText);
                } catch (err) {
                    throw new Error(`JSON 解析失败：${res.responseText}`);
                }

                if (!Array.isArray(resp)) {
                    throw new Error(`响应结构异常：${JSON.stringify(resp)}`);
                }

                return resp.map((item) => {
                    const translated = item && item.translations && item.translations[0] && item.translations[0].text;
                    return translated ? trimEnd(translated) : '';
                });
            },
        }),
        // Google 翻译接口，https://github.com/ssut/py-googletrans/issues/268
        google: createTranslationProvider({
            name: 'Google',
            label: 'Google Translate',
            translate: [
                async (srcLang, destLang, phrases) => {
                    const joinedText = trimEnd(phrases.join('\n'));
                    const api = 'https://translate.googleapis.com/translate_a/single';
                    const params = {
                        client: 'gtx',
                        dt: 't',
                        sl: srcLang,
                        tl: destLang,
                        q: joinedText,
                    };

                    const res = await sendRequest({
                        method: 'GET',
                        url: api + buildQueryString(params),
                    });

                    if (res.status < 200 || res.status >= 300) {
                        throw new Error(`请求失败：${res.status} ${res.statusText}`);
                    }

                    let resp;
                    try {
                        resp = JSON.parse(res.responseText);
                    } catch (err) {
                        throw new Error(`响应解析失败：${res.responseText}`);
                    }

                    if (!Array.isArray(resp) || !Array.isArray(resp[0])) {
                        throw new Error(`响应结构异常：${JSON.stringify(resp)}`);
                    }

                    const translatedByOriginal = new Map();
                    resp[0].forEach((item) => {
                        const translated = item && item[0] ? trimEnd(item[0]) : '';
                        const original = item && item[1] ? trimEnd(item[1]) : '';
                        if (original && translated) {
                            translatedByOriginal.set(original, translated);
                        }
                    });

                    return phrases.map((phrase) => translatedByOriginal.get(phrase) || '');
                },
                async (srcLang, destLang, phrases) => {
                    const joinedText = trimEnd(phrases.join('\n'));
                    const api = 'https://translate.googleapis.com/translate_a/t';
                    const params = {
                        client: 'dict-chrome-ex',
                        dt: 't',
                        sl: srcLang,
                        tl: destLang,
                        q: joinedText,
                    };

                    const res = await sendRequest({
                        method: 'GET',
                        url: api + buildQueryString(params),
                    });

                    if (res.status < 200 || res.status >= 300) {
                        throw new Error(`请求失败：${res.status} ${res.statusText}`);
                    }

                    let resp;
                    try {
                        resp = JSON.parse(res.responseText);
                    } catch (err) {
                        throw new Error(`响应解析失败：${res.responseText}`);
                    }

                    const translatedByOriginal = new Map();
                    // ["katakana\nterminator"]
                    if (!resp.sentences) {
                        const translated = resp[0].split('\n');
                        if (translated.length !== phrases.length) {
                            throw new Error('Response does not match input phrases');
                        }
                        translated.forEach((trans, i) => {
                            const orig = phrases[i];
                            translatedByOriginal.set(orig, trimEnd(trans));
                        });
                    } else {
                        resp.sentences.forEach(s => {
                            if (!s.orig) return;

                            const original = s.orig.trim();
                            const translated = s.trans.trim();
                            translatedByOriginal.set(original, translated);
                        });
                    }

                    return phrases.map((phrase) => translatedByOriginal.get(phrase) || '');
                },
            ],
        }),
        translator: createTranslationProvider({
            name: 'Translator',
            label: 'Translator API（离线）',
            // 单个模型会话逐段翻译，无需网络请求；模型首次使用时自动下载
            translate: async (srcLang, destLang, phrases) => {
                if (typeof Translator === 'undefined') {
                    throw new Error('当前浏览器不支持 Translator API（需要桌面版 Chrome 138+ / Edge 148+）');
                }

                const session = await getTranslatorSession(srcLang, destLang);
                return Promise.all(phrases.map((phrase) => session.translate(phrase).then(trimEnd)));
            },
        }),
        ai: createTranslationProvider({
            name: 'AI',
            label: 'AI API',
            translate: async (srcLang, destLang, phrases) => {
                const processAiChunk = async (phrases) => {
                    // Build prompt
                    const prompt = `
Your task is to restore the following Japanese katakana terms to their original source language words or their Romaji representation.

## Rules
- For each katakana term, provide its original word or phrase from its source language.
- If the term is a native Japanese word (e.g., onomatopoeia, emphasis), identify the language as Japanese ('ja') and output its Romaji transliteration.
- If the term is an abbreviation, return the full original name.
- Prepend each result with its ISO 639-1 language code followed by a colon and a space (e.g., 'en: ').
- Return one result per line.
- Do not include the original katakana, explanations, or any other text in your response.

## Katakana Terms to Restore
${phrases.join('\n')}

## Example Request and Response

### Request:
ストレス
アルバイト
ブルアカ
パソコン
キラキラ
ワクチン

### Response:
en: stress
de: Arbeit
en: Blue Archive
en: personal computer
ja: kirakira
nl: vaccin
`;
                    const systemPrompt = `
You are a specialized linguistic AI assistant. Your sole purpose is to analyze Japanese katakana terms, identify their etymological origins, and return the original word or phrase in its source language.
Core Directives:
- **Identify Source Language**: You must accurately determine the source language (e.g., English, German, French, etc.).
- **Handle Native Japanese Words**: If a katakana term represents a native Japanese word (e.g., onomatopoeia, for emphasis), you must identify the language as Japanese ('ja') and provide its standard Romaji transliteration.
- **Handle Abbreviations**: You are an expert at recognizing katakana abbreviations (e.g.,「パソコン」,「ブルアカ」) and must return the full, original term (e.g., "personal computer", "Blue Archive"), not the expanded katakana.
- **Strict Output Format**: Your response must strictly adhere to the format '[ISO 639-1 code]: [Original Word/Phrase/Romaji]'.
- **No Extra Information**: You must NOT provide any explanations, Japanese translations, katakana terms, or any other text outside of the requested output. Your response should be clean data.
- **Precision**: Maintain original capitalization for proper nouns, acronyms, or language-specific rules (e.g., German nouns).
`;

                    // Make API request
                    const response = await sendRequest({
                        method: 'POST',
                        url: `${config.aiApiEndpoint}${getAiApiEndpointSuffix(config.aiApiEndpoint, 'chat/completions')}`,
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${config.aiApiKey}`
                        },
                        data: JSON.stringify({
                            model: config.aiModel,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: prompt }
                            ],
                        })
                    });

                    const data = JSON.parse(response.responseText);

                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        const content = data.choices[0].message.content;

                        // Split response into lines
                        const lines = content.trim().split('\n');

                        // Ensure line count matches phrase count
                        if (lines.length === phrases.length) {
                            return phrases.map((phrase, index) => lines[index].trim());
                        } else {
                            console.debug(prompt);
                            console.debug(content);
                            throw new Error('AI response does not match input count');
                        }
                    } else {
                        console.debug(prompt);
                        console.debug(data);
                        throw new Error('Invalid AI response format');
                    }
                };
                return processAiChunk(phrases);
            },
        }),
    };

    // 合法后端 ID 的单一来源，配置校验依赖它
    const TRANSLATION_BACKENDS = new Set(Object.keys(translationProviders));

    function normalizeBlacklistEntry(entry) {
        return String(entry || '').trim();
    }

    function sanitizeBlacklist(input) {
        const values = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
        const seen = new Set();
        const result = [];

        values.forEach((item) => {
            const entry = normalizeBlacklistEntry(item);
            if (!entry || entry.startsWith('#')) {
                return;
            }

            if (!seen.has(entry)) {
                seen.add(entry);
                result.push(entry);
            }
        });

        return result;
    }

    function sanitizeConfig(input) {
        if (!input) {
            return { ...DEFAULT_CONFIG };
        }
        const next = { ...DEFAULT_CONFIG };
        next.version = CONFIG_VERSION;
        if (TRANSLATION_BACKENDS.has(input.backend)) {
            next.backend = input.backend;
        }
        for (const key of ['aiApiEndpoint', 'aiModel', 'aiApiKey']) {
            if (typeof input[key] === 'string') {
                next[key] = input[key];
            }
        }
        if (input.blacklist || input.blacklist === '') {
            next.blacklist = sanitizeBlacklist(input.blacklist);
        }
        return next;
    }

    function wildcardToRegExp(pattern) {
        const escaped = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`, 'i');
    }

    function isBlockedByBlacklist(url) {
        const target = String(url || window.location.href);
        return config.blacklist.some((pattern) => {
            if (!pattern) {
                return false;
            }

            // 同时支持通配符规则与普通 URL 子串规则
            if (pattern.includes('*')) {
                try {
                    return wildcardToRegExp(pattern).test(target);
                } catch (err) {
                    return target.includes(pattern.replace(/\*/g, ''));
                }
            }

            return target.includes(pattern);
        });
    }

    function readConfig() {
        if (typeof GM_getValue === 'function') {
            return sanitizeConfig(GM_getValue(CONFIG_KEY, DEFAULT_CONFIG));
        }

        try {
            const raw = window.localStorage.getItem(CONFIG_KEY);
            return sanitizeConfig(raw ? JSON.parse(raw) : DEFAULT_CONFIG);
        } catch (err) {
            console.warn('Katakana Terminator: 读取配置失败', err);
            return { ...DEFAULT_CONFIG };
        }
    }

    function writeConfig(nextConfig) {
        const safeConfig = sanitizeConfig(nextConfig);

        if (typeof GM_setValue === 'function') {
            GM_setValue(CONFIG_KEY, safeConfig);
        } else {
            try {
                window.localStorage.setItem(CONFIG_KEY, JSON.stringify(safeConfig));
            } catch (err) {
                console.warn('Katakana Terminator: 写入配置失败', err);
            }
        }

        config = safeConfig;
    }

    if (typeof GM_setValue === 'function') {
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener(CONFIG_KEY, (name, old_value, new_value, remote) => {
                if (name !== CONFIG_KEY || !remote) {
                    return;
                }
                config = sanitizeConfig(new_value);
            });
        }
    } else {
        window.addEventListener('storage', (event) => {
            if (event.key !== CONFIG_KEY || event.storageArea !== window.localStorage) {
                return;
            }
            try {
                const raw = event.newValue;
                config = sanitizeConfig(raw ? JSON.parse(raw) : DEFAULT_CONFIG);
            } catch (err) {
                console.warn('Katakana Terminator: 同步配置失败', err);
                config = { ...DEFAULT_CONFIG };
            }
        });
    }

    function registerConfigMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }

        if (window.self !== window.top) {
            return;
        }

        GM_registerMenuCommand('Katakana Terminator: 翻译设置', openConfigDialog);
    }

    function ensureDialogStyle() {
        if (dialogStyleInjected) {
            return;
        }
        dialogStyleInjected = true;

        addStyle(`
            .kt-config-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483646;
                background: rgba(0, 0, 0, 0.45);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                box-sizing: border-box;
                font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                --kt-bg: #fff;
                --kt-fg: #1a1a1a;
                --kt-muted: #5b6b7f;
                --kt-border: #c9d3e3;
                --kt-surface: #fafcff;
                --kt-primary: #2c6bed;
            }
            .kt-config-dialog {
                width: min(560px, calc(100vw - 32px));
                max-height: calc(100vh - 32px);
                max-height: calc(100dvh - 32px);
                display: flex;
                flex-direction: column;
                border-radius: 14px;
                background: var(--kt-bg);
                color: var(--kt-fg);
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
                overflow: hidden;
            }
            .kt-config-header {
                padding: 16px 18px;
                font-size: 17px;
                font-weight: 600;
                background: linear-gradient(120deg, #f4f8ff, #f8fff5);
                border-bottom: 1px solid var(--kt-border);
            }
            .kt-config-body { padding: 16px 18px; display: grid; gap: 14px; overflow-y: auto; }
            .kt-config-grid { display: grid; gap: 14px; }
            .kt-config-item { display: grid; gap: 8px; }
            .kt-config-label { font-size: 13px; font-weight: 600; }
            .kt-config-help { font-size: 12px; color: var(--kt-muted); line-height: 1.45; }
            .kt-config-select {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid var(--kt-border);
                border-radius: 8px;
                background: var(--kt-bg);
                color: var(--kt-fg);
                padding: 8px 10px;
                font-size: 14px;
            }
            .kt-config-select:focus {
                outline: 2px solid rgba(44, 107, 237, 0.35);
                outline-offset: 1px;
            }
            .kt-config-select-wrap {
                position: relative;
            }
            .kt-config-select-hint {
                position: absolute;
                inset: 0;
                color: var(--kt-muted);
                -webkit-text-fill-color: var(--kt-muted);
            }
            .kt-config-select-wrap > .kt-config-select + .kt-config-select {
                position: relative;
                background: transparent;
            }
            .kt-config-footer {
                padding: 12px 18px 16px;
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                border-top: 1px solid var(--kt-border);
                background: var(--kt-surface);
            }
            .kt-config-btn {
                border: 1px solid var(--kt-border);
                border-radius: 8px;
                padding: 7px 12px;
                cursor: pointer;
                font-size: 13px;
                background: var(--kt-bg);
                color: var(--kt-fg);
            }
            .kt-config-btn-primary {
                border-color: var(--kt-primary);
                background: var(--kt-primary);
                color: #fff;
            }
            .kt-config-note { padding: 0 18px 14px; font-size: 12px; color: var(--kt-muted); }
            @media (prefers-color-scheme: dark) {
                .kt-config-overlay {
                    background: rgba(0, 0, 0, 0.68);
                    --kt-bg: #171a21;
                    --kt-fg: #e8edf4;
                    --kt-muted: #9aa7b8;
                    --kt-border: #334155;
                    --kt-surface: #11151b;
                    --kt-primary: #3b82f6;
                }
                .kt-config-header {
                    background: linear-gradient(120deg, #1b2432, #182434);
                }
                .kt-config-select {
                    color-scheme: dark;
                }
            }
        `);
    }

    function openConfigDialog() {
        if (!doc.body) {
            return;
        }

        if (doc.querySelector('.kt-config-overlay')) {
            return;
        }

        ensureDialogStyle();

        const overlay = doc.createElement('div');
        overlay.className = 'kt-config-overlay';

        const dialog = doc.createElement('div');
        dialog.className = 'kt-config-dialog';
        overlay.appendChild(dialog);

        const header = doc.createElement('div');
        header.className = 'kt-config-header';
        header.textContent = 'Katakana Terminator 翻译设置';
        dialog.appendChild(header);

        const body = doc.createElement('div');
        body.className = 'kt-config-body';
        dialog.appendChild(body);

        const backendItem = doc.createElement('div');
        backendItem.className = 'kt-config-item';

        const backendLabel = doc.createElement('label');
        backendLabel.className = 'kt-config-label';
        backendLabel.textContent = '翻译后端';
        backendItem.appendChild(backendLabel);

        const backendSelect = doc.createElement('select');
        backendSelect.className = 'kt-config-select';
        backendSelect.innerHTML = Object.keys(translationProviders).map((id) => (
            `<option value="${id}">${translationProviders[id].label}</option>`
        )).join('');
        backendSelect.value = config.backend;
        backendItem.appendChild(backendSelect);

        body.appendChild(backendItem);

        const aiSettings = doc.createElement('div');
        aiSettings.id = 'ai-settings';
        aiSettings.className = 'kt-config-grid';
        aiSettings.style.display = backendSelect.value === 'ai' ? 'grid' : 'none';
        body.appendChild(aiSettings);

        for (const [name, id, key] of [
            ['API Endpoint (OpenAI-compatible):', 'kt-ai-endpoint', 'aiApiEndpoint'],
            ['Model:', 'kt-ai-model', 'aiModel'],
            ['Enter your API key', 'kt-ai-key', 'aiApiKey'],
        ]) {
            const item = doc.createElement('div');
            item.className = 'kt-config-item';

            const label = doc.createElement('label');
            label.className = 'kt-config-label';
            label.textContent = name;
            item.appendChild(label);

            const input = doc.createElement('input');
            input.id = id;
            input.className = 'kt-config-select';
            input.value = config[key];

            if (id === 'kt-ai-endpoint') {
                const wrap = doc.createElement('div');
                wrap.className = 'kt-config-select-wrap';

                const hint = doc.createElement('input');
                hint.className = 'kt-config-select kt-config-select-hint';
                hint.disabled = true;
                hint.setAttribute('aria-hidden', 'true');

                const updateHint = () => {
                    const suffix = getAiApiEndpointSuffix(input.value, 'chat/completions');
                    hint.value = input.value + suffix;
                    hint.style.visibility = !suffix || input.scrollWidth > input.clientWidth ? 'hidden' : 'visible';
                };
                updateHint();
                input.addEventListener('input', updateHint);

                wrap.append(hint, input);
                item.appendChild(wrap);
            } else {
                item.appendChild(input);
            }

            aiSettings.appendChild(item);
        }

        const blacklistItem = doc.createElement('div');
        blacklistItem.className = 'kt-config-item';

        const blacklistLabel = doc.createElement('label');
        blacklistLabel.className = 'kt-config-label';
        blacklistLabel.textContent = '排除网址黑名单';
        blacklistItem.appendChild(blacklistLabel);

        const blacklistTextarea = doc.createElement('textarea');
        blacklistTextarea.className = 'kt-config-select';
        blacklistTextarea.style.minHeight = '180px';
        blacklistTextarea.style.resize = 'vertical';
        blacklistTextarea.value = config.blacklist.join('\n');
        blacklistItem.appendChild(blacklistTextarea);

        const blacklistHelp = doc.createElement('div');
        blacklistHelp.className = 'kt-config-help';
        blacklistHelp.textContent = '每行一个网址规则，支持 * 通配符。留空项和以 # 开头的行会被忽略。默认已包含邮箱、在线办公、即时通讯、支付金融等容易受脚本干扰的站点。';
        blacklistItem.appendChild(blacklistHelp);
        body.appendChild(blacklistItem);

        const footer = doc.createElement('div');
        footer.className = 'kt-config-footer';
        dialog.appendChild(footer);

        const resetBtn = doc.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'kt-config-btn';
        resetBtn.textContent = '恢复默认';

        const clearCacheBtn = doc.createElement('button');
        clearCacheBtn.type = 'button';
        clearCacheBtn.className = 'kt-config-btn';
        clearCacheBtn.textContent = '清除缓存';

        const cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'kt-config-btn';
        cancelBtn.textContent = '取消';

        const saveBtn = doc.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'kt-config-btn kt-config-btn-primary';
        saveBtn.textContent = '保存';

        footer.appendChild(resetBtn);
        footer.appendChild(clearCacheBtn);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);

        const note = doc.createElement('div');
        note.className = 'kt-config-note';
        note.textContent = '保存后立即生效，已存在的翻译缓存会继续复用。';
        dialog.appendChild(note);

        function closeDialog() {
            overlay.remove();
        }

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeDialog();
            }
        });

        dialog.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        backendSelect.addEventListener('change', () => {
            aiSettings.style.display = backendSelect.value === 'ai' ? 'grid' : 'none';
        });
        cancelBtn.addEventListener('click', closeDialog);
        resetBtn.addEventListener('click', () => {
            backendSelect.value = DEFAULT_CONFIG.backend;
            aiSettings.style.display = backendSelect.value === 'ai' ? 'grid' : 'none';
            aiSettings.querySelector('#kt-ai-endpoint').value = DEFAULT_CONFIG.aiApiEndpoint;
            aiSettings.querySelector('#kt-ai-endpoint').dispatchEvent(new Event('input'));
            aiSettings.querySelector('#kt-ai-model').value = DEFAULT_CONFIG.aiModel;
            aiSettings.querySelector('#kt-ai-key').value = DEFAULT_CONFIG.aiApiKey;
            blacklistTextarea.value = DEFAULT_CONFIG.blacklist.join('\n');
        });
        clearCacheBtn.addEventListener('click', () => {
            cache.clear();
            console.info('Katakana Terminator: 已清除翻译缓存');
            clearCacheBtn.textContent = '已清除';
            clearCacheBtn.disabled = true;
        });

        saveBtn.addEventListener('click', () => {
            const next = sanitizeConfig({
                backend: backendSelect.value,
                aiApiEndpoint: aiSettings.querySelector('#kt-ai-endpoint').value,
                aiModel: aiSettings.querySelector('#kt-ai-model').value,
                aiApiKey: aiSettings.querySelector('#kt-ai-key').value,
                blacklist: blacklistTextarea.value,
            });

            writeConfig(next);

            console.info('Katakana Terminator: 配置已更新', {
                ...next,
                aiApiKey: '*'.repeat(next.aiApiKey.length),
            });
            closeDialog();
        });

        doc.body.appendChild(overlay);
    }

    function addStyle(css) {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
            return;
        }

        const style = doc.createElement('style');
        style.type = 'text/css';
        style.textContent = css;
        (doc.head || doc.documentElement).appendChild(style);
    }

    function enqueuePhrase(phrase, rtNode) {
        if (!queue.has(phrase)) {
            queue.set(phrase, new Set());
        }
        queue.get(phrase).add(rtNode);
    }

    function findKatakanaMatch(text) {
        if (!text || !QUICK_KATAKANA_RE.test(text)) {
            return null;
        }

        KATAKANA_CANDIDATE_RE.lastIndex = 0;
        let match;

        while ((match = KATAKANA_CANDIDATE_RE.exec(text))) {
            const phrase = match[0];
            const index = match.index;

            return { phrase, index };
        }

        return null;
    }

    function shouldSkipTextNode(textNode) {
        const text = textNode.nodeValue || '';
        if (!text.trim()) {
            textNodeSnapshot.set(textNode, { value: text });
            return true;
        }

        const snapshot = textNodeSnapshot.get(textNode);
        if (snapshot?.value === text) {
            return true;
        }

        if (!QUICK_KATAKANA_RE.test(text)) {
            textNodeSnapshot.set(textNode, { value: text });
            return true;
        }

        return false;
    }

    // 深度优先递归遍历节点及其后代
    function scanTextNodes(node) {
        if (!doc.body || !node || !node.parentNode || !doc.body.contains(node)) {
            return;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (EXCLUDE_TAGS.has(tag) || node.isContentEditable) {
                return;
            }

            Array.from(node.childNodes).forEach(scanTextNodes);
            return;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            if (shouldSkipTextNode(node)) {
                return;
            }

            let current = node;
            const boundary = current.nextSibling;
            while (current) {
                current = addRuby(current);
            }
            const ownedFragments = [];
            for (let e = node.nextSibling; e && e !== boundary; e = e.nextSibling) {
                ownedFragments.push(e);
            }
            if (ownedFragments.length > 0) {
                textNodeSnapshot.set(node, {
                    value: node.nodeValue,
                    ownedFragments
                });
            }
        }
    }

    // 递归地为文本节点插入 ruby 标签
    // 灵感来源：http://www.the-art-of-web.com/javascript/search-highlight/
    function addRuby(textNode) {
        const text = textNode.nodeValue;
        const match = findKatakanaMatch(text);
        if (!match) {
            textNodeSnapshot.set(textNode, { value: text || '' });
            return null;
        }

        for (let e = textNode; e !== null; e = e.parentNode) {
            if (e.nextSibling?.className === 'katakana-terminator-rt') {
                return null;
            }
        }

        const phrase = match.phrase;
        const ruby = doc.createElement('ruby');
        ruby.appendChild(doc.createTextNode(phrase));

        const rt = doc.createElement('rt');
        rt.classList.add('katakana-terminator-rt');
        ruby.appendChild(rt);

        enqueuePhrase(phrase, rt);

        // <span>[startカナmiddleテストend]</span> =>
        // <span>start<ruby>カナ<rt data-rt="Kana"></rt></ruby>[middleテストend]</span>
        const after = textNode.splitText(match.index);
        textNode.parentNode.insertBefore(ruby, after);
        after.nodeValue = after.nodeValue.substring(phrase.length);
        return after;
    }

    function requestTranslation(srcLang, destLang, phrases) {
        if (phrases.length === 0) {
            return;
        }

        translationProviders[config.backend].translate(srcLang, destLang, phrases);
    }

    // 将短语分批发送，控制单个 API 请求的长度
    function translateTextNodes() {
        let apiRequestCount = 0;
        let phraseCount = 0;
        let cacheHitCount = 0;
        const chunk = [];

        for (const phrase of queue.keys()) {
            phraseCount++;

            if (cache.has(phrase)) {
                updateRubyByCachedTranslations(phrase);
                cacheHitCount++;
                continue;
            }

            chunk.push(phrase);
            if (chunk.length >= CHUNK_SIZE) {
                apiRequestCount++;
                requestTranslation('ja', 'en', chunk.splice(0, chunk.length));
            }
        }

        if (chunk.length > 0) {
            apiRequestCount++;
            requestTranslation('ja', 'en', chunk);
        }

        if (phraseCount > 0) {
            const stats = cache.getStats();
            console.debug(
                'Katakana Terminator:', phraseCount, '个短语已翻译，',
                '共', cacheHitCount, '次缓存命中，', apiRequestCount, '次请求，',
                '缓存：', stats.count + '/' + (cache.maxSize > 0 ? cache.maxSize : '∞'),
                '(' + (stats.size / 1024).toFixed(1) + ' KB)，',
                '页面', window.location.href
            );
        }
    }

    function mutationHandler(mutationList) {
        mutationList.forEach((record) => {
            if (record.type === 'characterData') {
                releaseIfRewritten(record.target);
                return;
            }
            record.addedNodes.forEach((node) => pendingNodes.add(node));
        });
        scheduleRescan();
    }

    function releaseIfRewritten(target) {
        const snapshot = textNodeSnapshot.get(target);
        if (!snapshot) {
            return;
        }
        // 阻拦 splitText 触发的 characterData 且值未变的情况，避免死循环
        if (target.nodeValue === snapshot.value) {
            return;
        }
        snapshot.ownedFragments?.forEach((node) => node.remove());
        textNodeSnapshot.delete(target);
        pendingNodes.add(target);
    }

    function scheduleRescan() {
        if (flushTimer !== null) {
            return;
        }

        flushTimer = window.setTimeout(() => {
            flushTimer = null;
            rescanTextNodes();
        }, RESCAN_DELAY_MS);
    }

    function rescanTextNodes() {
        if (observer) {
            mutationHandler(observer.takeRecords());
        }

        if (pendingNodes.size === 0) {
            return;
        }

        const selectors = [...EXCLUDE_TAGS].join(',');
        const nodes = Array.from(pendingNodes).filter((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                if (!node.parentNode) {
                    return false;
                }
                node = node.parentNode;
            }
            return !node.closest?.(selectors) && !node.isContentEditable;
        });
        pendingNodes.clear();

        console.debug('Katakana Terminator:', nodes.length, '个新增节点，页面', window.location.href);
        nodes.forEach(scanTextNodes);
        translateTextNodes();
    }

    function isBrowserTranslated() {
        // Chrome：翻译后 documentElement 会带上 translated-ltr/translated-rtl 类
        if (doc.documentElement && (
            doc.documentElement.classList.contains('translated-ltr') ||
            doc.documentElement.classList.contains('translated-rtl')
        )) {
            return true;
        }

        // 浏览器：<html lang> 会被覆盖为译文语言
        if (originalHtmlLang !== null) {
            const currentLang = doc.documentElement.getAttribute('lang') || '';
            if (currentLang !== originalHtmlLang) {
                return true;
            }
        }

        return false;
    }

    function stopForBrowserTranslation() {
        translationWatchers.forEach((w) => w.disconnect());
        translationWatchers = [];

        if (observer) {
            observer.disconnect();
            observer = null;
        }

        if (flushTimer !== null) {
            window.clearTimeout(flushTimer);
            flushTimer = null;
        }

        pendingNodes.clear();
        queue.clear();
        console.info('Katakana Terminator: 检测到浏览器翻译，停止执行');
    }

    function main() {
        config = readConfig();
        registerConfigMenu();

        if (isBlockedByBlacklist(window.location.href)) {
            console.info('Katakana Terminator: 页面已列入黑名单，跳过执行', window.location.href);
            return;
        }

        // 记录原始 <html lang>，用于浏览器翻译检测。
        // 浏览器开始翻译时会把它覆盖为译文语言。
        originalHtmlLang = doc.documentElement.getAttribute('lang') || '';

        if (isBrowserTranslated()) {
            console.info('Katakana Terminator: 浏览器翻译已激活，跳过执行');
            return;
        }

        addStyle('rt.katakana-terminator-rt::before { content: attr(data-rt); }');

        // Chrome：监听 documentElement 上的 translated-ltr/translated-rtl 类
        const translationWatch = new MutationObserver(() => {
            if (isBrowserTranslated()) {
                stopForBrowserTranslation();
            }
        });
        translationWatch.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
        translationWatchers.push(translationWatch);

        // Firefox/Edge：监听 translationsId（确定性信号，HTML 翻译）
        const translationsId = new Set([
            'data-moz-translations-id',
            '_mstmutation', '_msttexthash', '_msthidden', '_msthash',
        ]);
        // 与 <html lang> 变化（早期信号，适用于所有翻译类型）
        const firefoxWatch = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (translationsId.has(mutation.attributeName)) {
                    stopForBrowserTranslation();
                    return;
                }
                if (mutation.attributeName === 'lang' && mutation.target === doc.documentElement) {
                    if (isBrowserTranslated()) {
                        stopForBrowserTranslation();
                        return;
                    }
                }
            }
        });
        firefoxWatch.observe(doc.documentElement, {
            attributes: true,
            subtree: true,
            attributeFilter: [...translationsId, 'lang'],
        });
        translationWatchers.push(firefoxWatch);

        // Prune expired cache entries on startup
        cache._pruneExpired();

        // Flush cache on page unload
        window.addEventListener('beforeunload', () => {
            cache.flush();
        });

        pendingNodes.add(doc.body);
        observer = new MutationObserver(mutationHandler);
        observer.observe(doc.body, { childList: true, subtree: true, characterData: true });

        // 首次扫描
        rescanTextNodes();
    }

    if (doc.body) {
        main();
    } else {
        window.addEventListener('DOMContentLoaded', main, { once: true });
    }
})();

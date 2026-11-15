// ==UserScript==
// @name        片假名终结者
// @name:ja  カタカナターミネーター
// @name:en     Katakana Terminator
// @name:ko-KR  가타카나 터미네이터
// @description 在网页中的日语外来语上方标注英文原词，并支持可配置的排除网址黑名单
// @author      Arnie97, Leimeng52mc, Izumiko
// @license     MIT
// @copyright   2017-2026, Katakana Terminator Contributors (https://github.com/Leimeng52mc/katakana-terminator/graphs/contributors)
// @namespace   https://github.com/Leimeng52mc
// @homepageURL https://github.com/Leimeng52mc/katakana-terminator
// @supportURL  https://github.com/Leimeng52mc/katakana-terminator/issues
// @icon        https://upload.wikimedia.org/wikipedia/commons/2/28/Ja-Ruby.png
// @match       *://*/*
// @run-at      document-idle
// @grant       GM.xmlHttpRequest
// @grant       GM_addStyle
// @grant       GM_registerMenuCommand
// @grant       GM_getValue
// @grant       GM_setValue
// @connect     translate.googleapis.com
// @connect     edge.microsoft.com
// @connect     *
// @version     2026.08.27
// @description:zh-CN 在网页中的日语外来语上方标注英文原词，并支持可配置的排除网址黑名单
// @description:ja ウェブページノニホンゴガイライゴノウエニエイゴゲンゴヲルビヒョウジ、オヨビカスタマイズカノウナジョガイURLブラックリスト
// @description:en Convert Japanese loanwords (gairaigo) on web pages back to English with ruby annotations, with a configurable exclusion blacklist
// @description:ko-KR 웹페이지의 일본어 외래어 위에 영어 원어를 루비로 표시하며, 제외 URL 블랙리스트를 설정할 수 있습니다
// ==/UserScript==

(() => {
    'use strict';

    const doc = document;
    const queue = new Map(); // 短语 -> Set<rt>
    const cache = new Map(); // 短语 -> 译文 | null（请求中）
    const pendingNodes = new Set();
    const textNodeSnapshot = new WeakMap();

    const EXCLUDE_TAGS = new Set([
        'ruby', 'script', 'style', 'noscript', 'select', 'textarea', 'input', 'option',
        'code', 'pre', 'kbd', 'samp',
    ]);
    const QUICK_KATAKANA_RE = /[\u30A1-\u30FF\uFF66-\uFF9F]/;
    const KATAKANA_CANDIDATE_RE = /[\u30A1-\u30FF\uFF66-\uFF9F]+/g;
    const MIN_PHRASE_LENGTH = 2;

    const CHUNK_SIZE = 200;
    const RESCAN_DELAY_MS = 200;
    const CONFIG_KEY = 'katakana-terminator-config-v1';
    const CONFIG_VERSION = 2.1;
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
        geminiApiKey: '',     // Gemini API key
        geminiApiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', // Gemini API endpoint
        geminiModel: 'gemini-2.0-flash-lite',
    };

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
            if (!translated) {
                cache.delete(phrase);
                return;
            }

            cache.set(phrase, translated);
            updateRubyByCachedTranslations(phrase);
        });
    }

    // Provider 契约：raw translate(srcLang, destLang, phrases) 必须返回与 phrases
    // 按索引对齐的译文数组（'' 表示无结果，可稍后重试），失败时抛出异常。
    function createTranslationProvider({ name, label, translate }) {
        return {
            name,
            label: label || name,
            async translate(srcLang, destLang, phrases) {
                // 请求完成前先标记在途，避免重复发起同一 HTTP 请求
                phrases.forEach((phrase) => {
                    cache.set(phrase, null);
                });

                try {
                    const translatedByIndex = await translate(srcLang, destLang, phrases);
                    applyTranslationsByIndex(phrases, translatedByIndex);
                } catch (err) {
                    handleTranslationFailure(name, err, phrases);
                }
            },
        };
    }

    // Edge 内置 AI 的本地翻译 API，https://learn.microsoft.com/zh-cn/microsoft-edge/web-platform/translator-api
    // 获取（或惰性创建）指定语言对的 Translator 会话；模型首次使用时需下载，之后常驻内存
    function getTranslatorSession(srcLang, destLang) {
        if (translatorSession && translatorSession.sourceLanguage === srcLang && translatorSession.targetLanguage === destLang) {
            return translatorSession.session;
        }

        const sessionPromise = (async () => {
            const availability = await Translator.availability({ sourceLanguage: srcLang, targetLanguage: destLang });
            if (availability === 'unavailable') {
                throw new Error(`当前浏览器不支持 Translator API（需要 Microsoft Edge 148+）：${srcLang} → ${destLang} 语言对不可用`);
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
            translate: (srcLang, destLang, phrases) => new Promise((resolve, reject) => {
                const joinedText = trimEnd(phrases.join('\n'));
                const api = 'https://translate.googleapis.com/translate_a/single';
                const params = {
                    client: 'gtx',
                    dt: 't',
                    sl: srcLang,
                    tl: destLang,
                    q: joinedText,
                };

                GM.xmlHttpRequest({
                    method: 'GET',
                    url: api + buildQueryString(params),
                    onload: (res) => {
                        if (res.status < 200 || res.status >= 300) {
                            reject(new Error(`请求失败：${res.status} ${res.statusText}`));
                            return;
                        }

                        let resp;
                        try {
                            resp = JSON.parse(res.responseText);
                        } catch (err) {
                            reject(new Error(`响应解析失败：${res.responseText}`));
                            return;
                        }

                        if (!Array.isArray(resp) || !Array.isArray(resp[0])) {
                            reject(new Error(`响应结构异常：${JSON.stringify(resp)}`));
                            return;
                        }

                        const translatedByOriginal = new Map();
                        resp[0].forEach((item) => {
                            const translated = item && item[0] ? trimEnd(item[0]) : '';
                            const original = item && item[1] ? trimEnd(item[1]) : '';
                            if (original && translated) {
                                translatedByOriginal.set(original, translated);
                            }
                        });

                        resolve(phrases.map((phrase) => translatedByOriginal.get(phrase) || ''));
                    },
                    onerror: (res) => {
                        reject(new Error(`请求出错：${res.statusText}`));
                    },
                });
            }),
        }),
        translator: createTranslationProvider({
            name: 'Translator',
            label: 'Edge 内置 AI（离线）',
            // 单个模型会话逐段翻译，无需网络请求；模型首次使用时自动下载
            translate: async (srcLang, destLang, phrases) => {
                if (typeof Translator === 'undefined') {
                    throw new Error('当前浏览器不支持 Translator API（需要 Microsoft Edge 148+）');
                }

                const session = await getTranslatorSession(srcLang, destLang);
                return Promise.all(phrases.map((phrase) => session.translate(phrase).then(trimEnd)));
            },
        }),
        gemini: createTranslationProvider({
            name: 'Gemini',
            label: 'Gemini API',
            translate: async (srcLang, destLang, phrases) => {
                // Build prompt
                const prompt = `
Please restore the following Japanese katakana terms into their original language words (no explanations). Return only the corresponding original word and language code for each katakana, one per line (response should not contain katakana terms):

${phrases.join('\n')}

Example request and response format:
Request:
ストレス
アルバイト
Response:
en: stress
de: arbeit
`;

                // Make API request
                const response = await sendRequest({
                    method: "POST",
                    url: config.geminiApiEndpoint,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.geminiApiKey}`
                    },
                    data: JSON.stringify({
                        model: config.geminiModel,
                        messages: [
                            { role: "system", content: "You are a multilingual scholar." },
                            { role: "user", content: prompt }
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
                        throw new Error('Gemini response does not match input count');
                    }
                } else {
                    throw new Error('Invalid Gemini response format');
                }
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
        const next = { ...DEFAULT_CONFIG };
        next.version = CONFIG_VERSION;
        if (input && TRANSLATION_BACKENDS.has(input.backend)) {
            next.backend = input.backend;
        }
        for (const key of ['geminiApiEndpoint', 'geminiModel', 'geminiApiKey']) {
            if (input && typeof input[key] === 'string') {
                next[key] = input[key];
            }
        }
        next.blacklist = sanitizeBlacklist(input && input.blacklist);
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

    function registerConfigMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
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
            .kt-config-body { padding: 16px 18px; display: grid; gap: 14px; }
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

        const geminiSettings = doc.createElement('div');
        geminiSettings.id = 'gemini-settings';
        geminiSettings.style.display = backendSelect.value === 'gemini' ? 'block' : 'none';
        body.appendChild(geminiSettings);

        for (const [name, id, key] of [
            ['API Endpoint (OpenAI-compatible):', 'kt-gemini-endpoint', 'geminiApiEndpoint'],
            ['Model:', 'kt-gemini-model', 'geminiModel'],
            ['Enter your API key', 'kt-gemini-key', 'geminiApiKey'],
        ]) {
            const item = doc.createElement('div');
            item.className = 'kt-config-item';

            const label = doc.createElement('label');
            label.className = 'kt-config-label';
            label.textContent = name;
            item.appendChild(label);

            const input = doc.createElement('input');
            input.id = id;
            input.type = key === 'geminiApiKey' ? 'password' : 'text';
            input.className = 'kt-config-select';
            input.value = config[key];
            item.appendChild(input);

            geminiSettings.appendChild(item);
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
            geminiSettings.style.display = backendSelect.value === 'gemini' ? 'block' : 'none';
        });
        cancelBtn.addEventListener('click', closeDialog);
        resetBtn.addEventListener('click', () => {
            backendSelect.value = DEFAULT_CONFIG.backend;
            geminiSettings.style.display = backendSelect.value === 'gemini' ? 'block' : 'none';
            geminiSettings.querySelector('#kt-gemini-endpoint').value = DEFAULT_CONFIG.geminiApiEndpoint;
            geminiSettings.querySelector('#kt-gemini-model').value = DEFAULT_CONFIG.geminiModel;
            geminiSettings.querySelector('#kt-gemini-key').value = DEFAULT_CONFIG.geminiApiKey;
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
                geminiApiEndpoint: geminiSettings.querySelector('#kt-gemini-endpoint').value,
                geminiModel: geminiSettings.querySelector('#kt-gemini-model').value,
                geminiApiKey: geminiSettings.querySelector('#kt-gemini-key').value,
                blacklist: blacklistTextarea.value,
            });

            writeConfig(next);

            console.info('Katakana Terminator: 配置已更新', {
                ...next,
                geminiApiKey: '*'.repeat(next.geminiApiKey.length),
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

    function isAsciiWordChar(char) {
        return !!char && /[0-9A-Za-z_]/.test(char);
    }

    function isValidKatakanaPhrase(phrase) {
        if (!phrase || phrase.length < MIN_PHRASE_LENGTH) {
            return false;
        }

        // 忽略纯标点型片段，如只含长音符
        if (/^[\u30FC\u30FB\u3099\u309A\uFF9E\uFF9F]+$/.test(phrase)) {
            return false;
        }

        // 至少包含一个基础片假名字符
        return /[\u30A1-\u30FA\u30FD-\u30FF\uFF66-\uFF9D]/.test(phrase);
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

            if (!isValidKatakanaPhrase(phrase)) {
                continue;
            }

            const prev = index > 0 ? text[index - 1] : '';
            const next = index + phrase.length < text.length ? text[index + phrase.length] : '';
            if (isAsciiWordChar(prev) || isAsciiWordChar(next)) {
                continue;
            }

            return { phrase, index };
        }

        return null;
    }

    function shouldSkipTextNode(textNode) {
        const text = textNode.nodeValue || '';
        if (!text.trim()) {
            textNodeSnapshot.set(textNode, text);
            return true;
        }

        const snapshot = textNodeSnapshot.get(textNode);
        if (snapshot === text) {
            return true;
        }

        if (!QUICK_KATAKANA_RE.test(text)) {
            textNodeSnapshot.set(textNode, text);
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

            node.childNodes.forEach(scanTextNodes);
            return;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            if (shouldSkipTextNode(node)) {
                return;
            }

            let current = node;
            while (current) {
                current = addRuby(current);
            }
        }
    }

    // 递归地为文本节点插入 ruby 标签
    // 灵感来源：http://www.the-art-of-web.com/javascript/search-highlight/
    function addRuby(textNode) {
        const text = textNode.nodeValue;
        const match = findKatakanaMatch(text);
        if (!match) {
            textNodeSnapshot.set(textNode, text || '');
            return null;
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
        const chunk = [];

        for (const phrase of queue.keys()) {
            phraseCount++;

            if (cache.has(phrase)) {
                updateRubyByCachedTranslations(phrase);
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
            console.debug('Katakana Terminator:', phraseCount, '个短语已翻译，共', apiRequestCount, '次请求，页面', window.location.href);
        }
    }

    function mutationHandler(mutationList) {
        mutationList.forEach((record) => {
            record.addedNodes.forEach((node) => pendingNodes.add(node));
        });
        scheduleRescan();
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

        const nodes = Array.from(pendingNodes);
        pendingNodes.clear();

        console.debug('Katakana Terminator:', nodes.length, '个新增节点，页面', window.location.href);
        nodes.forEach(scanTextNodes);
        translateTextNodes();
    }

    function isBrowserTranslated() {
        // Chrome/Edge：翻译后 body 会带上 translated-ltr/translated-rtl 类
        if (doc.body && (
            doc.body.classList.contains('translated-ltr') ||
            doc.body.classList.contains('translated-rtl')
        )) {
            return true;
        }

        // Firefox：<html lang> 会被覆盖为译文语言
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

        // 记录原始 <html lang>，用于 Firefox 翻译检测。
        // Firefox 开始翻译时会把它覆盖为译文语言。
        originalHtmlLang = doc.documentElement.getAttribute('lang') || '';

        if (isBrowserTranslated()) {
            console.info('Katakana Terminator: 浏览器翻译已激活，跳过执行');
            return;
        }

        addStyle('rt.katakana-terminator-rt::before { content: attr(data-rt); }');

        // Chrome/Edge：监听 body 上的 translated-ltr/translated-rtl 类
        const translationWatch = new MutationObserver(() => {
            if (isBrowserTranslated()) {
                stopForBrowserTranslation();
            }
        });
        translationWatch.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        translationWatchers.push(translationWatch);

        // Firefox：监听 data-moz-translations-id（确定性信号，HTML 翻译）
        // 与 <html lang> 变化（早期信号，适用于所有翻译类型）
        const firefoxWatch = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName === 'data-moz-translations-id') {
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
            attributeFilter: ['data-moz-translations-id', 'lang'],
        });
        translationWatchers.push(firefoxWatch);

        pendingNodes.add(doc.body);
        observer = new MutationObserver(mutationHandler);
        observer.observe(doc.body, { childList: true, subtree: true });

        // 首次扫描
        rescanTextNodes();
    }

    if (doc.body) {
        main();
    } else {
        window.addEventListener('DOMContentLoaded', main, { once: true });
    }
})();

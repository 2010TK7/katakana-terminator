// ==UserScript==
// @name        片假名终结者
// @name:ja  カタカナターミネーター
// @name:en     Katakana Terminator
// @name:ko-KR  가타카나 터미네이터
// @description 在网页中的日语外来语上方标注英文原词，并支持可配置的排除网址黑名单
// @author      Arnie97, Leimeng52mc
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
// @connect     api-edge.cognitive.microsofttranslator.com
// @version     2026.04.28
// @description:zh-CN 在网页中的日语外来语上方标注英文原词，并支持可配置的排除网址黑名单
// @description:ja ウェブページノニホンゴガイライゴノウエニエイゴゲンゴヲルビヒョウジ、オヨビカスタマイズカノウナジョガイURLブラックリスト
// @description:en Convert Japanese loanwords (gairaigo) on web pages back to English with ruby annotations, with a configurable exclusion blacklist
// @description:ko-KR 웹페이지의 일본어 외래어 위에 영어 원어를 루비로 표시하며, 제외 URL 블랙리스트를 설정할 수 있습니다
// ==/UserScript==

(() => {
    'use strict';

    const doc = document;
    const queue = new Map(); // phrase -> Set<rt>
    const cache = new Map(); // phrase -> translated text | null (in-flight)
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
    const CONFIG_VERSION = 2;
    const DEFAULT_CONFIG = {
        version: CONFIG_VERSION,
        backend: 'edge', // 'edge' | 'google'
        edgeFallbackToGoogle: true,
        blacklist: [
            '*://*.bilibili.com/*',
            '*://*.weibo.com/*',
            '*://*.xiaohongshu.com/*',
            '*://*.douyin.com/*',
            '*://*.kuaishou.com/*',
            '*://*.zhihu.com/*',
            '*://*.taobao.com/*',
            '*://*.tmall.com/*',
            '*://*.jd.com/*',
            '*://*.pinduoduo.com/*',
            '*://*.1688.com/*',
        ],
    };

    let observer = null;
    let flushTimer = null;
    let edgeAuthToken = null;
    let edgeAuthExpireAt = 0;
    let edgeAuthPromise = null;
    let config = { ...DEFAULT_CONFIG };

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
        if (input && (input.backend === 'edge' || input.backend === 'google')) {
            next.backend = input.backend;
        }
        if (input && typeof input.edgeFallbackToGoogle === 'boolean') {
            next.edgeFallbackToGoogle = input.edgeFallbackToGoogle;
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

            // Support wildcard patterns and plain URL substring rules.
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
            console.warn('Katakana Terminator: failed to read config', err);
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
                console.warn('Katakana Terminator: failed to write config', err);
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
            }
            .kt-config-dialog {
                width: min(560px, calc(100vw - 32px));
                border-radius: 14px;
                background: #fff;
                color: #1a1a1a;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
                overflow: hidden;
                font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            .kt-config-header {
                padding: 16px 18px;
                font-size: 17px;
                font-weight: 600;
                background: linear-gradient(120deg, #f4f8ff, #f8fff5);
                border-bottom: 1px solid #e9eef5;
            }
            .kt-config-body {
                padding: 16px 18px;
                display: grid;
                gap: 14px;
            }
            .kt-config-item {
                display: grid;
                gap: 8px;
            }
            .kt-config-label {
                font-size: 13px;
                font-weight: 600;
                color: #2a3d57;
            }
            .kt-config-help {
                font-size: 12px;
                color: #5b6b7f;
                line-height: 1.45;
            }
            .kt-config-select {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid #c9d3e3;
                border-radius: 8px;
                background: #fff;
                padding: 8px 10px;
                font-size: 14px;
            }
            .kt-config-check-wrap {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 14px;
            }
            .kt-config-footer {
                padding: 12px 18px 16px;
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                border-top: 1px solid #e9eef5;
                background: #fafcff;
            }
            .kt-config-btn {
                border: 1px solid #c7d2e0;
                border-radius: 8px;
                padding: 7px 12px;
                cursor: pointer;
                font-size: 13px;
                background: #fff;
                color: #1f2b3a;
            }
            .kt-config-btn-primary {
                border-color: #2c6bed;
                background: #2c6bed;
                color: #fff;
            }
            .kt-config-note {
                padding: 0 18px 14px;
                font-size: 12px;
                color: #5b6b7f;
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
        backendSelect.innerHTML = [
            '<option value="edge">Microsoft Edge (无密钥)</option>',
            '<option value="google">Google Translate</option>',
        ].join('');
        backendSelect.value = config.backend;
        backendItem.appendChild(backendSelect);

        const backendHelp = doc.createElement('div');
        backendHelp.className = 'kt-config-help';
        backendHelp.textContent = 'Edge 模式会自动获取临时 token；Google 模式直接使用公共接口。';
        backendItem.appendChild(backendHelp);
        body.appendChild(backendItem);

        const fallbackItem = doc.createElement('div');
        fallbackItem.className = 'kt-config-item';

        const fallbackWrap = doc.createElement('label');
        fallbackWrap.className = 'kt-config-check-wrap';
        const fallbackCheckbox = doc.createElement('input');
        fallbackCheckbox.type = 'checkbox';
        fallbackCheckbox.checked = !!config.edgeFallbackToGoogle;
        fallbackWrap.appendChild(fallbackCheckbox);
        fallbackWrap.appendChild(doc.createTextNode('Edge 失败时自动回退到 Google'));
        fallbackItem.appendChild(fallbackWrap);

        const fallbackHelp = doc.createElement('div');
        fallbackHelp.className = 'kt-config-help';
        fallbackHelp.textContent = '仅在后端选择 Edge 时生效。';
        fallbackItem.appendChild(fallbackHelp);
        body.appendChild(fallbackItem);

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
        blacklistHelp.textContent = '每行一个网址规则，支持 * 通配符。留空项和以 # 开头的行会被忽略。默认已包含常见中文站点与容易扰乱阅读的页面。';
        blacklistItem.appendChild(blacklistHelp);
        body.appendChild(blacklistItem);

        const footer = doc.createElement('div');
        footer.className = 'kt-config-footer';
        dialog.appendChild(footer);

        const resetBtn = doc.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'kt-config-btn';
        resetBtn.textContent = '恢复默认';

        const cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'kt-config-btn';
        cancelBtn.textContent = '取消';

        const saveBtn = doc.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'kt-config-btn kt-config-btn-primary';
        saveBtn.textContent = '保存';

        footer.appendChild(resetBtn);
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

        cancelBtn.addEventListener('click', closeDialog);
        resetBtn.addEventListener('click', () => {
            backendSelect.value = DEFAULT_CONFIG.backend;
            fallbackCheckbox.checked = DEFAULT_CONFIG.edgeFallbackToGoogle;
            blacklistTextarea.value = DEFAULT_CONFIG.blacklist.join('\n');
        });

        saveBtn.addEventListener('click', () => {
            const prevBackend = config.backend;
            const next = sanitizeConfig({
                backend: backendSelect.value,
                edgeFallbackToGoogle: !!fallbackCheckbox.checked,
                blacklist: blacklistTextarea.value,
            });

            writeConfig(next);

            if (prevBackend !== next.backend && next.backend === 'edge') {
                clearEdgeAuthToken();
            }

            console.info('Katakana Terminator: config updated', next);
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

        // Ignore punctuation-like runs such as only prolonged sound marks.
        if (/^[\u30FC\u30FB\u3099\u309A\uFF9E\uFF9F]+$/.test(phrase)) {
            return false;
        }

        // Must contain at least one base katakana character.
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

    // Recursively traverse the given node and its descendants (Depth-first search)
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

    // Recursively add ruby tags to text nodes
    // Inspired by http://www.the-art-of-web.com/javascript/search-highlight/
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

    // {"keyA": 1, "keyB": 2} => "?keyA=1&keyB=2"
    function buildQueryString(params) {
        return `?${Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')}`;
    }

    function updateRubyByCachedTranslations(phrase) {
        const translated = cache.get(phrase);
        if (!translated) {
            return;
        }

        const rtNodes = queue.get(phrase) || [];
        rtNodes.forEach((node) => {
            node.dataset.rt = translated;
        });
        queue.delete(phrase);
    }

    // Google Dictionary API, https://github.com/ssut/py-googletrans/issues/268
    function googleTranslate(srcLang, destLang, phrases) {
        // Prevent duplicate HTTP requests before the request completes
        phrases.forEach((phrase) => {
            cache.set(phrase, null);
        });

        const joinedText = phrases.join('\n').replace(/\s+$/, '');
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
                    console.error('Katakana Terminator: request failed', res.status, res.statusText);
                    phrases.forEach((phrase) => cache.delete(phrase));
                    return;
                }

                let resp;
                try {
                    resp = JSON.parse(res.responseText);
                } catch (err) {
                    console.error('Katakana Terminator: invalid response', res.responseText);
                    phrases.forEach((phrase) => cache.delete(phrase));
                    return;
                }

                if (!Array.isArray(resp) || !Array.isArray(resp[0])) {
                    console.error('Katakana Terminator: unexpected response shape', resp);
                    phrases.forEach((phrase) => cache.delete(phrase));
                    return;
                }

                resp[0].forEach((item) => {
                    const translated = ((item && item[0]) || '').replace(/\s+$/, '');
                    const original = ((item && item[1]) || '').replace(/\s+$/, '');
                    if (!original) {
                        return;
                    }
                    cache.set(original, translated);
                    updateRubyByCachedTranslations(original);
                });

                // Retry later for phrases not returned by API.
                phrases.forEach((phrase) => {
                    if (cache.get(phrase) === null) {
                        cache.delete(phrase);
                    }
                });
            },
            onerror: (res) => {
                console.error('Katakana Terminator: request error', res.statusText);
                phrases.forEach((phrase) => cache.delete(phrase));
            },
        });
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

    function parseJwtExpireAt(token) {
        try {
            const payload = token.split('.')[1];
            if (!payload) {
                return Date.now() + 8 * 60 * 1000;
            }

            const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
            const decoded = JSON.parse(window.atob(normalized));
            if (decoded && typeof decoded.exp === 'number') {
                // Refresh the token slightly before the server-side expiry.
                return decoded.exp * 1000 - 10 * 1000;
            }
        } catch (err) {
            console.warn('Katakana Terminator: failed to parse Edge token expiry', err);
        }

        return Date.now() + 8 * 60 * 1000;
    }

    async function getEdgeAuthToken() {
        if (edgeAuthToken && Date.now() < edgeAuthExpireAt) {
            return edgeAuthToken;
        }

        if (edgeAuthPromise) {
            return edgeAuthPromise;
        }

        edgeAuthPromise = sendRequest({
            method: 'GET',
            url: 'https://edge.microsoft.com/translate/auth',
        }).then((res) => {
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Edge auth failed: ${res.status} ${res.statusText}`);
            }

            const token = (res.responseText || '').trim();
            if (!token) {
                throw new Error('Edge auth returned empty token');
            }

            edgeAuthToken = token;
            edgeAuthExpireAt = parseJwtExpireAt(token);
            return token;
        }).finally(() => {
            edgeAuthPromise = null;
        });

        return edgeAuthPromise;
    }

    function clearEdgeAuthToken() {
        edgeAuthToken = null;
        edgeAuthExpireAt = 0;
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

    async function edgeTranslate(srcLang, destLang, phrases) {
        // Prevent duplicate HTTP requests before the request completes
        phrases.forEach((phrase) => {
            cache.set(phrase, null);
        });

        const endpoint = `https://api-edge.cognitive.microsofttranslator.com/translate${buildQueryString({
            'api-version': '3.0',
            from: srcLang,
            to: destLang,
            textType: 'plain',
        })}`;

        const requestBody = JSON.stringify(phrases.map((phrase) => ({ Text: phrase })));

        const doTranslate = async (token) => {
            const res = await sendRequest({
                method: 'POST',
                url: endpoint,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                data: requestBody,
            });

            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Edge translate failed: ${res.status} ${res.statusText}`);
            }

            let resp;
            try {
                resp = JSON.parse(res.responseText);
            } catch (err) {
                throw new Error('Edge translate returned invalid JSON');
            }

            if (!Array.isArray(resp)) {
                throw new Error('Edge translate returned unexpected response shape');
            }

            const translatedByIndex = resp.map((item) => {
                const translated = item && item.translations && item.translations[0] && item.translations[0].text;
                return translated ? String(translated).replace(/\s+$/, '') : '';
            });

            applyTranslationsByIndex(phrases, translatedByIndex);
        };

        try {
            const token = await getEdgeAuthToken();
            await doTranslate(token);
        } catch (err) {
            const message = String((err && err.message) || err || '');
            const mayTokenBeExpired = /401|403|auth|token/i.test(message);

            if (mayTokenBeExpired) {
                try {
                    clearEdgeAuthToken();
                    const refreshedToken = await getEdgeAuthToken();
                    await doTranslate(refreshedToken);
                    return;
                } catch (retryErr) {
                    console.error('Katakana Terminator: Edge retry failed', retryErr);
                }
            } else {
                console.error('Katakana Terminator: Edge request failed', err);
            }

            if (config.edgeFallbackToGoogle) {
                phrases.forEach((phrase) => cache.delete(phrase));
                googleTranslate(srcLang, destLang, phrases);
                return;
            }

            phrases.forEach((phrase) => cache.delete(phrase));
        }
    }

    function requestTranslation(srcLang, destLang, phrases) {
        if (phrases.length === 0) {
            return;
        }

        if (config.backend === 'edge') {
            edgeTranslate(srcLang, destLang, phrases);
            return;
        }

        googleTranslate(srcLang, destLang, phrases);
    }

    // Split word list into chunks to limit the length of API requests
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
            console.debug('Katakana Terminator:', phraseCount, 'phrases translated in', apiRequestCount, 'requests, frame', window.location.href);
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

        console.debug('Katakana Terminator:', nodes.length, 'new nodes were added, frame', window.location.href);
        nodes.forEach(scanTextNodes);
        translateTextNodes();
    }

    function main() {
        config = readConfig();
        registerConfigMenu();
        addStyle('rt.katakana-terminator-rt::before { content: attr(data-rt); }');

        if (isBlockedByBlacklist(window.location.href)) {
            console.info('Katakana Terminator: page is blacklisted, skip execution', window.location.href);
            return;
        }

        pendingNodes.add(doc.body);
        observer = new MutationObserver(mutationHandler);
        observer.observe(doc.body, { childList: true, subtree: true });

        // Initial scan
        rescanTextNodes();
    }

    if (doc.body) {
        main();
    } else {
        window.addEventListener('DOMContentLoaded', main, { once: true });
    }
})();

# Katakana Terminator 片假名终结者 カタカナ‌ターミネーター

一个用户脚本，在网页中识别日语片假名外来语，并在上方以 ruby 注音形式标注英文对应词。

本分支项目地址:
https://github.com/2010TK7/katakana-terminator

GreasyFork 页面:
https://greasyfork.org/scripts/607314

## 主要功能

1. 扫描网页文本节点，识别片假名词组。
2. 自动插入 `ruby + rt` 标注，不改动原文阅读顺序。
3. 支持多翻译后端
	- Microsoft Edge 翻译后端（无密钥模式）
	- Google Translate 翻译后端
	- Translator API 翻译后端（本地模型，离线可用，仅桌面版 Chrome 138+ / Edge 148+）
	- AI API 溯源后端（OpenAI 兼容接口，需配置 endpoint/模型/API key）
4. 翻译失败时仅在控制台输出提示，不会自动切换到其他后端。
5. 支持 Tampermonkey 图形化配置菜单，可切换后端与排除网址黑名单。
	- 黑名单支持 `*` 通配符，可精确控制脚本生效范围。
	- 如果切换到溯源后端，需配置模型 API 参数后才能使用。
6. 浏览器内置翻译激活时自动停止运行，避免 DOM 冲突。
7. 翻译结果缓存，减少重复请求；配置菜单支持一键清除翻译缓存。

## 本分支改动点

1. 继承 Izumiko 的 AI API 溯源后端支持，并可通过菜单弹窗（GUI）配置对应参数。
2. 继承 Izumiko 的持久缓存，减少重复请求。
3. 增加跨标签页的配置与缓存同步支持。
4. 增强注入检测与改写追踪，防止 ruby 堆叠、残留与漏标。
5. 修复上游分支导致的片假名匹配异常问题，还原本家的匹配逻辑。
6. 采用 leohearts 的中点切分逻辑。
7. 修复上游的浏览器内置翻译检测逻辑。

## 使用说明

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 访问 [GreasyFork 页面](https://greasyfork.org/scripts/607314)并点击「安装此脚本」。
3. 在 Tampermonkey 菜单中打开「Katakana Terminator: 翻译设置」。
4. 选择翻译后端和排除网址后保存，设置会持久化生效。

## 注意事项

1. 片假名不一定都来源于英语，翻译结果可能存在语义偏差。
	- 溯源后端会将片假名溯源至各自的语言，但溯源结果可能因模型而异。
2. Edge 免鉴权接口属于网页侧能力，稳定性可能随上游变化。
3. Google 或 Edge 在不同网络环境下可用性不同。
4. 该脚本会遍历文本节点，超大型动态页面可能带来额外性能开销。
5. 默认黑名单已包含邮箱、在线文档、聊天、支付等敏感页面；如需使用，可在设置里删除或修改。
6. 各翻译后端彼此独立，单个后端失败时只会提示错误，不会自动切换到其他后端。
7. 当浏览器内置翻译（Chrome/Edge 翻译功能）激活时，脚本会自动停止运行以避免冲突。

## 分支网络

1. 原项目仓库:
https://github.com/Arnie97/katakana-terminator
2. 上游分支仓库:
https://github.com/Leimeng52mc/katakana-terminator
3. 合入分支仓库:
https://github.com/Izumiko/katakana-terminator
4. 合入分支:
https://github.com/leohearts/katakana-terminator/tree/fix-middle-dot-ruby

## 声明

1. 本项目是一个 vibe coding 产物。
2. 许可证保持不变，继续使用 MIT License。

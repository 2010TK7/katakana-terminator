# Katakana Terminator 片假名终结者

一个用户脚本：在网页中识别日语片假名外来语，并在上方以 ruby 注音形式标注英文对应词。

本分支项目地址：
https://github.com/Leimeng52mc/katakana-terminator

GreasyFork 页面：
https://greasyfork.org/zh-CN/scripts/575335

## 主要功能

1. 扫描网页文本节点，识别片假名词组。
2. 自动插入 `ruby + rt` 标注，不改动原文阅读顺序。
3. 支持多翻译后端：
	- Microsoft Edge 翻译后端（无密钥模式）
	- Google 翻译后端
4. 支持失败回退策略：Edge 请求失败可自动回退到 Google。
5. 支持 Tampermonkey 图形化配置菜单：可切换后端与回退行为。

## 本分支改动点

1. 适配较新的 Tampermonkey API 用法与运行方式。
2. 增加 Edge 翻译后端支持，并保留 Google 后端。
3. 增加配置持久化与菜单弹窗（GUI）设置。
4. 优化请求与缓存流程，减少重复请求。

## 使用说明

1. 安装 Tampermonkey。
2. 访问 GreasyFork 页面并安装脚本：
	https://greasyfork.org/zh-CN/scripts/575335
3. 或手动导入并启用 `katakana-terminator.user.js`。
4. 在 Tampermonkey 菜单中打开“Katakana Terminator: 翻译设置”。
5. 选择翻译后端并保存，设置会持久化生效。

## 注意事项

1. 片假名不一定都来源于英语，翻译结果可能存在语义偏差。
2. Edge 无认证接口属于网页侧能力，稳定性可能随上游变化。
3. Google 或 Edge 在不同网络环境下可用性不同。
4. 该脚本会遍历文本节点，超大型动态页面可能带来额外性能开销。

## 原项目与作者

1. 原项目仓库：https://github.com/Arnie97/katakana-terminator
2. 原作者：Arnie97
3. 本分支维护者：Leimeng52mc

## 声明

1. 本项目是一个 vibe coding 产物。
2. 许可证保持不变，继续使用 MIT License。

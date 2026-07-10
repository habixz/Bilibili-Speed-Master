// ==UserScript==
// @name         B站倍速助手
// @namespace    /DBI/bilibili-speed-assistant
// @version      1.1.1
// @description  合并自定义倍速(支持两栏显示倍速菜单); 按视频记忆倍速(兼容 B 站站内跳转); 新增增减倍速快捷键
// @author       habixz
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/watchlater*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/festival/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /**
     * 这里集中定义所有存储键和脚本常量，避免后面散落魔法字符串.
     */
    const STORAGE_PREFIX = 'bilibili_speed_assistant_rate';
    const SETTINGS_KEY_RATES = 'speedAssistant_customRatesAndShortcuts';
    const SETTINGS_KEY_RATE_ADJUST_SHORTCUTS = 'speedAssistant_rateAdjustShortcuts';
    const SETTINGS_KEY_TWO_COLS = 'speedAssistant_twoCols';
    const SETTINGS_KEY_CONFIG_VERSION = 'speedAssistant_configVersion';
    const EXPIRE_MS = 24 * 60 * 60 * 1000;
    const LAYOUT_STYLE_ID = 'bilibili-speed-assistant-layout-style';
    const CUSTOM_ITEM_MARK = 'bilibiliSpeedAssistantCustom';
    const DEFAULT_PLAYBACK_RATE = 1;
    const MIN_PLAYBACK_RATE = 0.1;
    const MAX_PLAYBACK_RATE = 16;
    const PLAYBACK_RATE_ADJUST_STEP = 0.1;
    const BOOTSTRAP_RETRY_DELAY = 400;
    const BOOTSTRAP_RETRY_LIMIT = 20;
    const PLAYBACK_RATE_APPLY_RETRY_DELAYS = [0, 120, 320, 700, 1200, 1800];
    const CENTER_RATE_HINT_HIDE_DELAY = 650;
    const CENTER_RATE_HINT_REMOVE_DELAY = 900;
    const CURRENT_CONFIG_VERSION = 3;

    /**
     * 默认倍速和快捷键列表.
     * 这里表示“完整倍速菜单”，而不是“额外增加的倍速”。
     * 页面里最终显示哪些倍速，完全以这个列表和用户后续保存的配置为准.
     */
    const DEFAULT_CUSTOM_RATES = [
        { rate: 0.2, shortcut: '' },
        { rate: 0.5, shortcut: '' },
        { rate: 0.8, shortcut: '' },
        { rate: 1, shortcut: '' },
        { rate: 1.25, shortcut: '' },
        { rate: 1.5, shortcut: '' },
        { rate: 2, shortcut: '' },
        { rate: 2.5, shortcut: '' },
        { rate: 3, shortcut: '' },
        { rate: 4, shortcut: '' },
        { rate: 5, shortcut: '' },
    ];

    /**
     * 默认的“增加/减少倍速快捷键”。
     * 默认留空，表示由用户自己决定是否启用，以及如何分配按键。
     */
    const DEFAULT_RATE_ADJUST_SHORTCUTS = {
        increase: '',
        decrease: ''
    };

    /**
     * 旧版脚本里原本就是 B 站自带的基础倍速。
     * 当把旧“额外倍速”配置迁移到新“完整倍速菜单”语义时，需要把这些基础项补回来。
     */
    const LEGACY_BUILTIN_RATES = [
        { rate: 0.5, shortcut: '' },
        { rate: 0.75, shortcut: '' },
        { rate: 1, shortcut: '' },
        { rate: 1.25, shortcut: '' },
        { rate: 1.5, shortcut: '' },
        { rate: 2, shortcut: '' }
    ];

    /**
     * 尽量把可能出现的播放器结构都兜住.
     * 这里仍然优先匹配新版 B 站播放器的常见类名.
     */
    const SELECTORS = {
        video: [
            '.bpx-player-video-wrap video',
            '.bpx-player-container video',
            'video'
        ],
        rateButton: [
            '.bpx-player-ctrl-playbackrate',
            '.bpx-player-ctrl-btn.bpx-player-ctrl-playbackrate',
            '[class*="playbackrate"][class*="ctrl"]'
        ],
        rateMenu: [
            '.bpx-player-ctrl-playbackrate-menu',
            '[class*="playbackrate-menu"]:not([class*="playbackrate-menu-item"])'
        ],
        rateMenuItem: [
            '.bpx-player-ctrl-playbackrate-menu-item',
            '[class*="playbackrate-menu-item"]'
        ],
        rateResult: [
            '.bpx-player-ctrl-playbackrate-result',
            '[class*="playbackrate-result"]'
        ],
        playerContainer: [
            '.bpx-player-container',
            '.bpx-player-video-area',
            '.bpx-player-video-wrap'
        ]
    };

    /**
     * 所有运行期状态统一放在这里，便于管理“当前页面对应的视频”、“当前绑定的视频元素”
     * 以及“这次页面加载是否已经执行过自动恢复”等信息.
     */
    const state = {
        settings: loadSettings(),
        currentVideoKey: '',
        lastSavedRate: null,
        currentVideo: null,
        bootstrapTimer: null,
        resultTextSyncTimers: [],
        playbackRateApplyTimers: [],
        pendingPlaybackRateApply: {
            videoElement: null,
            targetRate: null
        },
        centerRateHintHost: null,
        centerRateHintElement: null,
        centerRateHintHideTimer: 0,
        centerRateHintRemoveTimer: 0,
        rateConfigDialogOverlay: null,
        rateAdjustShortcutDialogOverlay: null,
        dialogScrollLock: null,
        rateAdjustHoldTimer: 0,
        rateAdjustHoldAction: '',
        rateAdjustHoldShortcut: '',
        rateAdjustHoldStartedAt: 0,
        restoreMark: {
            videoKey: '',
            videoElement: null
        }
    };

    /**
     * 初始化顺序:
     * 1. 先计算当前页面的视频键和历史倍速.
     * 2. 注册菜单、键盘和路由监听.
     * 3. 清理过期记录.
     * 4. 立即尝试启动一次播放器接管逻辑.
     */
    state.currentVideoKey = buildCurrentVideoKey();
    state.lastSavedRate = loadSavedRate(state.currentVideoKey);
    registerMenuCommands();
    installShortcutListener();
    installRouteChangeListener();
    installDomObserver();
    cleanupExpiredRecords();
    scheduleBootstrap(0);

    /**
     * 读取脚本设置.
     * 自定义倍速用 GM 存储; 按视频记忆倍速继续用 localStorage，便于按页面隔离.
     */
    function loadSettings() {
        const storedConfigVersion = Number(GM_getValue(SETTINGS_KEY_CONFIG_VERSION, 0));
        let normalizedRates = normalizeRateConfigList(GM_getValue(SETTINGS_KEY_RATES, DEFAULT_CUSTOM_RATES));

        /**
         * 兼容旧版本“这里只存额外倍速”的配置语义。
         * 首次升级到新版时，把 B 站原生基础倍速补进配置里，再写回存储，避免用户升级后菜单突然缺项。
         */
        if (storedConfigVersion < CURRENT_CONFIG_VERSION) {
            normalizedRates = normalizeRateConfigList([
                ...LEGACY_BUILTIN_RATES,
                ...normalizedRates
            ]);
            GM_setValue(SETTINGS_KEY_RATES, normalizedRates);
            GM_setValue(SETTINGS_KEY_CONFIG_VERSION, CURRENT_CONFIG_VERSION);
        }

        return {
            customRates: normalizedRates,
            rateAdjustShortcuts: normalizeRateAdjustShortcutConfig(
                GM_getValue(SETTINGS_KEY_RATE_ADJUST_SHORTCUTS, DEFAULT_RATE_ADJUST_SHORTCUTS)
            ),
            twoCols: Boolean(GM_getValue(SETTINGS_KEY_TWO_COLS, 0))
        };
    }

    /**
     * 将数字倍速统一规整到两位小数，避免 2 / 2.0 / 2.00 因文本不同导致比较失败.
     * 返回 null 表示当前值不是合法倍速.
     *
     * @param {number|string} rate
     * @returns {number|null}
     */
    function normalizeRate(rate) {
        const parsedRate = Number(rate);
        if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
            return null;
        }
        return Number(parsedRate.toFixed(2));
    }

    /**
     * 把倍速格式化成菜单显示文本.
     * 对整数手动补成 1 位小数，保持和 B 站菜单常见的 2.0x / 3.0x 风格一致.
     *
     * @param {number|string} rate
     * @returns {string}
     */
    function formatRateLabel(rate) {
        const normalizedRate = normalizeRate(rate);
        if (normalizedRate === null) {
            return '';
        }
        return Number.isInteger(normalizedRate)
            ? `${normalizedRate.toFixed(1)}x`
            : `${normalizedRate}x`;
    }

    /**
     * 标准化快捷键字符串.
     * 这里支持:
     * - shift+3
     * - ctrl+5
     * - ctrl+shift+z
     * - alt+,
     *
     * 规则:
     * - 至少需要一个修饰键，避免和普通输入冲突太多.
     * - 最后一个片段视为主键，前面的片段只能是修饰键.
     *
     * @param {string} shortcut
     * @returns {string}
     */
    function normalizeShortcut(shortcut) {
        if (!shortcut) {
            return '';
        }

        const modifierAliasMap = {
            control: 'ctrl',
            cmd: 'meta',
            command: 'meta',
            option: 'alt'
        };
        const orderedModifiers = ['ctrl', 'alt', 'shift', 'meta'];
        const rawParts = String(shortcut)
            .split('+')
            .map((part) => part.trim().toLowerCase())
            .filter(Boolean);

        if (rawParts.length < 2) {
            return '';
        }

        const key = rawParts[rawParts.length - 1];
        if (!key) {
            return '';
        }

        const modifierSet = new Set();
        for (let i = 0; i < rawParts.length - 1; i += 1) {
            const rawModifier = modifierAliasMap[rawParts[i]] || rawParts[i];
            if (!orderedModifiers.includes(rawModifier)) {
                return '';
            }
            modifierSet.add(rawModifier);
        }

        if (modifierSet.size === 0) {
            return '';
        }

        return [...orderedModifiers.filter((modifier) => modifierSet.has(modifier)), key].join('+');
    }

    /**
     * 标准化允许“不带修饰键”的快捷键字符串。
     * 这个版本专门给“增减倍速快捷键”使用，因此不再强制要求必须带修饰键。
     *
     * @param {string} shortcut
     * @returns {string}
     */
    function normalizeShortcutAllowPlainKey(shortcut) {
        if (!shortcut) {
            return '';
        }

        const modifierAliasMap = {
            control: 'ctrl',
            cmd: 'meta',
            command: 'meta',
            option: 'alt'
        };
        const keyAliasMap = {
            '↑': 'arrowup',
            '↓': 'arrowdown',
            '←': 'arrowleft',
            '→': 'arrowright'
        };
        const orderedModifiers = ['ctrl', 'alt', 'shift', 'meta'];
        const rawParts = String(shortcut)
            .split('+')
            .map((part) => part.trim().toLowerCase())
            .filter(Boolean);

        if (rawParts.length === 0) {
            return '';
        }

        const key = keyAliasMap[rawParts[rawParts.length - 1]] || rawParts[rawParts.length - 1];
        if (!key) {
            return '';
        }

        const modifierSet = new Set();
        for (let i = 0; i < rawParts.length - 1; i += 1) {
            const rawModifier = modifierAliasMap[rawParts[i]] || rawParts[i];
            if (!orderedModifiers.includes(rawModifier)) {
                return '';
            }
            modifierSet.add(rawModifier);
        }

        return [...orderedModifiers.filter((modifier) => modifierSet.has(modifier)), key].join('+');
    }

    /**
     * 规整“增减倍速快捷键”配置。
     * 允许留空，留空就表示该方向暂时不启用。
     *
     * @param {{ increase?: string, decrease?: string } | null | undefined} rawConfig
     * @returns {{ increase: string, decrease: string }}
     */
    function normalizeRateAdjustShortcutConfig(rawConfig) {
        return {
            increase: normalizeShortcutAllowPlainKey(rawConfig?.increase || ''),
            decrease: normalizeShortcutAllowPlainKey(rawConfig?.decrease || '')
        };
    }

    /**
     * 查找某个快捷键是否已经被“固定切换到某个倍速”的快捷键占用。
     *
     * @param {{ rate: number|string, shortcut: string }[]} rateConfigList
     * @param {string} shortcut
     * @returns {number|null}
     */
    function findRateShortcutConflict(rateConfigList, shortcut) {
        if (!shortcut) {
            return null;
        }

        for (const { rate, shortcut: configuredShortcut } of rateConfigList) {
            if (normalizeShortcut(configuredShortcut) !== shortcut) {
                continue;
            }

            return normalizeRate(rate);
        }

        return null;
    }

    /**
     * 校验“增减倍速快捷键”自身是否冲突，以及是否和固定倍速快捷键撞车。
     *
     * @param {{ increase: string, decrease: string }} shortcutConfig
     * @param {{ rate: number|string, shortcut: string }[]} rateConfigList
     * @returns {{ ok: true } | { ok: false, message: string }}
     */
    function validateRateAdjustShortcutConfig(shortcutConfig, rateConfigList) {
        const normalizedConfig = normalizeRateAdjustShortcutConfig(shortcutConfig);

        if (
            normalizedConfig.increase
            && normalizedConfig.decrease
            && normalizedConfig.increase === normalizedConfig.decrease
        ) {
            return {
                ok: false,
                message: '“增加倍速”和“减少倍速”不能使用同一个快捷键。'
            };
        }

        const increaseConflictRate = findRateShortcutConflict(rateConfigList, normalizedConfig.increase);
        if (increaseConflictRate !== null) {
            return {
                ok: false,
                message: `“增加倍速”快捷键与 ${formatRateLabel(increaseConflictRate)} 的固定倍速快捷键冲突。`
            };
        }

        const decreaseConflictRate = findRateShortcutConflict(rateConfigList, normalizedConfig.decrease);
        if (decreaseConflictRate !== null) {
            return {
                ok: false,
                message: `“减少倍速”快捷键与 ${formatRateLabel(decreaseConflictRate)} 的固定倍速快捷键冲突。`
            };
        }

        return { ok: true };
    }

    /**
     * 校验固定倍速快捷键是否和当前“增减倍速快捷键”冲突。
     * 这样两个配置入口都能在保存前及时发现问题。
     *
     * @param {{ rate: number, shortcut: string }[]} rateConfigList
     * @param {{ increase: string, decrease: string }} adjustShortcutConfig
     * @returns {{ ok: true } | { ok: false, message: string }}
     */
    function validateRateConfigAgainstAdjustShortcuts(rateConfigList, adjustShortcutConfig) {
        const normalizedAdjustShortcutConfig = normalizeRateAdjustShortcutConfig(adjustShortcutConfig);

        for (const { rate, shortcut } of rateConfigList) {
            const normalizedShortcut = normalizeShortcut(shortcut);
            if (!normalizedShortcut) {
                continue;
            }

            if (normalizedShortcut === normalizedAdjustShortcutConfig.increase) {
                return {
                    ok: false,
                    message: `${formatRateLabel(rate)} 的固定倍速快捷键与“增加倍速”快捷键冲突。`
                };
            }

            if (normalizedShortcut === normalizedAdjustShortcutConfig.decrease) {
                return {
                    ok: false,
                    message: `${formatRateLabel(rate)} 的固定倍速快捷键与“减少倍速”快捷键冲突。`
                };
            }
        }

        return { ok: true };
    }

    /**
     * 规整并去重倍速配置.
     * 如果用户重复填写了同一个倍速，则以后出现的配置覆盖之前的配置.
     *
     * @param {{ rate: number|string, shortcut: string }[]} rawList
     * @returns {{ rate: number, shortcut: string }[]}
     */
    function normalizeRateConfigList(rawList) {
        const dedupedMap = new Map();

        (Array.isArray(rawList) ? rawList : []).forEach((item) => {
            const normalizedRate = normalizeRate(item?.rate);
            if (normalizedRate === null) {
                return;
            }

            const normalizedShortcut = normalizeShortcut(item?.shortcut || '');

            /**
             * 先删再设，目的是让重复项以“最后一次输入”为准，并移动到最终顺序的后面.
             */
            dedupedMap.delete(normalizedRate);
            dedupedMap.set(normalizedRate, {
                rate: normalizedRate,
                shortcut: normalizedShortcut
            });
        });

        /**
         * 统一按倍速从小到大排序。
         * 这样不论是默认配置、迁移后的旧配置，还是用户后续手动输入的新配置，
         * 页面菜单和再次打开编辑框时看到的顺序都会保持一致。
         */
        return [...dedupedMap.values()]
            .sort((left, right) => left.rate - right.rate);
    }

    /**
     * 把当前配置转成人类可编辑的字符串.
     * 例如: 0.1(shift+0), 3(shift+3), 5
     *
     * @param {{ rate: number, shortcut: string }[]} configList
     * @returns {string}
     */
    function rateConfigListToText(configList) {
        return configList
            .map(({ rate, shortcut }) => String(rate) + (shortcut ? `(${shortcut})` : ''))
            .join(', ');
    }

    /**
     * 把用户在 prompt 里输入的字符串转回脚本内部使用的数组结构.
     * 返回值设计成对象，是为了把错误原因和正确结果区分清楚.
     *
     * @param {string} text
     * @returns {{ ok: true, value: { rate: number, shortcut: string }[] } | { ok: false, error: string }}
     */
    function parseRateConfigText(text) {
        const itemRegexp = /^(\d+(?:\.\d+)?)\s*(?:\(([^)]+)\))?\s*$/i;
        const entries = String(text)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

        if (entries.length === 0) {
            return {
                ok: true,
                value: []
            };
        }

        const parsedList = [];

        for (const entry of entries) {
            const matched = itemRegexp.exec(entry);
            if (!matched) {
                return {
                    ok: false,
                    error: entry
                };
            }

            const parsedRate = normalizeRate(matched[1]);
            if (parsedRate === null) {
                return {
                    ok: false,
                    error: entry
                };
            }

            const rawShortcut = matched[2] || '';
            const normalizedShortcut = rawShortcut ? normalizeShortcut(rawShortcut) : '';

            if (rawShortcut && !normalizedShortcut) {
                return {
                    ok: false,
                    error: entry
                };
            }

            parsedList.push({
                rate: parsedRate,
                shortcut: normalizedShortcut
            });
        }

        return {
            ok: true,
            value: normalizeRateConfigList(parsedList)
        };
    }

    /**
     * 注册油猴菜单命令.
     * 这里保持和旧脚本相近的交互方式，避免你后续维护时还得适应一套全新的设置逻辑.
     */
    function registerMenuCommands() {
        GM_registerMenuCommand('编辑全部倍数和快捷键', editCustomRatesAndShortcuts);
        GM_registerMenuCommand('设置增减倍速快捷键', editRateAdjustShortcuts);
        GM_registerMenuCommand(
            `${state.settings.twoCols ? '[✔️已启用]' : '[❌已禁用]'} 将倍数列表分为两栏显示`,
            toggleTwoColumnMenu
        );
    }

    /**
     * 编辑完整倍速菜单和快捷键.
     * 保存后会立即更新当前页面的菜单和快捷键，无需强制刷新.
     */
    function editCustomRatesAndShortcuts() {
        openRateConfigDialog();
    }

    /**
     * 编辑“增加/减少倍速”快捷键。
     */
    function editRateAdjustShortcuts() {
        openRateAdjustShortcutDialog();
    }

    /**
     * 统一保存倍速配置并刷新当前页面 UI。
     * 这样“手动保存”和“重置为网页默认倍速”都能走同一条逻辑，避免后续行为不一致。
     *
     * @param {{ rate: number, shortcut: string }[]} configList
     * @param {string} successMessage
     */
    function saveRateConfig(configList, successMessage) {
        state.settings.customRates = normalizeRateConfigList(configList);
        GM_setValue(SETTINGS_KEY_RATES, state.settings.customRates);
        GM_setValue(SETTINGS_KEY_CONFIG_VERSION, CURRENT_CONFIG_VERSION);
        console.log('[B站倍速助手] 已保存完整倍速菜单和快捷键', state.settings.customRates);

        /**
         * 配置变更后，立刻重新尝试接管一次播放器，
         * 这样当前页面的倍速菜单会马上按最新列表完整重建.
         */
        scheduleBootstrap(0);
        alert(successMessage);
    }

    /**
     * 保存“增加/减少倍速快捷键”配置。
     *
     * @param {{ increase: string, decrease: string }} shortcutConfig
     * @param {string} successMessage
     */
    function saveRateAdjustShortcutConfig(shortcutConfig, successMessage) {
        state.settings.rateAdjustShortcuts = normalizeRateAdjustShortcutConfig(shortcutConfig);
        GM_setValue(SETTINGS_KEY_RATE_ADJUST_SHORTCUTS, state.settings.rateAdjustShortcuts);
        GM_setValue(SETTINGS_KEY_CONFIG_VERSION, CURRENT_CONFIG_VERSION);
        console.log('[B站倍速助手] 已保存增减倍速快捷键', state.settings.rateAdjustShortcuts);
        alert(successMessage);
    }

    /**
     * 确保自定义编辑弹窗只注入一次样式。
     * 这部分样式只服务于脚本自己的轻量配置面板，不会影响 B 站页面其他区域。
     */
    function ensureRateConfigDialogStyle() {
        if (document.getElementById('bilibili-speed-assistant-dialog-style')) {
            return;
        }

        GM_addStyle(`
            #bilibili-speed-assistant-dialog-style {}
            .bsa-rate-dialog-overlay {
                position: fixed;
                inset: 0;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, 0.45);
            }
            .bsa-rate-dialog {
                width: min(320px, calc(100vw - 32px));
                border-radius: 12px;
                background: #fff;
                color: #18191c;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
                padding: 20px;
                font-family: inherit;
            }
            .bsa-rate-dialog-title {
                margin: 0 0 12px;
                font-size: 18px;
                font-weight: 600;
            }
            .bsa-rate-dialog-desc {
                margin: 0 0 12px;
                font-size: 13px;
                line-height: 1.7;
                color: #61666d;
                white-space: pre-line;
            }
            .bsa-rate-dialog-textarea {
                width: 100%;
                min-height: 120px;
                resize: vertical;
                box-sizing: border-box;
                border: 1px solid #dcdfe6;
                border-radius: 8px;
                padding: 12px;
                font: 14px/1.6 Consolas, "Microsoft YaHei", monospace;
                color: #18191c;
                background: #fff;
            }
            .bsa-rate-dialog-form {
                display: grid;
                gap: 14px;
            }
            .bsa-rate-dialog-field {
                display: grid;
                gap: 6px;
            }
            .bsa-rate-dialog-field-inline {
                grid-template-columns: 75px minmax(0, 1fr);
                align-items: center;
                gap: 0px;
            }
            .bsa-rate-dialog-label {
                font-size: 14px;
                font-weight: 600;
                color: #18191c;
                white-space: nowrap;
            }
            .bsa-rate-dialog-label-accent {
                display: inline-block;
            }
            .bsa-rate-dialog-label-increase {
                color: #fb5a7a;
            }
            .bsa-rate-dialog-label-decrease {
                color: #3d7cff;
            }
            .bsa-rate-dialog-input {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid #dcdfe6;
                border-radius: 8px;
                padding: 10px 12px;
                font: 14px/1.5 Consolas, "Microsoft YaHei", monospace;
                color: #18191c;
                background: #fff;
            }
            .bsa-rate-dialog-input:focus,
            .bsa-rate-dialog-textarea:focus {
                outline: none;
                border-color: #00aeec;
                box-shadow: 0 0 0 3px rgba(0, 174, 236, 0.16);
            }
            .bsa-rate-dialog-input-increase:focus {
                border-color: #fb5a7a;
                box-shadow: 0 0 0 3px rgba(251, 90, 122, 0.16);
            }
            .bsa-rate-dialog-input-decrease:focus {
                border-color: #3d7cff;
                box-shadow: 0 0 0 3px rgba(61, 124, 255, 0.16);
            }
            .bsa-rate-dialog-hint {
                font-size: 12px;
                line-height: 1.6;
                color: #61666d;
                white-space: pre-line;
            }
            .bsa-rate-dialog-actions {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                margin-top: 16px;
            }
            .bsa-rate-dialog-button {
                border: 1px solid #dcdfe6;
                border-radius: 8px;
                padding: 8px 16px;
                background: #fff;
                color: #18191c;
                cursor: pointer;
                font-size: 14px;
            }
            .bsa-rate-dialog-button-primary {
                border-color: #00aeec;
                background: #00aeec;
                color: #fff;
            }
            .bsa-rate-dialog-button-danger {
                border-color: #fb7299;
                color: #fb7299;
            }
        `);

        /**
         * 给上面这段 GM_addStyle 生成的 style 节点补一个固定 id，
         * 方便后续判断样式是否已注入。
         */
        const latestStyleNode = [...document.querySelectorAll('style')]
            .reverse()
            .find((styleNode) => styleNode.textContent?.includes('.bsa-rate-dialog-overlay'));
        if (latestStyleNode) {
            latestStyleNode.id = 'bilibili-speed-assistant-dialog-style';
        }
    }

    /**
     * 中央倍速提示单独注入样式，避免和配置弹窗样式耦合在一起。
     * 提示层固定在播放器内部中央，不拦截任何鼠标事件。
     */
    function ensureCenterRateHintStyle() {
        if (document.getElementById('bilibili-speed-assistant-center-hint-style')) {
            return;
        }

        GM_addStyle(`
            #bilibili-speed-assistant-center-hint-style {}
            .bsa-center-rate-hint {
                position: absolute;
                inset: 0;
                z-index: 30;
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: none;
                opacity: 0;
                transition: opacity 180ms ease;
            }
            .bsa-center-rate-hint.is-visible {
                opacity: 1;
            }
            .bsa-center-rate-hint-badge {
                min-width: 88px;
                max-width: min(54vw, 196px);
                box-sizing: border-box;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 10px;
                padding: 8px 14px;
                background: rgba(0, 0, 0, 0.54);
                color: #fff;
                text-align: center;
                font: 600 18px/1.2 "Segoe UI", "Microsoft YaHei", sans-serif;
                letter-spacing: 0.02em;
                box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
                backdrop-filter: blur(6px);
                -webkit-backdrop-filter: blur(6px);
            }
        `);

        const latestStyleNode = [...document.querySelectorAll('style')]
            .reverse()
            .find((styleNode) => styleNode.textContent?.includes('.bsa-center-rate-hint'));
        if (latestStyleNode) {
            latestStyleNode.id = 'bilibili-speed-assistant-center-hint-style';
        }
    }

    /**
     * 关闭当前配置弹窗。
     */
    function closeRateConfigDialog() {
        if (!state.rateConfigDialogOverlay) {
            return;
        }

        state.rateConfigDialogOverlay.remove();
        state.rateConfigDialogOverlay = null;
        unlockDialogPageScroll();
    }

    /**
     * 关闭“增减倍速快捷键”配置弹窗。
     */
    function closeRateAdjustShortcutDialog() {
        if (!state.rateAdjustShortcutDialogOverlay) {
            return;
        }

        state.rateAdjustShortcutDialogOverlay.remove();
        state.rateAdjustShortcutDialogOverlay = null;
        unlockDialogPageScroll();
    }

    /**
     * 打开配置弹窗时锁住页面滚动，避免背景页面继续滚动穿透。
     */
    function lockDialogPageScroll() {
        if (state.dialogScrollLock) {
            return;
        }

        state.dialogScrollLock = {
            htmlOverflow: document.documentElement.style.overflow,
            bodyOverflow: document.body.style.overflow
        };
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
    }

    /**
     * 配置弹窗关闭后恢复页面滚动。
     */
    function unlockDialogPageScroll() {
        if (!state.dialogScrollLock) {
            return;
        }

        document.documentElement.style.overflow = state.dialogScrollLock.htmlOverflow;
        document.body.style.overflow = state.dialogScrollLock.bodyOverflow;
        state.dialogScrollLock = null;
    }

    /**
     * 打开完整倍速菜单编辑弹窗。
     * 这里改用自定义面板，是为了在同一个编辑入口里加入“重置”按钮。
     */
    function openRateConfigDialog() {
        closeRateAdjustShortcutDialog();
        closeRateConfigDialog();
        ensureRateConfigDialogStyle();

        const overlay = document.createElement('div');
        overlay.className = 'bsa-rate-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'bsa-rate-dialog';
        overlay.appendChild(dialog);

        const title = document.createElement('h3');
        title.className = 'bsa-rate-dialog-title';
        title.textContent = '编辑全部倍数和快捷键';
        dialog.appendChild(title);

        const description = document.createElement('p');
        description.className = 'bsa-rate-dialog-desc';
        description.textContent = '格式: 倍数1, 倍数2, 倍数3(快捷键)\n'
            + '示例: 0.5, 1, 1.5, 2, 3(ctrl+shift+7)\n'
            + '说明:\n'
            + '- 添加/删掉某个倍速后，页面里的对应项也会新增/消失\n'
            + '- 留空表示无任何倍速\n'
            + '- 点击“重置”会恢复成网页原始默认倍速';
        dialog.appendChild(description);

        const textarea = document.createElement('textarea');
        textarea.className = 'bsa-rate-dialog-textarea';
        textarea.value = rateConfigListToText(state.settings.customRates);
        dialog.appendChild(textarea);

        const actions = document.createElement('div');
        actions.className = 'bsa-rate-dialog-actions';
        dialog.appendChild(actions);

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'bsa-rate-dialog-button';
        cancelButton.textContent = '取消';
        actions.appendChild(cancelButton);

        const resetButton = document.createElement('button');
        resetButton.type = 'button';
        resetButton.className = 'bsa-rate-dialog-button bsa-rate-dialog-button-danger';
        resetButton.textContent = '重置';
        actions.appendChild(resetButton);

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'bsa-rate-dialog-button bsa-rate-dialog-button-primary';
        saveButton.textContent = '保存';
        actions.appendChild(saveButton);

        cancelButton.addEventListener('click', closeRateConfigDialog);
        dialog.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        saveButton.addEventListener('click', () => {
            const parsedResult = parseRateConfigText(textarea.value);
            if (!parsedResult.ok) {
                alert(`格式不正确，请检查这一段: \n${parsedResult.error}`);
                textarea.focus();
                return;
            }

            const shortcutValidationResult = validateRateConfigAgainstAdjustShortcuts(
                parsedResult.value,
                state.settings.rateAdjustShortcuts
            );
            if (!shortcutValidationResult.ok) {
                alert(shortcutValidationResult.message);
                textarea.focus();
                return;
            }

            closeRateConfigDialog();
            saveRateConfig(
                parsedResult.value,
                '已保存，当前页面会立即按你的完整倍速列表重建菜单.若页面结构尚未就绪，可手动再刷新一次.'
            );
        });

        resetButton.addEventListener('click', () => {
            const shouldReset = confirm('确定要重置为网页原始默认倍速吗？这会覆盖你当前自定义的倍速列表。');
            if (!shouldReset) {
                return;
            }

            closeRateConfigDialog();
            saveRateConfig(
                LEGACY_BUILTIN_RATES,
                '已重置为网页原始默认倍速，当前页面会立即重建倍速菜单。'
            );
        });

        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeRateConfigDialog();
                return;
            }

            if (event.key === 'Enter' && event.ctrlKey) {
                saveButton.click();
            }
        });

        document.body.appendChild(overlay);
        state.rateConfigDialogOverlay = overlay;
        lockDialogPageScroll();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    /**
     * 给快捷键输入框绑定“按键捕获”行为。
     *
     * @param {HTMLInputElement} input
     */
    function bindShortcutCaptureInput(input) {
        input.addEventListener('keydown', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.key === 'Escape') {
                input.blur();
                return;
            }

            if (event.key === 'Backspace' || event.key === 'Delete') {
                input.dataset.shortcutValue = '';
                input.value = '';
                return;
            }

            const normalizedShortcut = normalizeShortcutFromKeyboardEvent(event, false);
            if (!normalizedShortcut) {
                return;
            }

            input.dataset.shortcutValue = normalizedShortcut;
            input.value = formatShortcutDisplayText(normalizedShortcut);
        });
    }

    /**
     * 把某个快捷键输入框同步成“内部真实值 + 外部显示值”。
     * 这样方向键可以显示成箭头，但保存时仍然拿到标准化后的原始快捷键字符串。
     *
     * @param {HTMLInputElement} input
     * @param {string} shortcut
     */
    function setShortcutCaptureInputValue(input, shortcut) {
        const normalizedShortcut = normalizeRateAdjustShortcutConfig({
            increase: shortcut
        }).increase;
        input.dataset.shortcutValue = normalizedShortcut;
        input.value = formatShortcutDisplayText(normalizedShortcut);
    }

    /**
     * 读取快捷键输入框内部保存的真实快捷键值。
     *
     * @param {HTMLInputElement} input
     * @returns {string}
     */
    function getShortcutCaptureInputValue(input) {
        return normalizeShortcutAllowPlainKey(input.dataset.shortcutValue || input.value || '');
    }

    /**
     * 把内部使用的快捷键字符串格式化成更适合展示的文本。
     * 这里只影响输入框显示，不影响实际存储值和匹配逻辑。
     *
     * 例如：
     * - `arrowup` -> `↑`
     * - `ctrl+arrowleft` -> `ctrl+←`
     *
     * @param {string} shortcut
     * @returns {string}
     */
    function formatShortcutDisplayText(shortcut) {
        const normalizedShortcut = String(shortcut || '').trim().toLowerCase();
        if (!normalizedShortcut) {
            return '';
        }

        const displayAliasMap = {
            arrowup: '↑',
            arrowdown: '↓',
            arrowleft: '←',
            arrowright: '→'
        };

        return normalizedShortcut
            .split('+')
            .map((part) => displayAliasMap[part] || part)
            .join('+');
    }

    /**
     * 打开“增减倍速快捷键”设置面板。
     * 这里把“增加”和“减少”拆成两个独立输入框，避免和原来的倍速列表文本格式混在一起。
     */
    function openRateAdjustShortcutDialog() {
        closeRateConfigDialog();
        closeRateAdjustShortcutDialog();
        ensureRateConfigDialogStyle();

        const overlay = document.createElement('div');
        overlay.className = 'bsa-rate-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'bsa-rate-dialog';
        overlay.appendChild(dialog);

        const title = document.createElement('h3');
        title.className = 'bsa-rate-dialog-title';
        title.textContent = '设置增减倍速快捷键';
        dialog.appendChild(title);

        const form = document.createElement('div');
        form.className = 'bsa-rate-dialog-form';
        dialog.appendChild(form);

        const increaseField = document.createElement('div');
        increaseField.className = 'bsa-rate-dialog-field bsa-rate-dialog-field-inline';
        form.appendChild(increaseField);

        const increaseLabel = document.createElement('label');
        increaseLabel.className = 'bsa-rate-dialog-label bsa-rate-dialog-label-accent bsa-rate-dialog-label-increase';
        increaseLabel.textContent = '增加倍速 +';
        increaseField.appendChild(increaseLabel);

        const increaseInput = document.createElement('input');
        increaseInput.type = 'text';
        increaseInput.className = 'bsa-rate-dialog-input bsa-rate-dialog-input-increase';
        increaseInput.placeholder = '点击后按下组合键';
        increaseInput.readOnly = true;
        setShortcutCaptureInputValue(increaseInput, state.settings.rateAdjustShortcuts.increase);
        increaseField.appendChild(increaseInput);

        const decreaseField = document.createElement('div');
        decreaseField.className = 'bsa-rate-dialog-field bsa-rate-dialog-field-inline';
        form.appendChild(decreaseField);

        const decreaseLabel = document.createElement('label');
        decreaseLabel.className = 'bsa-rate-dialog-label bsa-rate-dialog-label-accent bsa-rate-dialog-label-decrease';
        decreaseLabel.textContent = '减少倍速 -';
        decreaseField.appendChild(decreaseLabel);

        const decreaseInput = document.createElement('input');
        decreaseInput.type = 'text';
        decreaseInput.className = 'bsa-rate-dialog-input bsa-rate-dialog-input-decrease';
        decreaseInput.placeholder = '点击后按下组合键';
        decreaseInput.readOnly = true;
        setShortcutCaptureInputValue(decreaseInput, state.settings.rateAdjustShortcuts.decrease);
        decreaseField.appendChild(decreaseInput);

        bindShortcutCaptureInput(increaseInput);
        bindShortcutCaptureInput(decreaseInput);

        const actions = document.createElement('div');
        actions.className = 'bsa-rate-dialog-actions';
        dialog.appendChild(actions);

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'bsa-rate-dialog-button';
        cancelButton.textContent = '取消';
        actions.appendChild(cancelButton);

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'bsa-rate-dialog-button bsa-rate-dialog-button-primary';
        saveButton.textContent = '保存';
        actions.appendChild(saveButton);

        cancelButton.addEventListener('click', closeRateAdjustShortcutDialog);
        dialog.addEventListener('click', (event) => {
            event.stopPropagation();
        });

        saveButton.addEventListener('click', () => {
            const nextShortcutConfig = normalizeRateAdjustShortcutConfig({
                increase: getShortcutCaptureInputValue(increaseInput),
                decrease: getShortcutCaptureInputValue(decreaseInput)
            });
            const validationResult = validateRateAdjustShortcutConfig(
                nextShortcutConfig,
                state.settings.customRates
            );
            if (!validationResult.ok) {
                alert(validationResult.message);
                return;
            }

            closeRateAdjustShortcutDialog();
            saveRateAdjustShortcutConfig(
                nextShortcutConfig,
                '已保存增减倍速快捷键，当前页面无需刷新即可生效。'
            );
        });

        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeRateAdjustShortcutDialog();
                return;
            }

            if (event.key === 'Enter' && event.ctrlKey) {
                saveButton.click();
            }
        });

        document.body.appendChild(overlay);
        state.rateAdjustShortcutDialogOverlay = overlay;
        lockDialogPageScroll();
        increaseInput.focus();
    }

    /**
     * 切换两栏菜单显示.
     * 样式在当前页面即时生效，同时也会写入 GM 配置.
     */
    function toggleTwoColumnMenu() {
        state.settings.twoCols = !state.settings.twoCols;
        GM_setValue(SETTINGS_KEY_TWO_COLS, state.settings.twoCols);
        scheduleBootstrap(0);
        alert(`${state.settings.twoCols ? '已启用' : '已禁用'}两栏显示，当前页面已尝试立即应用.`);
    }

    /**
     * 根据当前 URL 构造“视频唯一键”.
     * 这里不直接整段使用完整 URL，而是只保留真正影响播放器内容的路径和少量关键参数，
     * 从而规避 spm / from_source 等追踪参数导致同一视频生成多个不同缓存键的问题.
     *
     * @returns {string}
     */
    function buildCurrentVideoKey() {
        const url = new URL(location.href);
        const importantParams = ['p', 'bvid', 'avid', 'cid', 'oid', 'ep_id', 'season_id', 'business'];
        const normalizedSearch = importantParams
            .filter((key) => url.searchParams.has(key))
            .sort()
            .map((key) => `${key}=${url.searchParams.get(key)}`)
            .join('&');

        return `${STORAGE_PREFIX}:${url.pathname}${normalizedSearch ? `?${normalizedSearch}` : ''}`;
    }

    /**
     * 读取某个视频之前保存的倍速.
     * 没有记录时返回 null，表示“不要主动改动当前播放器倍速”，以保留 B 站原本的继承逻辑.
     *
     * @param {string} videoKey
     * @returns {number|null}
     */
    function loadSavedRate(videoKey) {
        const rawValue = localStorage.getItem(videoKey);
        if (!rawValue) {
            return null;
        }

        try {
            const parsedValue = JSON.parse(rawValue);
            const rate = normalizeRate(parsedValue.rate);
            const timestamp = Number(parsedValue.timestamp);

            if (!Number.isFinite(timestamp) || Date.now() - timestamp > EXPIRE_MS) {
                localStorage.removeItem(videoKey);
                return null;
            }

            return rate;
        } catch (error) {
            /**
             * 兼容你旧版脚本可能留下的纯数字字符串记录.
             * 这里读得出来就继续用，后续一旦再次保存就会被自动升级成 JSON 结构.
             */
            const legacyRate = normalizeRate(rawValue);
            return legacyRate;
        }
    }

    /**
     * 清理所有已经过期的倍速记录，防止 localStorage 积累越来越多的历史残留.
     */
    function cleanupExpiredRecords() {
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
            const storageKey = localStorage.key(index);
            if (!storageKey || !storageKey.startsWith(`${STORAGE_PREFIX}:`)) {
                continue;
            }

            const rawValue = localStorage.getItem(storageKey);
            if (!rawValue) {
                continue;
            }

            try {
                const parsedValue = JSON.parse(rawValue);
                const timestamp = Number(parsedValue.timestamp);

                if (!Number.isFinite(timestamp) || Date.now() - timestamp > EXPIRE_MS) {
                    localStorage.removeItem(storageKey);
                }
            } catch (error) {
                /**
                 * 旧格式没有时间戳，这里直接清掉，让后续只保留新格式.
                 */
                localStorage.removeItem(storageKey);
            }
        }
    }

    /**
     * 从一组选择器里找第一个存在的元素.
     *
     * @param {string[]} selectors
     * @returns {Element|null}
     */
    function queryFirst(selectors) {
        for (const selector of selectors) {
            const matchedElement = document.querySelector(selector);
            if (matchedElement) {
                return matchedElement;
            }
        }
        return null;
    }

    /**
     * 获取当前视频元素.
     * 这里明确要求是 HTMLVideoElement，避免把自定义元素壳子错当成真正可设置 playbackRate 的对象.
     *
     * @returns {HTMLVideoElement|null}
     */
    function findVideoElement() {
        for (const selector of SELECTORS.video) {
            const candidate = document.querySelector(selector);
            if (candidate instanceof HTMLVideoElement) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * 获取倍速菜单.
     *
     * @returns {HTMLElement|null}
     */
    function findPlaybackRateMenu() {
        const menu = queryFirst(SELECTORS.rateMenu);
        return menu instanceof HTMLElement ? menu : null;
    }

    /**
     * 获取倍速按钮.
     *
     * @returns {HTMLElement|null}
     */
    function findPlaybackRateButton() {
        const button = queryFirst(SELECTORS.rateButton);
        return button instanceof HTMLElement ? button : null;
    }

    /**
     * 获取“倍速”按钮上的文本区域，用于在脚本主动修改倍速时同步按钮显示.
     *
     * @returns {HTMLElement|null}
     */
    function findPlaybackRateResult() {
        const result = queryFirst(SELECTORS.rateResult);
        return result instanceof HTMLElement ? result : null;
    }

    /**
     * 获取播放器容器，中央提示优先挂在这里。
     * 这样提示会跟着视频区域一起移动，而不是固定在整页正中间。
     *
     * @returns {HTMLElement|null}
     */
    function findPlayerContainer() {
        const container = queryFirst(SELECTORS.playerContainer);
        return container instanceof HTMLElement ? container : null;
    }

    /**
     * 在视频中央显示当前倍速提示。
     * 这里只在“快捷键主动改动倍速”时调用，不干扰自动恢复历史倍速这类后台行为。
     *
     * @param {number|string} rate
     */
    function showCenterRateHint(rate) {
        const normalizedRate = normalizeRate(rate);
        if (normalizedRate === null) {
            return;
        }

        const playerContainer = findPlayerContainer();
        if (!playerContainer) {
            return;
        }

        ensureCenterRateHintStyle();

        /**
         * 提示层使用 absolute 定位，为了让它稳定覆盖在播放器内部，
         * 当宿主容器还是 static 时，这里补成 relative。
         */
        if (window.getComputedStyle(playerContainer).position === 'static') {
            playerContainer.style.position = 'relative';
        }

        if (state.centerRateHintHost && state.centerRateHintHost !== playerContainer) {
            state.centerRateHintElement?.remove();
            state.centerRateHintElement = null;
        }

        state.centerRateHintHost = playerContainer;

        if (!state.centerRateHintElement || !state.centerRateHintElement.isConnected) {
            const hint = document.createElement('div');
            hint.className = 'bsa-center-rate-hint';

            const badge = document.createElement('div');
            badge.className = 'bsa-center-rate-hint-badge';
            hint.appendChild(badge);

            playerContainer.appendChild(hint);
            state.centerRateHintElement = hint;
        }

        const badge = state.centerRateHintElement.querySelector('.bsa-center-rate-hint-badge');
        if (!(badge instanceof HTMLElement)) {
            return;
        }

        badge.textContent = `倍速 ${formatRateLabel(normalizedRate)}`;
        clearTimeout(state.centerRateHintHideTimer);
        clearTimeout(state.centerRateHintRemoveTimer);

        state.centerRateHintElement.classList.add('is-visible');

        state.centerRateHintHideTimer = window.setTimeout(() => {
            state.centerRateHintElement?.classList.remove('is-visible');
        }, CENTER_RATE_HINT_HIDE_DELAY);

        state.centerRateHintRemoveTimer = window.setTimeout(() => {
            state.centerRateHintElement?.remove();
            state.centerRateHintElement = null;
        }, CENTER_RATE_HINT_REMOVE_DELAY);
    }

    /**
     * 只同步“倍速按钮”上的文本，不碰菜单激活态。
     * 这个函数单独拆出来，是为了在需要时可以只修正显示文字，
     * 减少对菜单 hover 状态的额外干扰。
     *
     * @param {number|string} rate
     */
    function syncPlaybackRateResultText(rate) {
        const normalizedRate = normalizeRate(rate);
        if (normalizedRate === null) {
            return;
        }

        const resultNode = findPlaybackRateResult();
        if (resultNode) {
            resultNode.textContent = formatRateLabel(normalizedRate);
        }
    }

    /**
     * B 站有时会在播放器自身刷新 UI 时把 1x 文本改回“倍速”。
     * 这里做一个很轻量的延迟重同步，只修正显示文字，不反复重建菜单。
     *
     * @param {number|string} fallbackRate
     */
    function schedulePlaybackRateResultTextSync(fallbackRate) {
        state.resultTextSyncTimers.forEach((timerId) => clearTimeout(timerId));
        state.resultTextSyncTimers = [];

        [0, 80, 200].forEach((delay) => {
            const timerId = setTimeout(() => {
                const currentVideo = findVideoElement();
                const currentRate = normalizeRate(currentVideo?.playbackRate) ?? normalizeRate(fallbackRate);
                if (currentRate !== null) {
                    syncPlaybackRateResultText(currentRate);
                }
            }, delay);
            state.resultTextSyncTimers.push(timerId);
        });
    }

    /**
     * 清理“倍速应用重试”定时器。
     * 这里单独收口，是为了在用户快速连点切换倍速、播放器替换 video 节点、
     * 或站内切到下一个视频时，能立刻取消上一轮过期的强制写入。
     */
    function clearPendingPlaybackRateApply() {
        state.playbackRateApplyTimers.forEach((timerId) => clearTimeout(timerId));
        state.playbackRateApplyTimers = [];
        state.pendingPlaybackRateApply = {
            videoElement: null,
            targetRate: null
        };
    }

    /**
     * 带短时重试地设置倍速。
     * B 站播放器在刚打开视频后的 1~2 秒内，偶尔还会继续跑自己的初始化流程，
     * 导致脚本刚写进去的 playbackRate 又被页面逻辑覆盖回去。
     * 这里把“立即设置 + 短时间补写几次”收敛成统一入口，专门兜住这个时间窗口。
     *
     * @param {HTMLVideoElement|null} video
     * @param {number|string} targetRate
     */
    function applyPlaybackRateWithRetry(video, targetRate) {
        const normalizedTargetRate = normalizeRate(targetRate);
        if (!(video instanceof HTMLVideoElement) || normalizedTargetRate === null) {
            return;
        }

        clearPendingPlaybackRateApply();
        state.pendingPlaybackRateApply = {
            videoElement: video,
            targetRate: normalizedTargetRate
        };

        PLAYBACK_RATE_APPLY_RETRY_DELAYS.forEach((delay, index) => {
            const timerId = setTimeout(() => {
                const {
                    videoElement: pendingVideo,
                    targetRate: pendingTargetRate
                } = state.pendingPlaybackRateApply;

                /**
                 * 只允许“当前这轮仍然有效”的重试继续执行。
                 * 一旦用户改点了别的倍速，或者页面已经切到新 video，
                 * 旧定时器即使晚到，也不会再把倍速写回老目标值。
                 */
                if (
                    pendingVideo !== video
                    || pendingTargetRate !== normalizedTargetRate
                    || state.currentVideo !== video
                    || !video.isConnected
                ) {
                    return;
                }

                if (normalizeRate(video.playbackRate) !== normalizedTargetRate) {
                    video.playbackRate = normalizedTargetRate;
                } else {
                    syncRateMenuUI(normalizedTargetRate);
                }

                if (index === PLAYBACK_RATE_APPLY_RETRY_DELAYS.length - 1) {
                    clearPendingPlaybackRateApply();
                }
            }, delay);
            state.playbackRateApplyTimers.push(timerId);
        });
    }

    /**
     * 获取当前倍速菜单里的所有菜单项.
     * 限定在给定菜单内部查找，避免页面其他区域出现同类 class 时误判.
     *
     * @param {HTMLElement|null} menu
     * @returns {HTMLElement[]}
     */
    function getRateMenuItems(menu) {
        if (!menu) {
            return [];
        }

        return SELECTORS.rateMenuItem
            .flatMap((selector) => [...menu.querySelectorAll(selector)])
            .filter((element, index, array) => element instanceof HTMLElement && array.indexOf(element) === index);
    }

    /**
     * 从菜单项的 data-value 或文本中解析倍速.
     *
     * @param {HTMLElement} menuItem
     * @returns {number|null}
     */
    function parseRateFromMenuItem(menuItem) {
        if (menuItem.dataset.value) {
            const rateFromDataset = normalizeRate(menuItem.dataset.value);
            if (rateFromDataset !== null) {
                return rateFromDataset;
            }
        }

        const matched = menuItem.textContent?.replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)/);
        if (!matched) {
            return null;
        }

        return normalizeRate(matched[1]);
    }

    /**
     * 绑定当前视频的事件监听.
     * 如果页面重建了 video 元素，先解绑旧元素，避免重复保存和重复同步 UI.
     *
     * @param {HTMLVideoElement} video
     */
    function bindVideoEvents(video) {
        if (state.currentVideo && state.currentVideo !== video) {
            clearPendingPlaybackRateApply();
            state.currentVideo.removeEventListener('ratechange', handleRateChange);
            state.currentVideo.removeEventListener('loadedmetadata', handleVideoReload);
            state.currentVideo.removeEventListener('emptied', handleVideoReload);
        }

        video.removeEventListener('ratechange', handleRateChange);
        video.removeEventListener('loadedmetadata', handleVideoReload);
        video.removeEventListener('emptied', handleVideoReload);

        video.addEventListener('ratechange', handleRateChange);
        video.addEventListener('loadedmetadata', handleVideoReload);
        video.addEventListener('emptied', handleVideoReload);

        state.currentVideo = video;
    }

    /**
     * 当视频源重新加载时，再补做一次播放器接管.
     * 这在站内跳转但 video 节点复用的场景下很关键.
     */
    function handleVideoReload() {
        scheduleBootstrap(80);
    }

    /**
     * 同步菜单激活态和“倍速按钮”上的文本显示.
     * 这样不论倍速来自:
     * - 原生 B 站菜单点击
     * - 自定义菜单点击
     * - 快捷键
     * - 自动恢复
     * 都能让界面尽量保持一致.
     *
     * @param {number|string} rate
     */
    function syncRateMenuUI(rate) {
        const normalizedRate = normalizeRate(rate);
        if (normalizedRate === null) {
            return;
        }

        const menu = findPlaybackRateMenu();
        const menuItems = getRateMenuItems(menu);
        menuItems.forEach((menuItem) => {
            const itemRate = parseRateFromMenuItem(menuItem);
            menuItem.classList.toggle('bpx-state-active', itemRate === normalizedRate);
        });

        syncPlaybackRateResultText(normalizedRate);
        schedulePlaybackRateResultTextSync(normalizedRate);
    }

    /**
     * 根据当前显示模式，计算倍速菜单真正的渲染顺序。
     *
     * 规则:
     * - 单栏: 保持 B 站原本的“大在上，小在下”
     * - 两栏: 保持“左边整体更小，右边整体更大”，同时每一列内部仍然是“大在上，小在下”
     *
     * 例如升序为 [0.5, 0.75, 1, 1.25, 1.5, 2] 时:
     * - 单栏渲染顺序 => [2, 1.5, 1.25, 1, 0.75, 0.5]
     * - 两栏渲染顺序 => [1, 0.75, 0.5, 2, 1.5, 1.25]
     *
     * @param {number[]} sortedRates 已按从小到大排好的倍速数组
     * @returns {number[]}
     */
    function buildMenuRenderRates(sortedRates) {
        if (!state.settings.twoCols) {
            return [...sortedRates].sort((left, right) => right - left);
        }

        const rowCount = Math.ceil(sortedRates.length / 2);

        /**
         * 两栏模式使用 column + wrap，DOM 顺序会先填满左列，再填右列。
         * 所以这里先把数据拆成“左列”和“右列”，再把每一列内部改成降序，
         * 最终就能得到“左列更小、右列更大，且每列都是上大下小”的视觉顺序。
         */
        const leftColumnRates = sortedRates.slice(0, rowCount).reverse();
        const rightColumnRates = sortedRates.slice(rowCount).reverse();
        return [...leftColumnRates, ...rightColumnRates];
    }

    /**
     * 处理倍速变更.
     * 这里统一负责:
     * - 更新菜单高亮
     * - 保存当前视频的倍速记录
     * - 处理恢复到 1x 时删除缓存的规则
     *
     * @param {Event} event
     */
    function handleRateChange(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) {
            return;
        }

        const newRate = normalizeRate(video.playbackRate);
        if (newRate === null) {
            return;
        }

        syncRateMenuUI(newRate);
        state.restoreMark = {
            videoKey: state.currentVideoKey,
            videoElement: video
        };

        if (newRate === DEFAULT_PLAYBACK_RATE) {
            localStorage.removeItem(state.currentVideoKey);
            state.lastSavedRate = null;
            console.log('[B站倍速助手] 当前视频已恢复为 1x，已清除该视频的倍速记录');
            return;
        }

        state.lastSavedRate = newRate;
        localStorage.setItem(state.currentVideoKey, JSON.stringify({
            rate: newRate,
            timestamp: Date.now()
        }));
        console.log(`[B站倍速助手] 已记录当前视频倍速: ${newRate}x`);
    }

    /**
     * 按当前配置完整重建倍速菜单.
     * 这里不再把配置视为“额外倍速”，而是把它当成最终菜单的完整来源:
     * - 配置里有的倍速就显示
     * - 配置里没有的倍速就移除
     *
     * @param {HTMLElement} menu
     */
    function ensureCustomRateItems(menu) {
        const sortedRates = [...state.settings.customRates]
            .map(({ rate }) => normalizeRate(rate))
            .filter((rate) => rate !== null)
            .sort((left, right) => left - right);
        const desiredRates = buildMenuRenderRates(sortedRates);

        const existingMenuItems = getRateMenuItems(menu);
        const templateItem = existingMenuItems[0];

        /**
         * 先移除菜单中现有的所有倍速项，再完全按配置重建。
         * 这样删掉原生倍速时，它们也会真正从菜单里消失。
         */
        existingMenuItems.forEach((menuItem) => {
            menuItem.remove();
        });

        desiredRates.forEach((rate) => {
            const newItem = document.createElement('li');

            /**
             * 尽量复制当前菜单项的 class 结构，只去掉可能存在的激活态类，
             * 这样重建后的菜单仍能最大程度沿用 B 站原有样式.
             */
            newItem.className = templateItem
                ? templateItem.className.replace(/\bbpx-state-active\b/g, '').trim()
                : 'bpx-player-ctrl-playbackrate-menu-item';
            newItem.dataset.value = String(rate);
            newItem.dataset[CUSTOM_ITEM_MARK] = '1';
            newItem.textContent = formatRateLabel(rate);

            /**
             * 点击自定义菜单项时，直接改 video.playbackRate.
             * 原生菜单项本身也会触发播放器内部逻辑，而我们新增的菜单项没有这套内部接线，
             * 所以这里必须手动接管点击行为.
             */
            newItem.addEventListener('click', () => {
                const currentVideo = findVideoElement();
                if (!currentVideo) {
                    return;
                }

                applyPlaybackRateWithRetry(currentVideo, rate);
            });
            menu.appendChild(newItem);
        });
    }

    /**
     * 两栏样式根据当前倍速菜单项数量动态计算高度.
     * 关闭时直接移除样式节点，避免对页面产生多余影响.
     *
     * @param {HTMLElement|null} menu
     */
    function updateTwoColumnStyle(menu) {
        const existingStyle = document.getElementById(LAYOUT_STYLE_ID);
        if (!state.settings.twoCols) {
            existingStyle?.remove();
            return;
        }

        const itemCount = getRateMenuItems(menu).length;
        if (itemCount === 0) {
            return;
        }

        const rowCount = Math.ceil(itemCount / 2);
        const menuHeight = rowCount * 36;
        const cssText = `
            .bpx-player-ctrl-playbackrate.bpx-state-show .bpx-player-ctrl-playbackrate-menu {
                display: flex !important;
            }
            .bpx-player-ctrl-playbackrate-menu {
                display: none;
                flex-direction: column;
                flex-wrap: wrap;
                width: 140px;
                height: ${menuHeight}px;
            }
            .bpx-player-ctrl-playbackrate-menu-item {
                width: 70px;
                height: 36px;
            }
        `;

        if (existingStyle) {
            existingStyle.textContent = cssText;
            return;
        }

        const styleElement = document.createElement('style');
        styleElement.id = LAYOUT_STYLE_ID;
        styleElement.textContent = cssText;
        document.head.appendChild(styleElement);
    }

    /**
     * 根据当前配置把快捷键映射成 Map，便于 keydown 时 O(1) 查找.
     *
     * @returns {Map<string, number>}
     */
    function buildShortcutMap() {
        const shortcutMap = new Map();

        state.settings.customRates.forEach(({ rate, shortcut }) => {
            const normalizedShortcut = normalizeShortcut(shortcut);
            const normalizedRate = normalizeRate(rate);
            if (!normalizedShortcut || normalizedRate === null) {
                return;
            }

            shortcutMap.set(normalizedShortcut, normalizedRate);
        });

        return shortcutMap;
    }

    /**
     * 根据快捷键查找对应的“增减倍速动作”。
     *
     * @param {string} shortcut
     * @returns {'increase'|'decrease'|''}
     */
    function getRateAdjustActionByShortcut(shortcut) {
        const normalizedShortcut = normalizeShortcutAllowPlainKey(shortcut);
        if (!normalizedShortcut) {
            return '';
        }

        if (normalizedShortcut === state.settings.rateAdjustShortcuts.increase) {
            return 'increase';
        }

        if (normalizedShortcut === state.settings.rateAdjustShortcuts.decrease) {
            return 'decrease';
        }

        return '';
    }

    /**
     * 把目标倍速限制在合理区间内。
     * 这里保留到两位小数，避免 1.25 这类原本就存在的小数倍速被错误抹平。
     *
     * @param {number|string} rate
     * @returns {number|null}
     */
    function clampPlaybackRate(rate) {
        const normalizedRate = normalizeRate(rate);
        if (normalizedRate === null) {
            return null;
        }

        return normalizeRate(Math.min(Math.max(normalizedRate, MIN_PLAYBACK_RATE), MAX_PLAYBACK_RATE));
    }

    /**
     * 根据动作返回这次应该增减多少倍速。
     *
     * @param {'increase'|'decrease'} action
     * @returns {number}
     */
    function getPlaybackRateAdjustDelta(action) {
        return action === 'increase' ? PLAYBACK_RATE_ADJUST_STEP : -PLAYBACK_RATE_ADJUST_STEP;
    }

    /**
     * 按 0.1x 步长调整当前视频倍速。
     * 当前倍速来自哪里并不重要，因为这里直接基于真实的 `video.playbackRate` 继续细调。
     *
     * @param {'increase'|'decrease'} action
     * @returns {boolean}
     */
    function adjustCurrentPlaybackRate(action) {
        const video = findVideoElement();
        if (!video) {
            return false;
        }

        const currentRate = normalizeRate(video.playbackRate) ?? DEFAULT_PLAYBACK_RATE;
        const targetRate = clampPlaybackRate(currentRate + getPlaybackRateAdjustDelta(action));
        if (targetRate === null || targetRate === currentRate) {
            return false;
        }

        applyPlaybackRateWithRetry(video, targetRate);
        showCenterRateHint(targetRate);
        console.log(`[B站倍速助手] 已通过增减快捷键调整到 ${targetRate}x`);
        return true;
    }

    /**
     * 根据长按时长决定下一次连续调整的间隔。
     * 这里复用 `easeOutCubic`，让长按从“细调”自然过渡到“快速连发”。
     *
     * @param {number} heldDurationMs
     * @returns {number}
     */
    function getPlaybackRateAdjustHoldDelay(heldDurationMs) {
        const maxDelay = 180;
        const minDelay = 40;
        const accelerateDuration = 1100;
        const progress = Math.min(Math.max(heldDurationMs / accelerateDuration, 0), 1);
        const easedProgress = 1 - Math.pow(1 - progress, 3);
        return Math.round(maxDelay - (maxDelay - minDelay) * easedProgress);
    }

    /**
     * 停止当前增减倍速长按链路。
     */
    function stopRateAdjustHold() {
        clearTimeout(state.rateAdjustHoldTimer);
        state.rateAdjustHoldTimer = 0;
        state.rateAdjustHoldAction = '';
        state.rateAdjustHoldShortcut = '';
        state.rateAdjustHoldStartedAt = 0;
    }

    /**
     * 调度下一次长按连续调整。
     * 这里使用递归 `setTimeout`，这样每一轮都能基于当前长按时长重新计算间隔。
     */
    function scheduleNextRateAdjustHold() {
        if (!state.rateAdjustHoldAction) {
            return;
        }

        clearTimeout(state.rateAdjustHoldTimer);
        const heldDurationMs = Date.now() - state.rateAdjustHoldStartedAt;
        const delay = getPlaybackRateAdjustHoldDelay(heldDurationMs);

        state.rateAdjustHoldTimer = window.setTimeout(() => {
            if (!state.rateAdjustHoldAction) {
                return;
            }

            adjustCurrentPlaybackRate(/** @type {'increase'|'decrease'} */ (state.rateAdjustHoldAction));
            scheduleNextRateAdjustHold();
        }, delay);
    }

    /**
     * 开始处理“单击 + 长按加速”的增减倍速链路。
     *
     * @param {'increase'|'decrease'} action
     * @param {string} shortcut
     */
    function startRateAdjustHold(action, shortcut) {
        if (state.rateAdjustHoldShortcut === shortcut) {
            return;
        }

        stopRateAdjustHold();
        state.rateAdjustHoldAction = action;
        state.rateAdjustHoldShortcut = shortcut;
        state.rateAdjustHoldStartedAt = Date.now();

        adjustCurrentPlaybackRate(action);
        scheduleNextRateAdjustHold();
    }

    /**
     * 判断某次 keyup 是否应该终止当前长按调整。
     * 正常情况下，松开主键就会命中完整快捷键；
     * 如果用户先松修饰键，这里也要及时停掉，避免后台继续连发。
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function shouldStopRateAdjustHoldByKeyup(event) {
        if (!state.rateAdjustHoldShortcut) {
            return false;
        }

        const normalizedShortcut = normalizeShortcutFromKeyboardEvent(event, false);
        if (normalizedShortcut && normalizedShortcut === state.rateAdjustHoldShortcut) {
            return true;
        }

        if (event.key === 'Control' && state.rateAdjustHoldShortcut.includes('ctrl+')) {
            return true;
        }
        if (event.key === 'Alt' && state.rateAdjustHoldShortcut.includes('alt+')) {
            return true;
        }
        if (event.key === 'Shift' && state.rateAdjustHoldShortcut.includes('shift+')) {
            return true;
        }
        if (event.key === 'Meta' && state.rateAdjustHoldShortcut.includes('meta+')) {
            return true;
        }

        return false;
    }

    /**
     * 把 KeyboardEvent 里的按键转换成可和配置字符串对比的标准形式.
     * 对包含 shift 的符号键，需要回推成原始按键:
     * 例如 event.key 可能是 "#"，但我们希望匹配成 "3".
     *
     * @param {KeyboardEvent} event
     * @param {boolean} [requireModifier=true]
     * @returns {string}
     */
    function normalizeShortcutFromKeyboardEvent(event, requireModifier = true) {
        const keyAliasMap = {
            ' ': 'space',
            Spacebar: 'space',
            Escape: 'esc',
            Esc: 'esc',
            ArrowUp: 'arrowup',
            ArrowDown: 'arrowdown',
            ArrowLeft: 'arrowleft',
            ArrowRight: 'arrowright'
        };
        const shiftKeyMap = {
            '!': '1',
            '@': '2',
            '#': '3',
            '$': '4',
            '%': '5',
            '^': '6',
            '&': '7',
            '*': '8',
            '(': '9',
            ')': '0',
            '_': '-',
            '+': '=',
            '{': '[',
            '}': ']',
            '|': '\\',
            ':': ';',
            '"': '\'',
            '<': ',',
            '>': '.',
            '?': '/',
            '~': '`'
        };
        const rawKey = event.key;

        if (['Shift', 'Control', 'Alt', 'Meta'].includes(rawKey)) {
            return '';
        }

        let normalizedKey = keyAliasMap[rawKey] || rawKey.toLowerCase();

        if (event.shiftKey && shiftKeyMap[normalizedKey]) {
            normalizedKey = shiftKeyMap[normalizedKey];
        }

        const parts = [];
        if (event.ctrlKey) {
            parts.push('ctrl');
        }
        if (event.altKey) {
            parts.push('alt');
        }
        if (event.shiftKey) {
            parts.push('shift');
        }
        if (event.metaKey) {
            parts.push('meta');
        }

        if (!normalizedKey) {
            return '';
        }

        if (requireModifier && parts.length === 0) {
            return '';
        }

        parts.push(normalizedKey);
        return parts.join('+');
    }

    /**
     * 输入框、文本域、可编辑区域内不处理快捷键，
     * 否则用户改评论、搜视频、发弹幕时体验会很差.
     *
     * @param {EventTarget|null} target
     * @returns {boolean}
     */
    function shouldIgnoreShortcutTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }

        return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    }

    /**
     * 安装快捷键监听.
     * 配置发生变化后不需要重复安装，因为这里每次按键都会实时从 state.settings 重新构建映射.
     */
    function installShortcutListener() {
        const handleKeydown = (event) => {
            if (event.defaultPrevented || event.isComposing) {
                return;
            }

            if (shouldIgnoreShortcutTarget(event.target)) {
                return;
            }

            const adjustShortcut = normalizeShortcutFromKeyboardEvent(event, false);
            const rateAdjustAction = getRateAdjustActionByShortcut(adjustShortcut);
            if (rateAdjustAction) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                /**
                 * 原生 key repeat 不参与增减倍速，
                 * 否则会和脚本自己的缓动连发叠加，导致节奏失控。
                 */
                if (event.repeat) {
                    return;
                }

                startRateAdjustHold(rateAdjustAction, adjustShortcut);
                return;
            }

            const shortcut = normalizeShortcutFromKeyboardEvent(event);
            if (!shortcut) {
                return;
            }

            const shortcutMap = buildShortcutMap();
            const targetRate = shortcutMap.get(shortcut);
            if (targetRate === undefined) {
                return;
            }

            const video = findVideoElement();
            if (!video) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            applyPlaybackRateWithRetry(video, targetRate);
            showCenterRateHint(targetRate);
            console.log(`[B站倍速助手] 已通过快捷键切换到 ${targetRate}x`);
        };

        const handleKeyup = (event) => {
            if (shouldStopRateAdjustHoldByKeyup(event)) {
                stopRateAdjustHold();
            }
        };

        const handleForceStopHold = () => {
            stopRateAdjustHold();
        };

        window.addEventListener('keydown', handleKeydown, true);
        window.addEventListener('keyup', handleKeyup, true);
        window.addEventListener('blur', handleForceStopHold);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopRateAdjustHold();
            }
        });
    }

    /**
     * 只有在当前视频存在历史记录时才自动恢复倍速.
     * 如果没有历史记录，就完全不干预当前播放器的原生继承行为.
     *
     * @param {HTMLVideoElement} video
     */
    function restoreSavedRateIfNeeded(video) {
        if (state.lastSavedRate === null) {
            state.restoreMark = {
                videoKey: state.currentVideoKey,
                videoElement: video
            };
            console.log('[B站倍速助手] 当前视频没有历史倍速记录，保持播放器当前倍速不变');
            return;
        }

        if (
            state.restoreMark.videoKey === state.currentVideoKey
            && state.restoreMark.videoElement === video
        ) {
            return;
        }

        const targetRate = normalizeRate(state.lastSavedRate);
        if (targetRate === null) {
            return;
        }

        /**
         * 这里不再要求“历史倍速必须存在于当前菜单配置中”。
         * 因为新增了 0.1x 步长的增减快捷键后，用户完全可能把视频调到 1.3x / 1.4x / 1.6x
         * 这类不在菜单里的倍速。如果仍然沿用旧规则，这些倍速就会被记住但无法恢复。
         *
         * 因此现在只要缓存里的倍速本身合法，就允许恢复；
         * 如果菜单里没有对应项，界面只是不高亮任何菜单项，但“倍速按钮文本”和实际倍速仍会正确同步。
         *
         * 直接设置 video.playbackRate，由 ratechange 监听器负责统一做 UI 同步和记录更新。
         * 这样逻辑比“模拟鼠标点击播放器菜单”更简单，也更不容易被页面结构细节击穿。
         */
        applyPlaybackRateWithRetry(video, targetRate);

        state.restoreMark = {
            videoKey: state.currentVideoKey,
            videoElement: video
        };
        console.log(`[B站倍速助手] 已恢复当前视频倍速为 ${targetRate}x`);
    }

    /**
     * 主启动逻辑.
     * 每次页面初始化、DOM 变化、路由切换后，都会用这套流程重新确认:
     * - video 是否已经出现
     * - 倍速菜单是否已经出现
     * - 自定义倍速是否已经补进菜单
     * - 历史倍速是否已经恢复
     *
     * @param {number} attempt
     */
    function bootstrap(attempt) {
        const video = findVideoElement();
        const menu = findPlaybackRateMenu();

        if (!video && attempt < BOOTSTRAP_RETRY_LIMIT) {
            scheduleBootstrap(BOOTSTRAP_RETRY_DELAY, attempt + 1);
            return;
        }

        if (video) {
            bindVideoEvents(video);
            restoreSavedRateIfNeeded(video);
            syncRateMenuUI(video.playbackRate);
        }

        if (menu && video) {
            ensureCustomRateItems(menu);
            updateTwoColumnStyle(menu);
            syncRateMenuUI(video.playbackRate);
        }
    }

    /**
     * 用定时器做一个轻量的去抖，避免 DOM 频繁变化时重复执行 bootstrap.
     *
     * @param {number} delay
     * @param {number} attempt
     */
    function scheduleBootstrap(delay, attempt = 0) {
        clearTimeout(state.bootstrapTimer);
        state.bootstrapTimer = setTimeout(() => bootstrap(attempt), delay);
    }

    /**
     * 切换页面上下文.
     * B 站是 SPA，很多时候 URL 变了但页面没有整刷，所以这里要主动刷新当前视频键和历史倍速.
     */
    function refreshVideoContext() {
        const nextVideoKey = buildCurrentVideoKey();
        if (nextVideoKey === state.currentVideoKey) {
            return;
        }

        clearPendingPlaybackRateApply();
        state.currentVideoKey = nextVideoKey;
        state.lastSavedRate = loadSavedRate(nextVideoKey);
        state.restoreMark = {
            videoKey: '',
            videoElement: null
        };

        if (state.lastSavedRate === null) {
            console.log('[B站倍速助手] 检测到站内跳转，新视频没有历史倍速记录');
        } else {
            console.log(`[B站倍速助手] 检测到站内跳转，新视频将恢复为 ${state.lastSavedRate}x`);
        }

        scheduleBootstrap(120);
    }

    /**
     * 监听 history 和 popstate，适配 B 站站内无刷跳转.
     */
    function installRouteChangeListener() {
        const rawPushState = history.pushState;
        const rawReplaceState = history.replaceState;

        history.pushState = function (...args) {
            const result = rawPushState.apply(this, args);
            setTimeout(refreshVideoContext, 120);
            return result;
        };

        history.replaceState = function (...args) {
            const result = rawReplaceState.apply(this, args);
            setTimeout(refreshVideoContext, 120);
            return result;
        };

        window.addEventListener('popstate', () => {
            setTimeout(refreshVideoContext, 120);
        });
    }

    /**
     * DOM 观察器负责兜住“播放器晚于脚本加载”“站内切页时局部重建 DOM”等场景.
     * 这里只做轻量监听，实际处理仍然交给去抖后的 bootstrap.
     */
    function installDomObserver() {
        const observer = new MutationObserver(() => {
            scheduleBootstrap(150);
            refreshVideoContext();
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    /**
     * 仅供调试时快速查看当前定位到的关键节点.
     */
    console.log('[B站倍速助手] 初始化完成', {
        currentVideoKey: state.currentVideoKey,
        lastSavedRate: state.lastSavedRate,
        rateButton: findPlaybackRateButton(),
        rateMenu: findPlaybackRateMenu(),
        playerContainer: queryFirst(SELECTORS.playerContainer)
    });
})();

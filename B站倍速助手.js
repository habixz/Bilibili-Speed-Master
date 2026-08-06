// ==UserScript==
// @name         B站倍速助手
// @namespace    /DBI/bilibili-speed-assistant
// @version      1.3.0
// @description  完全自制倍速列表(支持两栏显示倍速菜单); 按视频/合集记忆倍速(兼容 B 站站内跳转); 新增增减倍速快捷键
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
    const RATE_ADJUST_REVERSE_RESET_WINDOW_MS = 100;
    const HREF_WATCH_ACTIVE_DELAY = 250;
    const HREF_WATCH_IDLE_DELAY = 1000;
    const HREF_WATCH_HIDDEN_DELAY = 3000;
    const CURRENT_CONFIG_VERSION = 4;

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
        ],
        collectionHeaderTitle: [
            '.video-pod__header .title[title="视频选集"]',
            '.video-pod__header .title',
            '[title="视频选集"]'
        ],
        collectionRoot: [
            '.video-pod',
            '[class*="video-pod"]',
            '.rcmd-tab'
        ],
        collectionItem: [
            '.video-pod__item[data-key]',
            '[class*="video-pod__item"][data-key]',
            '.simple-base-item[data-key]'
        ],
        collectionItemTitle: [
            '.title-txt',
            '.title'
        ],
        collectionCount: [
            '.video-pod__header .amt',
            '.amt'
        ]
    };

    /**
     * 所有运行期状态统一放在这里，便于管理“当前页面对应的视频”、“当前绑定的视频元素”
     * 以及“这次页面加载是否已经执行过自动恢复”等信息.
     */
    const state = {
        settings: loadSettings(),
        currentVideoKey: '',
        currentVideoContextId: '',
        lastSavedRate: null,
        currentVideo: null,
        bootstrapTimer: null,
        resultTextSyncTimers: [],
        playbackRateApplyTimers: [],
        pendingPlaybackRateApply: {
            videoElement: null,
            targetRate: null
        },
        pendingRestoreRate: {
            videoElement: null,
            targetRate: null
        },
        waitingForInitialRestore: false,
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
        lastRateAdjustAction: '',
        lastRateAdjustTriggeredAt: 0,
        multiShortcutResetTriggered: false,
        hrefWatchTimer: 0,
        hrefWatchLastObserved: location.href,
        hrefWatchIdleTicks: 0,
        videoContextRefreshTimer: 0,
        domObserver: null,
        observedPlayerScope: null,
        restoreMark: {
            videoContextId: '',
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
    state.currentVideoContextId = buildCurrentVideoContextId();
    state.lastSavedRate = loadSavedRate(state.currentVideoKey);
    registerMenuCommands();
    installShortcutListener();
    installRouteChangeListener();
    installDomObserver();
    cleanupExpiredRecords();
    scheduleBootstrap(0);

    /**
     * 读取脚本设置.
     * 自定义倍速用 GM 存储; 按视频/合集记忆倍速继续用 localStorage，便于按页面隔离.
     */
    function loadSettings() {
        const storedConfigVersion = Number(GM_getValue(SETTINGS_KEY_CONFIG_VERSION, 0));
        const normalizedRates = normalizeRateConfigList(GM_getValue(SETTINGS_KEY_RATES, DEFAULT_CUSTOM_RATES));

        /**
         * 当前版本重新回到“完整自制倍速列表”语义。
         * 这里不再自动把网页原生档位补进配置里，而是只把已有配置规整后写回，
         * 让菜单最终完全由脚本配置决定。
         */
        if (storedConfigVersion < CURRENT_CONFIG_VERSION) {
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
        GM_registerMenuCommand('编辑全部倍数(快捷键)', editCustomRatesAndShortcuts);
        GM_registerMenuCommand('设置增减倍速快捷键', editRateAdjustShortcuts);
        GM_registerMenuCommand(state.settings.twoCols ? '改为单栏倍速列表' : '改为两栏倍速列表', toggleTwoColumnMenu);
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
        console.log('[B站倍速助手] 已保存脚本倍速列表和快捷键', state.settings.customRates);

        /**
         * 配置变更后，立刻重新尝试接管一次播放器，
         * 这样当前页面会马上按最新配置重排菜单，并补充额外倍速项。
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
            + '- 当前倍速菜单完全由这里的列表决定\n'
            + '- 添加某个倍速后，页面里会新增对应项；删掉后，对应项会直接消失\n'
            + '- 留空表示菜单里不显示任何脚本倍速\n'
            + '- 点击“重置”会恢复成脚本内置默认倍速列表';
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
                '已保存，当前页面会立即按你的完整倍速列表重建菜单。'
            );
        });

        resetButton.addEventListener('click', () => {
            const shouldReset = confirm('确定要重置为脚本内置默认倍速列表吗？这会覆盖你当前自定义的倍速配置。');
            if (!shouldReset) {
                return;
            }

            closeRateConfigDialog();
            saveRateConfig(
                DEFAULT_CUSTOM_RATES,
                '已重置为脚本默认倍速列表，当前页面会立即重建倍速菜单。'
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
        alert(`当前已切换为${state.settings.twoCols ? '两栏倍速列表' : '单栏倍速列表'}，当前页面已尝试立即应用。`);
    }

    /**
     * 规整要拼进缓存键里的文本，避免换行、连续空格等页面噪音把同一合集拆成多个键。
     *
     * @param {string|null|undefined} text
     * @returns {string}
     */
    function normalizeTextForStorageKey(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
    }

    /**
     * 根据当前 URL 构造“单视频唯一键”。
     * 当页面没有检测到合集列表时，继续沿用这个粒度，保证不同普通视频彼此隔离。
     *
     * @returns {string}
     */
    function buildStandaloneVideoKey() {
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
     * 构造“当前具体这一个视频内容”的上下文标识。
     *
     * 和 `buildCurrentVideoKey` 的区别是：
     * - `buildCurrentVideoKey` 用来决定“历史倍速存到哪一份”
     * - 这里用来决定“当前是不是已经切到另一条分 P / 另一集内容了”
     *
     * 因此这里会保留 `p`、`ep_id`、`cid` 等能区分具体视频内容的字段，
     * 用来修复“合集内切换但视频元素复用，导致恢复逻辑不重新执行”的问题。
     *
     * @returns {string}
     */
    function buildCurrentVideoContextId() {
        return buildStandaloneVideoKey();
    }

    /**
     * 找到页面里的“视频选集”区域根节点。
     *
     * 这里不用只盯死某一个 class，而是先确认标题确实是“视频选集”，
     * 再向上找合集容器。这样即使 B 站以后小改一层壳，也更容易继续命中。
     *
     * @returns {HTMLElement|null}
     */
    function findCollectionListRoot() {
        for (const selector of SELECTORS.collectionHeaderTitle) {
            const matchedElements = document.querySelectorAll(selector);
            for (const matchedElement of matchedElements) {
                if (!(matchedElement instanceof HTMLElement)) {
                    continue;
                }

                const titleText = normalizeTextForStorageKey(
                    matchedElement.getAttribute('title') || matchedElement.textContent
                );
                if (titleText !== '视频选集') {
                    continue;
                }

                for (const rootSelector of SELECTORS.collectionRoot) {
                    const collectionRoot = matchedElement.closest(rootSelector);
                    if (collectionRoot instanceof HTMLElement) {
                        return collectionRoot;
                    }
                }
            }
        }

        return null;
    }

    /**
     * 给合集页面做一个“页面家族”标签。
     * 如果后面拿不到足够稳定的合集特征，就退一步按这个家族共享倍速，
     * 这样至少能做到“合集页之间继承”，不会退回到完全按单视频隔离。
     *
     * @returns {string}
     */
    function getCollectionPageFamily() {
        const { pathname } = location;
        if (pathname.startsWith('/bangumi/')) {
            return 'bangumi';
        }
        if (pathname.startsWith('/festival/')) {
            return 'festival';
        }
        if (pathname.startsWith('/list/watchlater')) {
            return 'watchlater';
        }
        if (pathname.startsWith('/list/')) {
            return 'list';
        }
        return 'video';
    }

    /**
     * 对于普通 BV 视频页，只要页面里存在“视频选集”区域，
     * 就可以直接把 `p` 视为同一合集内部的分 P 序号。
     *
     * 也就是说：
     * - `.../video/BVxxxx`
     * - `.../video/BVxxxx?p=2`
     * - `.../video/BVxxxx?p=19`
     * 都归到同一个合集作用域里
     *
     * 这比依赖 DOM 列表内容去拼指纹更直接，也更稳定。
     *
     * @returns {string}
     */
    function buildCollectionScopeKeyFromUrl() {
        const url = new URL(location.href);
        if (!url.pathname.startsWith('/video/')) {
            return '';
        }

        const importantParams = ['bvid', 'avid', 'season_id', 'business'];
        const normalizedSearch = importantParams
            .filter((key) => url.searchParams.has(key))
            .sort()
            .map((key) => `${key}=${url.searchParams.get(key)}`)
            .join('&');

        return `collection:url:${url.pathname}${normalizedSearch ? `?${normalizedSearch}` : ''}`;
    }

    /**
     * 从“视频选集”区域提取尽量稳定的合集指纹。
     *
     * 优先使用列表项的 `data-key`，因为它通常比标题文本更稳定；
     * 如果拿不到，再退到“选集总数 + 前几个标题样本”。
     * 最后如果页面只露出了“这里有选集区域”但拿不到更多特征，
     * 就退化成“同类合集页面共用一个键”。
     *
     * @returns {string}
     */
    function buildCollectionScopeKey() {
        const collectionScopeKeyFromUrl = buildCollectionScopeKeyFromUrl();
        if (collectionScopeKeyFromUrl) {
            return collectionScopeKeyFromUrl;
        }

        const collectionRoot = findCollectionListRoot();
        if (!collectionRoot) {
            return '';
        }

        const pageFamily = getCollectionPageFamily();
        let countText = '';
        for (const selector of SELECTORS.collectionCount) {
            const countElement = collectionRoot.querySelector(selector);
            if (countElement instanceof HTMLElement) {
                countText = normalizeTextForStorageKey(countElement.textContent);
                break;
            }
        }
        const itemNodes = SELECTORS.collectionItem
            .flatMap((selector) => [...collectionRoot.querySelectorAll(selector)])
            .filter((element, index, array) => element instanceof HTMLElement && array.indexOf(element) === index)
            .slice(0, 12);
        const itemKeys = itemNodes
            .map((itemNode) => normalizeTextForStorageKey(itemNode.dataset.key))
            .filter(Boolean);

        if (itemKeys.length > 0) {
            return `collection:${pageFamily}:keys:${countText}:${itemKeys.join(',')}`;
        }

        const titleSamples = itemNodes
            .map((itemNode) => {
                for (const selector of SELECTORS.collectionItemTitle) {
                    const titleNode = itemNode.querySelector(selector);
                    if (titleNode instanceof HTMLElement) {
                        return normalizeTextForStorageKey(titleNode.textContent);
                    }
                }
                return '';
            })
            .filter(Boolean)
            .slice(0, 6);

        if (titleSamples.length > 0) {
            return `collection:${pageFamily}:titles:${countText}:${titleSamples.join('|')}`;
        }

        return `collection:${pageFamily}:fallback`;
    }

    /**
     * 根据当前页面上下文构造缓存键。
     *
     * 规则改成：
     * - 没有“视频选集”区域时：按单视频记忆
     * - 有“视频选集”区域时：优先按合集指纹记忆
     * - 如果合集指纹提取不完整：退一步让同类合集页共享倍速
     *
     * 这样就能尽量满足：
     * - 同一个视频刷新后倍速不变
     * - 不同普通视频互不干扰
     * - 合集内不同视频尽量继承倍速
     *
     * @returns {string}
     */
    function buildCurrentVideoKey() {
        const collectionScopeKey = buildCollectionScopeKey();
        if (collectionScopeKey) {
            return `${STORAGE_PREFIX}:${collectionScopeKey}`;
        }

        return buildStandaloneVideoKey();
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
             * 这里一旦读得出来，就立即升级成带时间戳的新格式，
             * 避免“本次会话先读取旧值，随后 cleanup 又把旧记录删掉”的时序分裂。
             */
            const legacyRate = normalizeRate(rawValue);
            if (legacyRate !== null) {
                localStorage.setItem(videoKey, JSON.stringify({
                    rate: legacyRate,
                    timestamp: Date.now()
                }));
            }
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
        /**
         * 合集内切换分 P 时，B 站经常会复用同一个 video 元素，只是替换媒体源。
         * 如果这里不把“本轮已经恢复过”的标记清掉，后续 bootstrap 可能会误以为
         * 当前这条新视频已经恢复完成，从而跳过真正需要的倍速恢复。
         */
        state.restoreMark = {
            videoContextId: '',
            videoElement: null
        };
        state.pendingRestoreRate = {
            videoElement: null,
            targetRate: null
        };
        state.waitingForInitialRestore = true;
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
     * 立即把当前视频的倍速写入“按视频记忆”缓存。
     *
     * 这里和 `handleRateChange` 里的持久化逻辑共用同一入口，目的是让：
     * - 脚本主动改倍速时，记录立刻落盘，不再完全依赖浏览器后续是否触发 `ratechange`
     * - 同一个视频刷新页面后，能够稳定按 1 天有效期恢复
     * - 不同视频之间仍然彼此隔离，不会串倍速
     *
     * @param {number|string} rate
     * @param {HTMLVideoElement|null} video
     */
    function persistRateForCurrentVideo(rate, video) {
        const normalizedRate = normalizeRate(rate);
        if (!state.currentVideoKey || normalizedRate === null) {
            return;
        }

        state.restoreMark = {
            videoContextId: state.currentVideoContextId,
            videoElement: video instanceof HTMLVideoElement ? video : null
        };

        if (normalizedRate === DEFAULT_PLAYBACK_RATE) {
            localStorage.removeItem(state.currentVideoKey);
            state.lastSavedRate = null;
            console.log('[B站倍速助手] 当前视频已恢复为 1x，已清除该视频的倍速记录');
            return;
        }

        state.lastSavedRate = normalizedRate;
        localStorage.setItem(state.currentVideoKey, JSON.stringify({
            rate: normalizedRate,
            timestamp: Date.now()
        }));
        console.log(`[B站倍速助手] 已记录当前视频倍速: ${normalizedRate}x`);
    }

    /**
     * 处理“脚本主动发起”的倍速变更。
     *
     * 当前版本重新回到“完全自制倍速列表”：
     * - 菜单项全部由脚本自己生成
     * - 点击菜单或触发快捷键时，统一直接写 `video.playbackRate`
     * - 这样菜单语义最简单，也不会再混入原生菜单项的额外行为
     *
     * 和“自动恢复历史倍速”区分开来的原因是：
     * - 用户主动调整时，要立即刷新当前视频/合集的 1 天有效期记录
     * - 自动恢复历史时，只需要读记录并应用，不应该把“恢复动作”本身再视为一次新的用户操作
     *
     * @param {HTMLVideoElement|null} video
     * @param {number|string} targetRate
     */
    function applyPlaybackRateFromUserAction(video, targetRate) {
        const normalizedTargetRate = normalizeRate(targetRate);
        if (!(video instanceof HTMLVideoElement) || normalizedTargetRate === null) {
            return;
        }

        applyPlaybackRateWithRetry(video, normalizedTargetRate);
        persistRateForCurrentVideo(normalizedTargetRate, video);
    }

    /**
     * 读取当前配置里的所有合法倍速。
     *
     * @returns {number[]}
     */
    function getConfiguredRates() {
        return state.settings.customRates
            .map(({ rate }) => normalizeRate(rate))
            .filter((rate) => rate !== null);
    }

    /**
     * 创建一个由脚本完全控制的倍速菜单项。
     *
     * 这里会直接拦截点击，并走脚本自己的倍速设置逻辑，
     * 这样菜单里每个档位的行为都一致，不再区分“原生项”和“脚本项”。
     *
     * @param {HTMLElement|null} templateItem
     * @param {number} rate
     * @returns {HTMLElement}
     */
    function createCustomRateMenuItem(templateItem, rate) {
        const newItem = document.createElement('li');
        newItem.className = templateItem
            ? templateItem.className.replace(/\bbpx-state-active\b/g, '').trim()
            : 'bpx-player-ctrl-playbackrate-menu-item';
        newItem.dataset.value = String(rate);
        newItem.dataset[CUSTOM_ITEM_MARK] = '1';
        newItem.textContent = formatRateLabel(rate);

        /**
         * 这些是脚本补出来的菜单项，B 站原生本身并不认识它们。
         * 因此点击时必须完全拦截，避免冒泡到父级后造成“看起来像原生点击，
         * 实际却夹杂脚本逻辑”的混合状态。
         */
        newItem.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            const currentVideo = findVideoElement();
            if (!currentVideo) {
                return;
            }

            applyPlaybackRateFromUserAction(currentVideo, rate);
        });

        return newItem;
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
        const hasPendingRestoreForCurrentVideo = state.pendingRestoreRate.videoElement === video;
        if (hasPendingRestoreForCurrentVideo) {
            /**
             * 自动恢复期间，B 站播放器自身有可能先把倍速抖回 1x 或其他中间值。
             * 这类 `ratechange` 不能写回历史记录，否则会把原本正确的历史倍速覆盖掉，
             * 甚至直接把记录删空，导致“同一个视频刷新后恢复不稳定”。
             *
             * 只有当实际倍速终于到达本轮目标值时，才算这次恢复真正成功。
             */
            if (state.pendingRestoreRate.targetRate !== newRate) {
                return;
            }

            state.restoreMark = {
                videoContextId: state.currentVideoContextId,
                videoElement: video
            };
            state.pendingRestoreRate = {
                videoElement: null,
                targetRate: null
            };
            state.waitingForInitialRestore = false;
            console.log(`[B站倍速助手] 已按历史记录恢复当前视频倍速: ${newRate}x`);
            return;
        }

        /**
         * 刚切到新分 P / 新视频上下文时，播放器常会先自己抖出一个 1x 或其他临时值。
         * 在脚本真正完成本轮恢复前，这些中间 `ratechange` 不能写回历史，
         * 否则共享的合集倍速会被错误覆盖。
         */
        if (state.waitingForInitialRestore) {
            return;
        }

        persistRateForCurrentVideo(newRate, video);
    }

    /**
     * 按当前配置完整重建倍速菜单。
     *
     * 当前版本不再保留网页原生倍速项：
     * - 配置里有的倍速就显示
     * - 配置里没有的倍速就不显示
     * - 菜单里所有档位都由脚本统一接管
     *
     * @param {HTMLElement} menu
     */
    function ensureCustomRateItems(menu) {
        const sortedRates = getConfiguredRates().sort((left, right) => left - right);
        const desiredRates = buildMenuRenderRates(sortedRates);
        const existingMenuItems = getRateMenuItems(menu);

        /**
         * bootstrap 和 DOM 观察器都会反复进入这里。
         * 如果菜单当前已经和目标结构完全一致，就直接短路返回，
         * 避免整表 remove + append 把自己再次触发进观察器回调。
         */
        const isMenuAlreadyInSync = (
            existingMenuItems.length === desiredRates.length
            && existingMenuItems.every((menuItem, index) => (
                menuItem.dataset[CUSTOM_ITEM_MARK] === '1'
                && parseRateFromMenuItem(menuItem) === desiredRates[index]
            ))
        );
        if (isMenuAlreadyInSync) {
            return;
        }

        const templateItem = existingMenuItems[0] || null;
        const fragment = document.createDocumentFragment();

        existingMenuItems.forEach((menuItem) => {
            menuItem.remove();
        });

        desiredRates.forEach((rate) => {
            fragment.appendChild(createCustomRateMenuItem(templateItem, rate));
        });
        menu.appendChild(fragment);
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
     * 判断某个 KeyboardEvent 是否命中了指定的“增减倍速快捷键”。
     *
     * 这里和固定倍速快捷键不同，特意允许“额外修饰键”存在。
     * 这样当你先按住一个带 Shift 的加速键，再去按减速键时，
     * 第二个按键即使被事件带上了额外的 Shift，也仍然能正确识别。
     *
     * @param {KeyboardEvent} event
     * @param {string} configuredShortcut
     * @returns {boolean}
     */
    function matchesRateAdjustShortcutFromEvent(event, configuredShortcut) {
        const normalizedShortcut = normalizeShortcutAllowPlainKey(configuredShortcut);
        if (!normalizedShortcut) {
            return false;
        }

        const shortcutParts = normalizedShortcut.split('+');
        const requiredKey = shortcutParts[shortcutParts.length - 1];
        const requiredModifiers = new Set(shortcutParts.slice(0, -1));
        const eventMainKey = normalizeSingleShortcutTokenFromKeyboardEvent(event);
        if (!eventMainKey || ['ctrl', 'alt', 'shift', 'meta'].includes(eventMainKey)) {
            return false;
        }

        if (eventMainKey !== requiredKey) {
            return false;
        }

        const currentModifiers = new Set();
        if (event.ctrlKey) {
            currentModifiers.add('ctrl');
        }
        if (event.altKey) {
            currentModifiers.add('alt');
        }
        if (event.shiftKey) {
            currentModifiers.add('shift');
        }
        if (event.metaKey) {
            currentModifiers.add('meta');
        }

        for (const modifier of requiredModifiers) {
            if (!currentModifiers.has(modifier)) {
                return false;
            }
        }

        return true;
    }

    /**
     * 根据 KeyboardEvent 查找对应的“增减倍速动作”。
     *
     * @param {KeyboardEvent} event
     * @returns {'increase'|'decrease'|''}
     */
    function getRateAdjustActionByKeyboardEvent(event) {
        if (matchesRateAdjustShortcutFromEvent(event, state.settings.rateAdjustShortcuts.increase)) {
            return 'increase';
        }

        if (matchesRateAdjustShortcutFromEvent(event, state.settings.rateAdjustShortcuts.decrease)) {
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

        /**
         * “增减倍速”是按 0.1x 连续细调的链路。
         * 现在菜单已经完全由脚本自己接管，所以这里和固定倍速快捷键一样，
         * 统一直接写 `playbackRate`，保证 0.1x 步进链路连续、可预测、不丢档。
         */
        state.lastRateAdjustAction = action;
        state.lastRateAdjustTriggeredAt = Date.now();
        applyPlaybackRateFromUserAction(video, targetRate);
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
     * 把当前按键规整成一个“单独的按键 token”。
     * 这个 token 只描述当前被按下/松开的那个键本身，不包含其他修饰键，
     * 主要用于统计“当前一共按住了哪些键”，从而识别“两个快捷键同时按下”的情况。
     *
     * @param {KeyboardEvent} event
     * @returns {string}
     */
    function normalizeSingleShortcutTokenFromKeyboardEvent(event) {
        const modifierAliasMap = {
            Control: 'ctrl',
            Alt: 'alt',
            Shift: 'shift',
            Meta: 'meta'
        };
        const codeKeyMap = {
            Minus: '-',
            Equal: '=',
            BracketLeft: '[',
            BracketRight: ']',
            Backslash: '\\',
            Semicolon: ';',
            Quote: '\'',
            Comma: ',',
            Period: '.',
            Slash: '/',
            Backquote: '`',
            NumpadAdd: '+',
            NumpadSubtract: '-',
            NumpadMultiply: '*',
            NumpadDivide: '/',
            NumpadDecimal: '.'
        };
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
        if (modifierAliasMap[event.key]) {
            return modifierAliasMap[event.key];
        }

        let normalizedKey = '';
        if (event.code && /^Key[A-Z]$/.test(event.code)) {
            normalizedKey = event.code.slice(3).toLowerCase();
        } else if (event.code && /^Digit\d$/.test(event.code)) {
            normalizedKey = event.code.slice(5);
        } else if (event.code && codeKeyMap[event.code]) {
            normalizedKey = codeKeyMap[event.code];
        } else {
            normalizedKey = keyAliasMap[event.key] || String(event.key || '').toLowerCase();
        }

        if (event.shiftKey && shiftKeyMap[normalizedKey]) {
            normalizedKey = shiftKeyMap[normalizedKey];
        }

        return normalizedKey;
    }

    /**
     * 判断当前按住的 token 集合，是否命中了某一个已配置快捷键。
     *
     * 规则是：
     * - 主键必须正在按住
     * - 需要的修饰键必须全部按住
     * - 修饰键集合必须完全一致，避免 `ctrl+j` 时把裸 `j` 也算进去
     * - 允许额外按着别的主键，这样才能识别“两个快捷键同时按下”
     *
     * @param {Set<string>} pressedTokens
     * @param {string} shortcut
     * @param {boolean} [allowPlainKey=false]
     * @returns {boolean}
     */
    function isShortcutActiveInPressedTokens(pressedTokens, shortcut, allowPlainKey = false) {
        const normalizedShortcut = allowPlainKey
            ? normalizeShortcutAllowPlainKey(shortcut)
            : normalizeShortcut(shortcut);
        if (!normalizedShortcut) {
            return false;
        }

        const parts = normalizedShortcut.split('+');
        const requiredKey = parts[parts.length - 1];
        const requiredModifiers = new Set(parts.slice(0, -1));
        const currentModifiers = new Set(
            ['ctrl', 'alt', 'shift', 'meta'].filter((modifier) => pressedTokens.has(modifier))
        );

        if (!pressedTokens.has(requiredKey)) {
            return false;
        }

        if (currentModifiers.size !== requiredModifiers.size) {
            return false;
        }

        for (const modifier of requiredModifiers) {
            if (!pressedTokens.has(modifier)) {
                return false;
            }
        }

        return true;
    }

    /**
     * 当“增加倍速”和“减少倍速”两个方向的快捷键同时介入时，把倍速直接归回 1x。
     *
     * 这里不再通过“当前按住了哪些 token”去间接推断，而是直接利用现有长按链路状态：
     * - 第一个增减快捷键按下时，会先占据 `state.rateAdjustHoldAction`
     * - 如果紧接着又按下另一个方向的增减快捷键，就说明用户想触发“归 1x”
     *
     * 这种判断更贴近真实交互，也能避开某些组合键在 keydown/keyup 时序上的细节误差。
     *
     * @param {'increase'|'decrease'|''} nextAction
     * @returns {boolean}
     */
    function tryResetPlaybackRateByRateAdjustShortcuts(nextAction) {
        if (!nextAction) {
            state.multiShortcutResetTriggered = false;
            return false;
        }

        const now = Date.now();
        const hasOppositeActiveHold = (
            state.rateAdjustHoldAction
            && state.rateAdjustHoldAction !== nextAction
        );
        const hasRecentOppositeAdjust = (
            state.lastRateAdjustAction
            && state.lastRateAdjustAction !== nextAction
            && now - state.lastRateAdjustTriggeredAt <= RATE_ADJUST_REVERSE_RESET_WINDOW_MS
        );

        if (!hasOppositeActiveHold && !hasRecentOppositeAdjust) {
            state.multiShortcutResetTriggered = false;
            return false;
        }

        if (state.multiShortcutResetTriggered) {
            return true;
        }

        const video = findVideoElement();
        if (!video) {
            return false;
        }

        state.multiShortcutResetTriggered = true;
        stopRateAdjustHold();
        applyPlaybackRateFromUserAction(video, DEFAULT_PLAYBACK_RATE);
        showCenterRateHint(DEFAULT_PLAYBACK_RATE);
        console.log('[B站倍速助手] 检测到增减倍速快捷键同时按下，已归回 1.0x');
        return true;
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
        const codeKeyMap = {
            Minus: '-',
            Equal: '=',
            BracketLeft: '[',
            BracketRight: ']',
            Backslash: '\\',
            Semicolon: ';',
            Quote: '\'',
            Comma: ',',
            Period: '.',
            Slash: '/',
            Backquote: '`',
            NumpadAdd: '+',
            NumpadSubtract: '-',
            NumpadMultiply: '*',
            NumpadDivide: '/',
            NumpadDecimal: '.'
        };
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

        let normalizedKey = '';
        if (event.code && /^Key[A-Z]$/.test(event.code)) {
            normalizedKey = event.code.slice(3).toLowerCase();
        } else if (event.code && /^Digit\d$/.test(event.code)) {
            normalizedKey = event.code.slice(5);
        } else if (event.code && codeKeyMap[event.code]) {
            normalizedKey = codeKeyMap[event.code];
        } else {
            normalizedKey = keyAliasMap[rawKey] || rawKey.toLowerCase();
        }

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
     * “输入区域”选择器，用于判断按键时是否正在输入。
     *
     * 注意这里刻意把 `input` 收窄成“真正的文本输入控件”：
     * - 排除 checkbox / radio / button / submit / reset / range / color / file / image
     * - B 站播放器弹幕开关（.bpx-player-dm-switch）内部藏着一个隐藏 checkbox input，
     *   点击开关后焦点会落到这个 checkbox 上。如果仍按老写法匹配任意 `input`，
     *   脚本会把“焦点在弹幕开关上”误判成“正在输入”，从而忽略音量/倍速快捷键，
     *   表现为“点击弹幕开关后快捷键失效，需要再点击视频才能恢复”。
     */
    const IGNORED_INPUT_SELECTOR = [
        'textarea',
        'select',
        'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"])',
        '[role="textbox"]',
        '[contenteditable]:not([contenteditable="false"])'
    ].join(', ');

    /**
     * 把任意事件目标尽量归一化成元素节点。
     * 某些富文本编辑器里，keydown 的 target 可能是文本节点，
     * 如果只接受 Element，就会把“正在输入”的场景漏过去。
     *
     * @param {EventTarget|null} target
     * @returns {Element|null}
     */
    function getClosestTargetElement(target) {
        if (target instanceof Element) {
            return target;
        }

        if (target instanceof Node) {
            return target.parentElement;
        }

        return null;
    }

    /**
     * 判断某个元素是否位于真正的可编辑输入区域内。
     * 这里统一兼容原生输入框、富文本编辑器，以及带 `role="textbox"` 的自定义输入控件。
     *
     * @param {Element|null} element
     * @returns {boolean}
     */
    function isEditableElement(element) {
        if (!(element instanceof Element)) {
            return false;
        }

        return Boolean(element.closest(IGNORED_INPUT_SELECTOR));
    }

    /**
     * 获取当前文档里真正处于焦点链末端的元素。
     * 之所以不用只看 `document.activeElement`，
     * 是因为某些自定义输入控件会把真实焦点继续放进 shadowRoot 内部。
     *
     * @returns {Element|null}
     */
    function getDeepActiveElement() {
        let activeElement = document.activeElement instanceof Element ? document.activeElement : null;

        while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement instanceof Element) {
            activeElement = activeElement.shadowRoot.activeElement;
        }

        return activeElement;
    }

    /**
     * 从当前文本选区中推断用户是否正处于可编辑区域。
     * 富文本编辑器里，键盘事件目标可能因为 Shadow DOM 重定向而不稳定，
     * 但选区锚点通常仍然落在评论输入框内部的 contenteditable 节点上。
     *
     * @returns {boolean}
     */
    function isEditingFromSelection() {
        const selection = window.getSelection();
        if (!selection) {
            return false;
        }

        const anchorElement = getClosestTargetElement(selection.anchorNode);
        const focusElement = getClosestTargetElement(selection.focusNode);

        return isEditableElement(anchorElement) || isEditableElement(focusElement);
    }

    /**
     * 从事件传播路径里检查是否命中了可编辑区域。
     * B 站评论区输入框埋在多层 Shadow DOM 内部（bili-comments Web Component），
     * 捕获阶段的 event.target 会被浏览器重定向成外层自定义元素（host），
     * 导致传统的 `target.closest()` 检测失效；
     * 但 `event.composedPath()` 仍然保留完整的真实传播路径，
     * 因此能命中 Shadow DOM 深处真正带 contenteditable 的输入节点。
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function isEditingFromEventPath(event) {
        if (typeof event.composedPath !== 'function') {
            return false;
        }

        const path = event.composedPath();
        return path.some((pathItem) => {
            const element = getClosestTargetElement(pathItem);
            return isEditableElement(element);
        });
    }

    /**
     * 输入框、文本域、可编辑区域内不处理快捷键，
     * 否则用户改评论、搜视频、发弹幕时体验会很差。
     *
     * 这里综合检查：
     * 1. 事件目标（已归一化为元素，兼容文本节点）
     * 2. 事件传播路径（穿透 Shadow DOM，覆盖 B 站评论区富文本输入框）
     * 3. 当前焦点元素（递归进入 shadowRoot，找到真正的输入节点）
     * 4. 当前文本选区（富文本编辑器里光标所在位置）
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function shouldIgnoreShortcutTarget(event) {
        const targetElement = getClosestTargetElement(event.target);
        const activeElement = getDeepActiveElement();

        if (document.designMode === 'on') {
            return true;
        }

        return (
            isEditableElement(targetElement)
            || isEditableElement(activeElement)
            || isEditingFromEventPath(event)
            || isEditingFromSelection()
        );
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

            if (shouldIgnoreShortcutTarget(event)) {
                return;
            }

            const adjustShortcut = normalizeShortcutFromKeyboardEvent(event, false);
            const rateAdjustAction = getRateAdjustActionByKeyboardEvent(event);
            if (rateAdjustAction) {
                if (tryResetPlaybackRateByRateAdjustShortcuts(rateAdjustAction)) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    return;
                }

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
            applyPlaybackRateFromUserAction(video, targetRate);
            showCenterRateHint(targetRate);
            console.log(`[B站倍速助手] 已通过快捷键切换到 ${targetRate}x`);
        };

        const handleKeyup = (event) => {
            state.multiShortcutResetTriggered = false;

            if (shouldStopRateAdjustHoldByKeyup(event)) {
                stopRateAdjustHold();
            }
        };

        const handleForceStopHold = () => {
            stopRateAdjustHold();
            state.multiShortcutResetTriggered = false;
        };

        window.addEventListener('keydown', handleKeydown, true);
        window.addEventListener('keyup', handleKeyup, true);
        window.addEventListener('blur', handleForceStopHold);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopRateAdjustHold();
                state.multiShortcutResetTriggered = false;
            }
        });
    }

    /**
     * 只有在当前视频存在历史记录时才自动恢复倍速.
     * 如果没有历史记录，就不主动改动当前播放器倍速。
     *
     * @param {HTMLVideoElement} video
     */
    function restoreSavedRateIfNeeded(video) {
        if (state.lastSavedRate === null) {
            state.restoreMark = {
                videoContextId: state.currentVideoContextId,
                videoElement: video
            };
            state.waitingForInitialRestore = false;
            console.log('[B站倍速助手] 当前视频没有历史倍速记录，不主动改动当前播放器倍速');
            return;
        }

        if (
            state.restoreMark.videoContextId === state.currentVideoContextId
            && state.restoreMark.videoElement === video
        ) {
            return;
        }

        const targetRate = normalizeRate(state.lastSavedRate);
        if (targetRate === null) {
            return;
        }

        /**
         * 如果当前真实倍速已经等于历史值，就直接视为恢复完成。
         * 这能避免页面已经恢复成功，但后续又因为 DOM 轻微波动而重复触发恢复流程。
         */
        if (normalizeRate(video.playbackRate) === targetRate) {
            state.pendingRestoreRate = {
                videoElement: null,
                targetRate: null
            };
            state.restoreMark = {
                videoContextId: state.currentVideoContextId,
                videoElement: video
            };
            state.waitingForInitialRestore = false;
            return;
        }

        const isSameRestoreStillApplying = (
            state.pendingRestoreRate.videoElement === video
            && state.pendingRestoreRate.targetRate === targetRate
            && state.pendingPlaybackRateApply.videoElement === video
            && state.pendingPlaybackRateApply.targetRate === targetRate
        );
        if (isSameRestoreStillApplying) {
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
        state.pendingRestoreRate = {
            videoElement: video,
            targetRate
        };
        state.waitingForInitialRestore = true;
        applyPlaybackRateWithRetry(video, targetRate);
        console.log(`[B站倍速助手] 正在尝试恢复当前视频倍速为 ${targetRate}x`);
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
        // 校准 DOM 观察器的观察范围（播放器容器出现/移除时，在容器级与 body 顶层之间切换）
        syncDomObservationScope();

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
        const nextVideoContextId = buildCurrentVideoContextId();
        if (
            nextVideoKey === state.currentVideoKey
            && nextVideoContextId === state.currentVideoContextId
        ) {
            return;
        }

        clearPendingPlaybackRateApply();
        state.pendingRestoreRate = {
            videoElement: null,
            targetRate: null
        };
        state.waitingForInitialRestore = true;
        stopRateAdjustHold();
        state.multiShortcutResetTriggered = false;
        state.currentVideoKey = nextVideoKey;
        state.currentVideoContextId = nextVideoContextId;
        state.lastSavedRate = loadSavedRate(nextVideoKey);
        state.restoreMark = {
            videoContextId: '',
            videoElement: null
        };
        const isCollectionContext = nextVideoKey.includes(':collection:');

        if (state.lastSavedRate === null) {
            console.log(
                `[B站倍速助手] 检测到站内跳转，新的${isCollectionContext ? '合集' : '视频'}上下文没有历史倍速记录`
            );
        } else {
            console.log(
                `[B站倍速助手] 检测到站内跳转，新的${isCollectionContext ? '合集' : '视频'}上下文将恢复为 ${state.lastSavedRate}x`
            );
        }

        scheduleBootstrap(120);
    }

    /**
     * 用可退避的 URL 观察替代永久高频 setInterval。
     * 页面刚发生站内跳转后保持高频检测；稳定一段时间后自动降频；
     * 页面进入后台时再进一步降低频率，减少常驻开销。
     *
     * @param {number} delay
     */
    function scheduleHrefWatch(delay) {
        clearTimeout(state.hrefWatchTimer);
        state.hrefWatchTimer = window.setTimeout(() => {
            const currentHref = location.href;
            if (currentHref !== state.hrefWatchLastObserved) {
                state.hrefWatchLastObserved = currentHref;
                state.hrefWatchIdleTicks = 0;
                refreshVideoContext();
                scheduleHrefWatch(HREF_WATCH_ACTIVE_DELAY);
                return;
            }

            state.hrefWatchIdleTicks += 1;
            const nextDelay = document.hidden
                ? HREF_WATCH_HIDDEN_DELAY
                : (state.hrefWatchIdleTicks >= 4 ? HREF_WATCH_IDLE_DELAY : HREF_WATCH_ACTIVE_DELAY);
            scheduleHrefWatch(nextDelay);
        }, delay);
    }

    /**
     * 监听 history 和 popstate，适配 B 站站内无刷跳转.
     */
    function installRouteChangeListener() {
        const rawPushState = history.pushState;
        const rawReplaceState = history.replaceState;

        history.pushState = function (...args) {
            const result = rawPushState.apply(this, args);
            state.hrefWatchLastObserved = location.href;
            state.hrefWatchIdleTicks = 0;
            setTimeout(refreshVideoContext, 120);
            scheduleHrefWatch(HREF_WATCH_ACTIVE_DELAY);
            return result;
        };

        history.replaceState = function (...args) {
            const result = rawReplaceState.apply(this, args);
            state.hrefWatchLastObserved = location.href;
            state.hrefWatchIdleTicks = 0;
            setTimeout(refreshVideoContext, 120);
            scheduleHrefWatch(HREF_WATCH_ACTIVE_DELAY);
            return result;
        };

        window.addEventListener('popstate', () => {
            state.hrefWatchLastObserved = location.href;
            state.hrefWatchIdleTicks = 0;
            setTimeout(refreshVideoContext, 120);
            scheduleHrefWatch(HREF_WATCH_ACTIVE_DELAY);
        });

        /**
         * 有些合集内切换不会可靠触发 pushState / replaceState，
         * 但地址栏里的 `p=` 确实会变化。
         * 这里补一个可退避的轮询兜底，专门处理这种“URL 变了，但页面没有显式路由事件”的场景。
         */
        scheduleHrefWatch(HREF_WATCH_ACTIVE_DELAY);
        document.addEventListener('visibilitychange', () => {
            state.hrefWatchIdleTicks = 0;
            scheduleHrefWatch(document.hidden ? HREF_WATCH_HIDDEN_DELAY : HREF_WATCH_ACTIVE_DELAY);
        });
    }

    /**
     * 判断一次 DOM 变化是否与倍速 UI 相关。
     *
     * 背景：
     * 长视频播放期间，页面除了弹幕外还有大量持续增删 DOM 的部件
     * （字幕层、控制栏重绘、广告、推荐位等）。如果观察器对它们也响应，
     * bootstrap 仍会以 150ms 的节奏高频执行重活，长时间播放后主线程被拖慢，
     * 表现为点击暂停/播放延迟、长按加速只触发一次。
     *
     * 因此这里把响应范围收窄到真正需要的三类变化：
     * 1. 倍速按钮 / 倍速菜单 / 菜单项 / 倍速结果文本 的增删或内部变化
     * 2. video 元素的增删（视频源重建）
     * 3. 播放器容器本身被增删（播放器整体重建）
     *
     * 其余任何变化（弹幕、字幕、控制栏、页面其他区域）一律视为无关并跳过。
     *
     * @param {MutationRecord} mutation
     * @returns {boolean}
     */
    function isRateUiRelatedMutation(mutation) {
        const danmakuSelector = '.bpx-player-dm-wrap, .bpx-player-dm, [class*="player-dm"]';
        const rateUiNodeSelector = [
            ...SELECTORS.rateButton,
            ...SELECTORS.rateMenu,
            ...SELECTORS.rateMenuItem,
            ...SELECTORS.rateResult,
            'video'
        ].join(', ');
        const playerContainerSelector = [
            ...SELECTORS.playerContainer,
            '#bilibili-player'
        ].join(', ');

        const targetElement = mutation.target instanceof Element ? mutation.target : null;
        // 弹幕容器内部的增删一律视为无关
        if (targetElement && targetElement.closest(danmakuSelector)) {
            return false;
        }

        const affectedNodes = [targetElement, ...mutation.addedNodes, ...mutation.removedNodes];
        return affectedNodes.some((node) => (
            node instanceof Element
            && (
                // 播放器容器本身被增删（播放器整体重建）
                node.matches(playerContainerSelector)
                // 节点是倍速 UI 节点，或位于倍速 UI 节点内部
                || node.matches(rateUiNodeSelector)
                || Boolean(node.closest(rateUiNodeSelector))
            )
        ));
    }

    /**
     * 去抖后的视频上下文刷新。
     *
     * 背景：
     * URL 的真实变化已经由 scheduleHrefWatch 的兜底轮询覆盖，
     * 因此 DOM 观察器里不必每一批 DOM 变化都立刻执行 refreshVideoContext。
     * 这里统一去抖，避免高频 DOM 波动带来无意义的 URL 解析和 DOM 遍历。
     */
    function scheduleVideoContextRefresh() {
        clearTimeout(state.videoContextRefreshTimer);
        state.videoContextRefreshTimer = window.setTimeout(() => {
            refreshVideoContext();
        }, 300);
    }

    /**
     * 同步 DOM 观察器的观察范围（结构级收窄，弹幕/字幕/控制栏高频区域零开销）。
     *
     * 背景：
     * 上一版把观察范围收窄到“播放器容器 subtree”，但弹幕层、字幕层、控制栏
     * 本身就在播放器容器内部——长视频播放时它们依然以每帧几十条的速度增删，
     * 浏览器仍要逐条生成并分派 mutation 记录给脚本，主线程开销并没有真正降下来，
     * 表现为“弹幕很少的视频播放久了依然卡”。
     *
     * 本版改为只观察“结构性变化”：
     * 1. document.body 顶层子节点增删：捕获播放器容器挂载/移除前的兜底入口。
     * 2. 播放器容器的直接子节点增删（刻意不递归 subtree）：
     *    捕获视频层/控制栏整体挂载、播放器整体重建这类“大结构变化”。
     *    弹幕层、字幕层、控制栏内部的重绘都发生在容器深层，不会产生任何 mutation。
     * 3. 倍速按钮内部 subtree：捕获倍速菜单挂载/移除（菜单是按钮的后代）。
     *
     * 这样观察器平时几乎不触发，弹幕/字幕/控制栏的高频增删完全不经过观察器，
     * 长视频播放期间的主线程持续占用被彻底移除。
     */
    function syncDomObservationScope() {
        const observer = state.domObserver;
        if (!observer) {
            return;
        }

        const playerContainer = queryFirst(SELECTORS.playerContainer);
        const rateButton = queryFirst(SELECTORS.rateButton);
        const scopeKey = [
            playerContainer ? 'player' : 'body',
            rateButton ? 'rateButton' : 'none'
        ].join(':');
        if (state.observedPlayerScope === scopeKey) {
            return;
        }
        state.observedPlayerScope = scopeKey;

        observer.disconnect();

        // 1. 顶层兜底：播放器容器出现前捕获其挂载。
        //    B 站容器挂载位置较深，顶层观察未必捕获得到，
        //    真正的重校准由 bootstrap 每次执行时调用本函数完成。
        observer.observe(document.body, { childList: true });

        // 2. 播放器容器：只观察直接子节点增删，刻意不递归 subtree。
        if (playerContainer) {
            observer.observe(playerContainer, { childList: true });
        }

        // 3. 倍速按钮内部：递归观察，捕获菜单挂载/移除。
        if (rateButton) {
            observer.observe(rateButton, { childList: true, subtree: true });
        }
    }

    /**
     * DOM 观察器负责兜住“播放器晚于脚本加载”“站内切页时局部重建 DOM”等场景.
     * 观察范围由 syncDomObservationScope 收窄到“结构级变化”：
     * - 播放器容器的直接子节点增删（视频层/控制栏挂载、播放器重建）
     * - 倍速按钮内部增删（倍速菜单挂载/移除）
     * 弹幕、字幕、控制栏内部重绘等高频波动完全不经过观察器，
     * 实际处理统一交给去抖后的 bootstrap.
     */
    function installDomObserver() {
        const observer = new MutationObserver((mutations) => {
            // 先按当前 DOM 状态切换观察范围（例如播放器容器刚挂载/被移除时）
            syncDomObservationScope();

            // 只对与倍速 UI 相关的结构性节点变化重新 bootstrap；
            // 到这里的 mutation 只会是“播放器容器/视频层/控制栏整体挂载”或“倍速菜单挂载/移除”
            if (!mutations.some((mutation) => isRateUiRelatedMutation(mutation))) {
                return;
            }

            scheduleBootstrap(150);
            scheduleVideoContextRefresh();
        });

        state.domObserver = observer;
        syncDomObservationScope();
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

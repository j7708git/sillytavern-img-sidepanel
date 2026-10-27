import { saveSettings, saveSettingsDebounced, substituteParams, system_message_types } from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../slash-commands.js';
import { ConnectionManagerRequestService } from '../../extensions/shared.js';
import { eventSource, event_types } from '../../events.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';

const MODULE_NAME = 'img-sidepanel';
const HISTORY_CAP = 200;

// Active conversion template name (the user's current ComfyUI workflow is Anima).
const DEFAULT_ACTIVE_TEMPLATE = 'Anima';

// Built-in conversion templates (Traditional-Chinese instructions; the LLM
// outputs English). `activeTemplate` selects which one convertToPrompt reads.
const DEFAULT_TEMPLATES = {
    'Anima': '你是圖片提示詞轉換器。輸入是角色卡描述與最近的聊天訊息。請輸出 ComfyUI 用的英文 Danbooru 風格標籤清單（逗號分隔的 tags），只輸出標籤本身、不要解釋、不要前綴後綴。規則：① 角色外觀必須嚴格依照角色卡描述逐項還原（髮色、髮型、眼睛顏色、服裝、體型等），角色卡已描述的項目不得更改或省略；未描述的細節才可依情境合理補足。② 場景、動作、氛圍以最後一條有效訊息的內容為主。③ 不要輸出負面提示詞、浮水印、文字、版權字樣、評級標籤。',
    'Krea 2': '你是圖片提示詞轉換器。輸入是角色卡描述與最近的聊天訊息。請輸出一段流暢的英文自然語言描述（1~2 句）作為正向提示詞，只輸出描述本身、不要解釋、不要前綴後綴。規則：① 角色外觀必須嚴格依照角色卡描述逐項還原（髮色、髮型、眼睛顏色、服裝、體型等），角色卡已描述的項目不得更改或省略；未描述的細節才可依情境合理補足。② 場景、動作、氛圍以最後一條有效訊息的內容為主。③ 不要包含負面提示詞、浮水印、文字、版權字樣。',
};

// Tracker-style system message types (narrator/generic/…) to exclude from the
// conversion context, alongside `is_system` messages.
const SYSTEM_MESSAGE_TYPES = new Set(Object.values(system_message_types));

// Default settings. `history` holds per-chat entries keyed by the stable chat id.
const defaultSettings = {
    profileId: '',
    contextMessages: 2,
    // Conversion templates keyed by name + the active one. `templates` is seeded
    // with the two built-ins by initSettings() when missing/empty; a saved
    // (user-edited) templates object is kept as-is.
    templates: null,
    activeTemplate: DEFAULT_ACTIVE_TEMPLATE,
    history: {},
    panel: null,
    // 'floating' (default) | 'fixed' (docked strip inside #sheld).
    panelMode: 'floating',
    // Docked strip height in px (resized via its bottom splitter edge).
    fixedHeight: 220,
    // Whether the dock is collapsed to its slim header bar.
    fixedCollapsed: false,
    // Global auto-generate toggle (shared by ALL chats): after every completed
    // AI reply, run one conversion + quiet generation automatically.
    autoGenerate: false,
};

// Last displayed result + the pager position within the ACTIVE chat's history.
// `currentIndex` indexes into `getChatHistory(getChatId())`; -1 means no entry.
let lastResult = null;
let currentIndex = -1;

// Auto-generate bookkeeping (see handleGenerationEnded):
// - autoLastMessageKey: "chatId/messageId" the auto flow was last triggered
//   for — dedup: swipes/re-edits of the same message never re-trigger.
// - autoPendingTimeout: the debounced run still waiting for its 800ms delay
//   (a newer trigger replaces the older pending one instead of queueing).
// - isGenerating: any generation (manual ⚡ / 🔄 / auto) is currently in
//   flight; new triggers skip while it is set, they never queue.
let autoLastMessageKey = '';
let autoPendingTimeout = null;
let isGenerating = false;

// Delay (ms) between GENERATION_ENDED and the start of the auto flow, so the
// conversion context is captured after the reply has fully settled.
const AUTO_GENERATE_DELAY_MS = 800;

// Timer for auto-hiding the transient status line (success/failure messages).
let statusTimer = null;

// Dock geometry constants (px). The dock header stays 32px tall; the body and
// the resizable bottom splitter make up the rest of `fixedHeight`.
const DOCK_MIN_H = 100;
const DOCK_DEFAULT_H = 220;
const DOCK_HEADER_H = 32;

// Element id map per mode. Floating keeps the legacy isp_* ids; the dock uses
// distinct isp_dock_* ids so no id is ever duplicated in the DOM.
const PANEL_IDS = {
    floating: {
        panel: 'isp_panel', status: 'isp_status', imgWrap: 'isp_img_wrap', prompt: 'isp_prompt',
        pos: 'isp_pos', prev: 'isp_prev_btn', next: 'isp_next_btn', refresh: 'isp_refresh_btn',
    },
    fixed: {
        panel: 'isp_dock', status: 'isp_dock_status', imgWrap: 'isp_dock_img_wrap', prompt: 'isp_dock_prompt',
        pos: 'isp_dock_pos', prev: 'isp_dock_prev', next: 'isp_dock_next', refresh: 'isp_dock_refresh',
    },
};

// Whether the user is currently in the docked (fixed) mode.
function isFixedMode() {
    return getSettings().panelMode === 'fixed';
}

// Id set for the currently active container.
function activeIds() {
    return PANEL_IDS[isFixedMode() ? 'fixed' : 'floating'];
}

// jQuery wrapper of the currently active container (#isp_panel or #isp_dock).
function getActivePanel() {
    return $('#' + activeIds().panel);
}

// jQuery wrapper of a sub-element (status/img/prompt/pager/refresh) inside the
// currently active container, resolved by role name.
function getActiveEl(key) {
    return $('#' + activeIds()[key]);
}

function initSettings() {
    const existing = extension_settings[MODULE_NAME] || {};
    const existingKeys = new Set(Object.keys(existing));
    const addedKeys = Object.keys(defaultSettings).filter(key => !existingKeys.has(key));

    extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings, existing);

    // The old single conversionTemplate setting is intentionally discarded (no
    // migration) — drop any stale persisted copy so nothing ever reads it again.
    delete extension_settings[MODULE_NAME].conversionTemplate;

    const settings = extension_settings[MODULE_NAME];

    // Seed the two built-in templates when `templates` is missing/empty. A saved
    // (user-edited) templates object is kept as-is. Always copy so we never
    // mutate the shared DEFAULT_TEMPLATES constant in place.
    if (!settings.templates || typeof settings.templates !== 'object' || Array.isArray(settings.templates) || Object.keys(settings.templates).length === 0) {
        settings.templates = { ...DEFAULT_TEMPLATES };
    }

    // activeTemplate falls back to 'Anima' when it no longer exists in templates;
    // if even 'Anima' is gone, fall back to the first remaining template name.
    if (!settings.activeTemplate || typeof settings.templates[settings.activeTemplate] !== 'string') {
        settings.activeTemplate = Object.prototype.hasOwnProperty.call(settings.templates, DEFAULT_ACTIVE_TEMPLATE)
            ? DEFAULT_ACTIVE_TEMPLATE
            : (Object.keys(settings.templates)[0] || DEFAULT_ACTIVE_TEMPLATE);
    }

    // Persist only when new default keys were introduced.
    if (addedKeys.length > 0) {
        saveSettingsDebounced();
    }
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

// Read the active template's instruction text. Falls back to the Anima template
// when activeTemplate is missing/empty (or points at a template that no longer
// exists), then to the first available template as a final defensive guard.
function getActiveTemplateText() {
    const settings = getSettings();
    const templates = (settings.templates && typeof settings.templates === 'object' && !Array.isArray(settings.templates))
        ? settings.templates
        : {};
    const name = settings.activeTemplate || DEFAULT_ACTIVE_TEMPLATE;
    return templates[name]
        || templates[DEFAULT_ACTIVE_TEMPLATE]
        || Object.values(templates)[0]
        || DEFAULT_TEMPLATES[DEFAULT_ACTIVE_TEMPLATE];
}

// Stable per-chat identifier. Matches getCurrentChatId() in ST: group chat id or
// the character's chat filename; falls back to 'default' for the neutral chat.
function getChatId(context) {
    const ctx = context || getContext();
    const id = ctx?.chatId;
    return (id !== undefined && id !== null && String(id).trim() !== '') ? String(id) : 'default';
}

// Return (and lazily create) the history array for a chat id. Guards against a
// corrupted/missing `history` value in persisted settings.
function getChatHistory(chatId) {
    const settings = getSettings();
    if (!settings.history || typeof settings.history !== 'object' || Array.isArray(settings.history)) {
        settings.history = {};
    }
    const key = chatId || getChatId();
    if (!Array.isArray(settings.history[key])) {
        settings.history[key] = [];
    }
    return settings.history[key];
}

// Drop oldest entries beyond the per-chat cap (newest last).
function trimHistory(history) {
    while (history.length > HISTORY_CAP) {
        history.shift();
    }
}

// Pick a standalone LLM profile. Prefer one whose name contains "deepseek",
// otherwise fall back to the selected profile / first profile. Persist the pick.
function resolveProfileId() {
    const settings = getSettings();
    if (settings.profileId) {
        return settings.profileId;
    }

    const connectionManager = extension_settings.connectionManager;
    const profiles = Array.isArray(connectionManager?.profiles) ? connectionManager.profiles : [];
    const deepseek = profiles.find(profile => String(profile?.name || '').toLowerCase().includes('deepseek'));
    const picked = deepseek?.id || connectionManager?.selectedProfile || profiles[0]?.id || '';

    if (picked) {
        settings.profileId = picked;
        saveSettingsDebounced();
    }

    return picked;
}

// Decide whether a chat message should be EXCLUDED from the conversion context.
// The scene must come from the LAST REAL message, so we drop system/tracker
// messages, empty/whitespace-only text, and image-only attachments.
function isSkippableMessage(message) {
    if (!message) {
        return true;
    }
    // System messages + tracker-style system variants (narrator/generic/…).
    if (message.is_system || SYSTEM_MESSAGE_TYPES.has(message.extra?.type)) {
        return true;
    }
    const text = message.mes ? String(message.mes).trim() : '';
    // Image-only attachment: media present but no meaningful text.
    if (Array.isArray(message.extra?.media) && message.extra.media.length > 0 && !text) {
        return true;
    }
    // Empty / whitespace-only text carries no scene info either.
    return !text;
}

// Assemble the conversion context: current character card description + the
// last N real chat messages (skip system/empty/image-only), labelled by speaker.
function buildContextBlock(context) {
    const settings = getSettings();
    const count = Math.max(1, Number(settings.contextMessages) || 2);

    // Collect newest-first, then restore chronological order.
    const recent = [];
    const chat = Array.isArray(context.chat) ? context.chat : [];
    for (let i = chat.length - 1; i >= 0 && recent.length < count; i--) {
        const message = chat[i];
        if (isSkippableMessage(message)) {
            continue;
        }
        recent.push(message);
    }
    recent.reverse();

    const lines = recent.map(message => {
        const who = message.name || (message.is_user ? context.name1 : context.name2) || (message.is_user ? '使用者' : '角色');
        return `${who}: ${String(message.mes).trim()}`;
    });

    const description = context.characters?.[context.characterId]?.description?.trim() || '（無）';

    return [
        '角色卡描述：',
        description,
        '',
        '最近訊息：',
        ...(lines.length ? lines : ['（無）']),
    ].join('\n');
}

// Ask the standalone LLM to convert chat context into an English positive prompt.
async function convertToPrompt(context, signal) {
    setStatus('① 提示詞轉換中…');
    const template = getActiveTemplateText();
    const profileId = resolveProfileId();

    if (!profileId) {
        throw new Error('找不到可用的 LLM profile（connection manager）。');
    }

    const messages = [
        // 模板要經過巨集替換：{{user}} 是 persona 名稱、{{persona}} 是 persona 描述。
        // 面板的 context 只有角色卡與最近訊息，拿不到使用者人設，這是唯一來源。
        { role: 'system', content: substituteParams(template) },
        { role: 'user', content: buildContextBlock(context) },
    ];

    const custom = { includePreset: false, extractData: true, signal };
    const overridePayload = { stream: false };

    // 1000 tokens: deepseek-v4-flash (官方直連) 是推理模型，max_tokens 太小會把
    // 額度全花在 chain-of-thought 上導致 content 為空（實測 300 會空）。
    const result = await ConnectionManagerRequestService.sendRequest(profileId, messages, 1000, custom, overridePayload);
    const text = (typeof result === 'string' ? result : result?.content) || '';
    const cleaned = text.trim();

    if (!cleaned) {
        throw new Error('LLM 未回傳提示詞。');
    }

    return cleaned;
}

// Extract a usable image URL/path from the slash command pipe, handling both a
// plain path/URL string and a JSON-shaped {url} value.
function extractImageUrl(pipe) {
    if (!pipe) {
        return '';
    }
    const trimmed = String(pipe).trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                return parsed.url || parsed.path || parsed.image || '';
            }
        } catch {
            // Not valid JSON — fall through and treat it as a path/URL.
        }
    }
    return trimmed;
}

// Run the ST built-in SD generation in quiet mode.
// Named arguments must precede the positional prompt in STscript.
// Seed: 預設沿用 ST 的 Seed 設定（>= 0 時鎖定），讓同一個角色在不同場景間保有一致的臉。
// `randomSeed` 供「重新生成」使用，維持換一張的行為。
async function generateImage(prompt, { randomSeed = false } = {}) {
    // Strip characters that would break STscript parsing; collapse whitespace.
    const safePrompt = String(prompt).replace(/[|"{}]/g, ' ').replace(/\s+/g, ' ').trim();
    const sdSeed = Number(extension_settings.sd?.seed);
    const lockedSeed = !randomSeed && Number.isFinite(sdSeed) && sdSeed >= 0;
    const seedArg = lockedSeed ? `seed=${Math.trunc(sdSeed)}` : 'seed=-1';
    // extend=false: 使用者 ST 的 sd.free_extend=true 會讓 SD 用主連線 LLM 擴寫
    // prompt（FREE_EXTENDED mode），雙重 LLM 且繞過我們的轉換——每次呼叫鎖死。
    const command = `/imagine quiet=true ${seedArg} extend=false ${safePrompt}`;

    setStatus('② ComfyUI 生成中…');

    const result = await executeSlashCommandsWithOptions(command, {});
    const url = extractImageUrl(result?.pipe ?? '');

    if (!url) {
        throw new Error(result?.errorMessage || '圖片生成失敗（無回傳圖片）。');
    }

    return url;
}

// --- Panel rendering + pager -------------------------------------------------

// Mirror of the ST built-in SD extension's combinePrefixes() (it is NOT
// exported from stable-diffusion/index.js). Identical semantics: strip edge
// whitespace and commas, then either substitute the conversion result into
// the `{prompt}` macro inside the prefix or append it after a comma.
function combinePrefixes(str1, str2, macro = '') {
    const process = (s) => s.trim().replace(/^,|,$/g, '').trim();

    if (!str2) {
        return str1;
    }

    str1 = process(str1);
    str2 = process(str2);
    const result = macro && str1.includes(macro) ? str1.replace(macro, str2) : `${str1}, ${str2},`;
    return process(result);
}

// Resolve the FINAL prompt ST actually sends to the image generator for a
// converted prompt: /imagine (FREE mode) merges extension_settings.sd.prompt_prefix
// via combinePrefixes(prefix, prompt, '{prompt}') and then resolves all macros
// with substituteParams(). Resolved at display time so a changed prefix shows
// immediately; the history entry keeps the raw converted prompt (regeneration
// re-runs through /imagine, which applies the prefix again).
function resolveFinalPrompt(convertedPrompt) {
    const prefix = String(extension_settings.sd?.prompt_prefix ?? '');
    return substituteParams(combinePrefixes(prefix, convertedPrompt, '{prompt}'));
}

// Return the entry currently being viewed (or null when none/empty).
function getCurrentEntry() {
    const history = getChatHistory(getChatId());
    if (currentIndex >= 0 && currentIndex < history.length) {
        return history[currentIndex];
    }
    return null;
}

// Show a transient status message in the panel body. `autoHideMs` optionally
// schedules a self-hide (success/failure feedback); otherwise the message stays
// visible until the next setStatus/clearStatus (staged in-flight messages).
function setStatus(message, autoHideMs) {
    // Both containers have a status line; write to both so the message follows
    // whichever container is currently visible (and survives a mode switch).
    const statuses = $('#isp_status, #isp_dock_status');
    if (!statuses.length) {
        return;
    }
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    statuses.text(message).show();
    if (autoHideMs) {
        statusTimer = setTimeout(() => {
            statuses.text('').hide();
            statusTimer = null;
        }, autoHideMs);
    }
}

// Hide + clear the status line immediately (paging, panel collapse, etc).
function clearStatus() {
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    $('#isp_status, #isp_dock_status').text('').hide();
}

// Copy the currently shown prompt to the clipboard. Falls back to a temporary
// <textarea> + document.execCommand('copy') because navigator.clipboard is
// unavailable on insecure origins (plain HTTP over LAN).
async function copyPrompt() {
    const prompt = (getActiveEl('prompt').text() || '').trim();
    if (!prompt) {
        toastr.warning('尚無提示詞可複製', '圖片生成');
        return;
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(prompt);
        } else {
            // Insecure-origin fallback: off-screen textarea + execCommand('copy').
            const textarea = document.createElement('textarea');
            textarea.value = prompt;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.top = '0';
            textarea.style.left = '0';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (!copied) {
                throw new Error('execCommand copy 回傳 false');
            }
        }
        toastr.success('已複製', '圖片生成');
    } catch {
        toastr.error('複製失敗', '圖片生成');
    }
}

// Render one history entry into the ACTIVE container's image + prompt line.
// The prompt line shows the FINAL effective prompt (通用前墜 merged in + all
// macros resolved) — exactly the string ST feeds the generator in FREE mode;
// the copy button copies this same text.
function displayEntry(entry) {
    getActiveEl('imgWrap').empty().append($('<img>').attr('src', entry.url).attr('alt', 'Generated image'));
    const finalPrompt = resolveFinalPrompt(entry.prompt);
    getActiveEl('prompt').text(finalPrompt).attr('title', finalPrompt);
    getActivePanel().find('.isp_placeholder').hide();
    // Keep the RAW converted prompt in lastResult so 🔄 regeneration does not
    // end up applying the prefix twice (generateImage → /imagine adds it again).
    lastResult = { url: entry.url, prompt: entry.prompt, ts: entry.ts };
}

// Show the empty-state placeholder and clear the image/prompt line.
function showPlaceholder() {
    getActiveEl('imgWrap').empty();
    getActiveEl('prompt').text('').removeAttr('title');
    getActivePanel().find('.isp_placeholder').show();
    lastResult = null;
}

// Update the pager controls: position indicator + disabled state of prev/next.
function updatePagerUI() {
    const history = getChatHistory(getChatId());
    const total = history.length;
    const pos = (currentIndex >= 0 && currentIndex < total) ? currentIndex + 1 : 0;

    getActiveEl('pos').text(`${pos}/${total}`);
    getActiveEl('prev').toggleClass('isp_disabled', total === 0 || currentIndex <= 0);
    getActiveEl('next').toggleClass('isp_disabled', total === 0 || currentIndex >= total - 1);
}

// Render the current entry (or placeholder) and refresh the pager controls.
function renderPanel() {
    const entry = getCurrentEntry();
    if (entry) {
        displayEntry(entry);
    } else {
        showPlaceholder();
    }
    updatePagerUI();
}

// Jump the pager to the newest entry of the active chat (or empty placeholder).
function jumpToNewest() {
    const history = getChatHistory(getChatId());
    currentIndex = history.length ? history.length - 1 : -1;
    renderPanel();
}

function pagerPrev() {
    clearStatus();
    const history = getChatHistory(getChatId());
    if (!history.length) {
        toastr.warning('尚無歷史圖片，先按 ⚡ 生成一張吧', '圖片生成');
        return;
    }
    if (currentIndex <= 0) {
        toastr.warning('已是第一張', '圖片生成');
        return;
    }
    currentIndex = Math.max(0, currentIndex - 1);
    renderPanel();
}

function pagerNext() {
    clearStatus();
    const history = getChatHistory(getChatId());
    if (!history.length) {
        toastr.warning('尚無歷史圖片，先按 ⚡ 生成一張吧', '圖片生成');
        return;
    }
    if (currentIndex >= history.length - 1) {
        toastr.warning('已是最後一張', '圖片生成');
        return;
    }
    currentIndex = Math.min(history.length - 1, currentIndex + 1);
    renderPanel();
}

// Toggle the busy state on every generation trigger (toolbar gen button + both
// containers' refresh buttons) to prevent double-clicks, and swap their icons
// to a spinner while a generation is running. `isGenerating` mirrors the same
// state and is the single source of truth the auto-generate flow checks.
function setBusy(busy) {
    isGenerating = !!busy;
    $('#isp_gen_btn, #isp_refresh_btn, #isp_dock_refresh').toggleClass('isp_busy', busy);
    $('#isp_gen_btn')
        .toggleClass('fa-bolt', !busy)
        .toggleClass('fa-spinner fa-spin', busy);
    $('#isp_refresh_btn, #isp_dock_refresh')
        .toggleClass('fa-rotate-right', !busy)
        .toggleClass('fa-spinner fa-spin', busy);
}

function openPanel() {
    getActivePanel().addClass('isp_open');
    $('#isp_toggle_btn').addClass('isp_active');
}

// Collapse the panel and clear any transient status (keep the state tidy).
function closePanel() {
    getActivePanel().removeClass('isp_open');
    $('#isp_toggle_btn').removeClass('isp_active');
    clearStatus();
}

// Shared generation pipeline: convert chat context -> generate quietly ->
// append history -> display. Used by the manual ⚡ button and the auto-generate
// flow (the 🔄 refresh reuses generateImage only).
//
// `opts.auto` (auto-generate flow):
//   - never force-opens the panel (generation must not depend on panel state);
//   - failures update only the status line, no toastr.
async function runGenerationPipeline(context, chatId, abortController, opts = {}) {
    const auto = !!opts.auto;
    try {
        // Manual flow opens the panel immediately so the result is visible.
        if (!auto) {
            openPanel();
        }
        const prompt = await convertToPrompt(context, abortController.signal);
        const url = await generateImage(prompt);

        // Append a new entry (newest last), respect the cap, persist.
        const history = getChatHistory(chatId);
        history.push({ url, prompt, ts: Date.now() });
        trimHistory(history);
        saveSettingsDebounced();

        // Position the pager at the newest entry only if still on the same chat.
        if (getChatId() === chatId) {
            currentIndex = history.length - 1;
            renderPanel();
        }

        setStatus('✓ 生成完成', 4000);
        if (!auto) {
            toastr.success('生成完成', '圖片生成');
        }
    } catch (error) {
        if (error?.name !== 'AbortError') {
            if (auto) {
                // Auto failures are unobtrusive: status line only.
                setStatus(`⚠️ 自動生圖失敗：${String(error?.message || error)}`, 6000);
            } else {
                setStatus(`✗ 生成失敗：${String(error?.message || error)}`, 6000);
                toastr.error(String(error?.message || error), '圖片生成');
            }
        } else {
            clearStatus();
        }
    }
}

// Manual ⚡ entry point: one convert + generate, opening the panel eagerly.
async function generateFromChat() {
    if (isGenerating) {
        return;
    }

    setBusy(true);
    // Capture the chat id + context up front so a mid-flight chat switch does not
    // mis-file the result into the wrong chat's history.
    const context = getContext();
    const chatId = getChatId(context);
    const abortController = new AbortController();

    try {
        await runGenerationPipeline(context, chatId, abortController);
    } finally {
        setBusy(false);
    }
}

// Auto-generate entry point (GENERATION_ENDED): same convert+generate flow as
// manual ⚡, but the panel is never force-opened and failures never toastr.
async function runAutoGeneration() {
    if (isGenerating) {
        return;
    }

    setBusy(true);
    // Capture the chat id + context up front so a mid-flight chat switch does not
    // mis-file the result into the wrong chat's history.
    const context = getContext();
    const chatId = getChatId(context);
    const abortController = new AbortController();

    try {
        await runGenerationPipeline(context, chatId, abortController, { auto: true });
    } finally {
        setBusy(false);
    }
}

// --- Auto-generate toggle + event wiring -------------------------------------

// Flip the global auto-generate setting (shared by all chats) and refresh the
// toggle buttons' visuals in both containers.
function toggleAutoGenerate() {
    const settings = getSettings();
    settings.autoGenerate = !settings.autoGenerate;
    saveSettingsDebounced();
    syncAutoButton();
}

// Reflect settings.autoGenerate on both containers' 📷 toggle buttons.
function syncAutoButton() {
    const on = !!getSettings().autoGenerate;
    $('#isp_auto_btn, #isp_dock_auto_btn')
        .toggleClass('isp_auto_on', on)
        .attr('title', on ? '自動生圖：開啟（AI 回覆結束後自動生成）' : '自動生圖：關閉');
}

// GENERATION_ENDED listener: with the toggle on, generate one image per
// completed AI reply. Dedup by the last chat message id (swipes/edits keep the
// same id → skipped); a busy generation also skips (never queue). The actual
// run is debounced 800ms so it starts after the reply has fully settled; a
// newer trigger replaces any still-pending run instead of queueing more.
function handleGenerationEnded() {
    if (!getSettings().autoGenerate) {
        return;
    }

    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const lastMessage = chat[chat.length - 1];
    const messageKey = `${getChatId(context)}/${lastMessage?.id ?? ''}`;
    if (!lastMessage?.id || messageKey === autoLastMessageKey) {
        // Same final message as last time (swipe/rewind/edit) — do not re-run.
        return;
    }
    if (isGenerating) {
        // Previous image still generating — skip, never queue.
        return;
    }

    autoLastMessageKey = messageKey;

    if (autoPendingTimeout) {
        clearTimeout(autoPendingTimeout);
    }
    autoPendingTimeout = setTimeout(() => {
        autoPendingTimeout = null;
        void runAutoGeneration();
    }, AUTO_GENERATE_DELAY_MS);
}

// Re-run generation for the viewed entry (or lastResult) with a new random seed,
// updating that entry in place.
async function refreshImage() {
    const chatId = getChatId();
    const history = getChatHistory(chatId);
    const entry = (currentIndex >= 0 && currentIndex < history.length) ? history[currentIndex] : null;
    const prompt = entry?.prompt || lastResult?.prompt;

    if (!prompt) {
        toastr.warning('尚無可重新生成的提示詞。', '圖片生成');
        return;
    }
    if (isGenerating) {
        return;
    }

    setBusy(true);

    try {
        const url = await generateImage(prompt, { randomSeed: true });

        if (entry) {
            // Update the viewed entry in place (new url + timestamp).
            entry.url = url;
            entry.ts = Date.now();
        } else {
            // Defensive: lastResult exists but no entry — record it as a new one.
            history.push({ url, prompt, ts: Date.now() });
            trimHistory(history);
        }
        saveSettingsDebounced();

        if (getChatId() === chatId) {
            if (!entry) {
                currentIndex = history.length - 1;
            }
            renderPanel();
        }

        setStatus('✓ 生成完成', 4000);
        toastr.success('生成完成', '圖片生成');
    } catch (error) {
        setStatus(`✗ 生成失敗：${String(error?.message || error)}`, 6000);
        toastr.error(String(error?.message || error), '圖片生成');
    } finally {
        setBusy(false);
    }
}

// --- Toolbar + panel construction -------------------------------------------

// Panel toggle button (M1 role kept) + the new generate button, both in the
// input toolbar.
function buildButton() {
    const container = $('#rightSendForm');
    if (!container.length) {
        return;
    }

    const toggle = $(`
        <div id="isp_toggle_btn"
             class="interactable fa-solid fa-wand-magic-sparkles"
             title="圖片生成面板"></div>
    `);
    const gen = $(`
        <div id="isp_gen_btn"
             class="interactable fa-solid fa-bolt"
             title="生成圖片"></div>
    `);

    container.append(toggle, gen);

    toggle.on('click', () => {
        if (getActivePanel().hasClass('isp_open')) {
            closePanel();
        } else {
            openPanel();
        }
    });

    gen.on('click', generateFromChat);
}

// --- Floating panel geometry (drag + resize + persist) ----------------------

const PANEL_DEFAULT_W = 340;
const PANEL_DEFAULT_H = 360;
const PANEL_MIN_W = 240;
const PANEL_MIN_H = 240;

// Default (unsaved) position: the old visual spot above the input, right-aligned.
function getDefaultPanelRect() {
    const shell = document.getElementById('form_sheld');
    if (shell) {
        const rect = shell.getBoundingClientRect();
        return {
            x: rect.right - PANEL_DEFAULT_W - 8,
            y: rect.top - PANEL_DEFAULT_H - 8,
            w: PANEL_DEFAULT_W,
            h: PANEL_DEFAULT_H,
        };
    }
    // Fallback when #form_sheld is missing: top-right corner of the viewport.
    return {
        x: window.innerWidth - PANEL_DEFAULT_W - 8,
        y: 8,
        w: PANEL_DEFAULT_W,
        h: PANEL_DEFAULT_H,
    };
}

// Clamp a rect so the panel stays fully visible within the viewport.
function clampRectToViewport(rect) {
    const maxW = Math.floor(window.innerWidth * 0.9);
    const maxH = Math.floor(window.innerHeight * 0.9);
    const w = Math.max(PANEL_MIN_W, Math.min(rect.w, maxW));
    const h = Math.max(PANEL_MIN_H, Math.min(rect.h, maxH));
    const x = Math.max(0, Math.min(rect.x, window.innerWidth - w));
    const y = Math.max(0, Math.min(rect.y, window.innerHeight - h));
    return { x, y, w, h };
}

// Return the persisted panel rect, or null when absent/invalid.
function getSavedPanelRect() {
    const saved = getSettings().panel;
    if (saved && typeof saved === 'object') {
        const { x, y, w, h } = saved;
        if ([x, y, w, h].every(value => Number.isFinite(value)) && w > 0 && h > 0) {
            return { x, y, w, h };
        }
    }
    return null;
}

// Apply a rect to the panel via inline styles (left/top/width/height).
function applyPanelRect(panel, rect) {
    panel.css({
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
    });
}

// Read the current inline rect (set by jQuery UI / applyPanelRect).
function readPanelRect(panel) {
    const style = panel[0].style;
    const rect = {
        x: parseFloat(style.left),
        y: parseFloat(style.top),
        w: parseFloat(style.width),
        h: parseFloat(style.height),
    };
    if ([rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) {
        return rect;
    }
    return null;
}

// Persist the current panel rect into extension settings (debounced save).
function savePanelRect() {
    const panel = document.getElementById('isp_panel');
    if (!panel) {
        return;
    }
    const rect = readPanelRect($(panel));
    if (!rect) {
        return;
    }
    getSettings().panel = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    saveSettingsDebounced();
}

// Clear the saved rect and restore the default position + size.
function resetPanelPosition() {
    getSettings().panel = null;
    saveSettings();
    applyPanelRect($('#isp_panel'), getDefaultPanelRect());
}

// Wire up jQuery UI drag/resize, the title double-click reset, and viewport
// clamping on window resize. Containment is deliberately NOT passed to jQuery
// UI: containment:'window' + position:fixed throws "Cannot read properties of
// undefined (reading 'left')" inside jquery-ui resizable — we clamp in stop.
function initPanelFloat(panel) {
    const clampAndSave = () => {
        const rect = readPanelRect(panel);
        if (rect) {
            applyPanelRect(panel, clampRectToViewport(rect));
        }
        // Save immediately (not debounced): drag/resize stop is a rare event and
        // the 1000ms debounce would lose the position if the user refreshes
        // right after dragging.
        savePanelRect();
        saveSettings();
    };

    // Drag by the header; the action buttons are excluded so clicks still work.
    panel.draggable({
        handle: '.isp_header',
        cancel: '.isp_header_actions',
        stop: clampAndSave,
    });

    // Resize from the bottom-right handle only, bounded to the viewport.
    panel.resizable({
        handles: 'se',
        minWidth: PANEL_MIN_W,
        minHeight: PANEL_MIN_H,
        maxWidth: Math.floor(window.innerWidth * 0.9),
        maxHeight: Math.floor(window.innerHeight * 0.9),
        stop: clampAndSave,
    });

    // Double-click the title text to reset position+size. Guarded so it only
    // fires on the title itself (never the action buttons) and not after a drag.
    let titlePressPos = null;
    let titleWasDragged = false;

    panel.find('.isp_title').on('mousedown', function (event) {
        titlePressPos = { x: event.pageX, y: event.pageY };
        titleWasDragged = false;
    });

    // A real drag (>=5px between mousedown and mouseup) marks the press as a drag.
    $(document).on('mouseup.isp_title', function (event) {
        if (!titlePressPos) {
            return;
        }
        const dx = event.pageX - titlePressPos.x;
        const dy = event.pageY - titlePressPos.y;
        if (Math.abs(dx) >= 5 || Math.abs(dy) >= 5) {
            titleWasDragged = true;
        }
        titlePressPos = null;
    });

    panel.find('.isp_title').on('dblclick', function (event) {
        if (!$(event.target).is('.isp_title')) {
            return;
        }
        if (titleWasDragged) {
            titleWasDragged = false;
            return;
        }
        resetPanelPosition();
    });

    // Keep the panel within the viewport when the window resizes.
    $(window).on('resize', () => {
        const maxW = Math.floor(window.innerWidth * 0.9);
        const maxH = Math.floor(window.innerHeight * 0.9);
        try {
            panel.resizable('option', 'maxWidth', maxW);
            panel.resizable('option', 'maxHeight', maxH);
        } catch {
            // Resizable not initialized — nothing to update.
        }
        const rect = readPanelRect(panel);
        if (rect) {
            applyPanelRect(panel, clampRectToViewport(rect));
        }
    });
}

function buildPanel() {
    const panel = $(`
        <div id="isp_panel">
            <div class="isp_header">
                <span class="isp_title">圖片生成</span>
                <div class="isp_header_actions">
                    <div id="isp_prev_btn"
                         class="interactable fa-solid fa-chevron-left isp_disabled"
                         title="上一張"></div>
                    <span id="isp_pos" class="isp_pos">0/0</span>
                    <div id="isp_next_btn"
                         class="interactable fa-solid fa-chevron-right isp_disabled"
                         title="下一張"></div>
                    <div id="isp_refresh_btn"
                         class="interactable fa-solid fa-rotate-right"
                         title="重新生成"></div>
                    <div id="isp_auto_btn"
                         class="interactable fa-solid fa-camera"
                         title="自動生圖：關閉"></div>
                    <div id="isp_pin_btn"
                         class="interactable fa-solid fa-thumbtack"
                         title="固定模式"></div>
                    <div class="isp_collapse interactable fa-solid fa-chevron-down"
                         title="收合"></div>
                </div>
            </div>
            <div class="isp_body">
                <div id="isp_status" class="isp_status"></div>
                <div class="isp_prompt_drawer isp_collapsed">
                    <div id="isp_prompt_toggle" class="isp_prompt_toggle" title="展開/收合提示詞">
                        <span class="isp_prompt_toggle_label">💡 提示詞 <span class="isp_prompt_chevron">▸</span></span>
                        <div id="isp_copy_btn" class="interactable fa-solid fa-copy" title="複製提示詞"></div>
                    </div>
                    <div id="isp_prompt" class="isp_prompt"></div>
                </div>
                <div id="isp_img_wrap" class="isp_img_wrap"></div>
                <div class="isp_placeholder">點擊輸入框的 ⚡ 生成圖片</div>
            </div>
        </div>
    `);

    // Append to body so fixed positioning is viewport-relative and jQuery UI
    // containment works naturally.
    $(document.body).append(panel);

    panel.find('.isp_collapse').on('click', closePanel);
    panel.find('#isp_pin_btn').on('click', pinToFixed);
    panel.find('#isp_refresh_btn').on('click', refreshImage);
    panel.find('#isp_auto_btn').on('click', toggleAutoGenerate);
    panel.find('#isp_prev_btn').on('click', pagerPrev);
    panel.find('#isp_next_btn').on('click', pagerNext);

    // Prompt drawer: toggle collapse state; ignore clicks landing on the copy
    // button (it handles its own click via the separate handler below).
    panel.find('#isp_prompt_toggle').on('click', function (event) {
        if ($(event.target).closest('#isp_copy_btn').length) {
            return;
        }
        const drawer = $(this).closest('.isp_prompt_drawer');
        const collapsed = drawer.toggleClass('isp_collapsed').hasClass('isp_collapsed');
        drawer.find('.isp_prompt_chevron').text(collapsed ? '▸' : '▾');
    });
    panel.find('#isp_copy_btn').on('click', copyPrompt);

    // Position: restore the saved rect, otherwise fall back to the default spot.
    const saved = getSavedPanelRect();
    const rect = saved ? clampRectToViewport(saved) : getDefaultPanelRect();
    applyPanelRect(panel, rect);
    initPanelFloat(panel);
}

// --- Docked strip (fixed mode) ----------------------------------------------

// Max dock height: 60% of the viewport height, clamped to at least the minimum.
function getDockMaxHeight() {
    return Math.max(DOCK_MIN_H, Math.floor(window.innerHeight * 0.6));
}

// Clamp a candidate dock height into [DOCK_MIN_H, 60% viewport].
function clampDockHeight(height) {
    return Math.max(DOCK_MIN_H, Math.min(height, getDockMaxHeight()));
}

// Keep the collapse chevron + title in sync with the persisted collapsed state.
function syncDockCollapseIcon() {
    const collapsed = !!getSettings().fixedCollapsed;
    $('#isp_dock_collapse')
        .toggleClass('fa-chevron-up', !collapsed)
        .toggleClass('fa-chevron-down', collapsed)
        .attr('title', collapsed ? '展開' : '收合');
}

// Apply (but do NOT persist) the collapsed state: collapsed shows only the 32px
// header and disables resizing; expanded restores the full `fixedHeight`.
function applyDockCollapsed(collapsed) {
    const dock = $('#isp_dock');
    dock.toggleClass('isp_dock_collapsed', collapsed);
    if (collapsed) {
        dock.height(DOCK_HEADER_H);
        try { dock.resizable('disable'); } catch { /* resizable not ready yet */ }
    } else {
        dock.height(getSettings().fixedHeight || DOCK_DEFAULT_H);
        try { dock.resizable('enable'); } catch { /* resizable not ready yet */ }
    }
    getSettings().fixedCollapsed = collapsed;
    syncDockCollapseIcon();
}

function expandDock() {
    applyDockCollapsed(false);
    saveSettings();
}

function collapseDock() {
    applyDockCollapsed(true);
    saveSettings();
}

function toggleDockCollapse() {
    if (getSettings().fixedCollapsed) {
        expandDock();
    } else {
        collapseDock();
    }
}

// Wire the bottom-edge splitter (jQuery UI resizable, handles:'s'). No
// containment — containment:'window' + non-standard positioning throws inside
// jquery-ui resizable (M5 lesson) — so we clamp in stop, then persist.
function initDockResize(dock) {
    dock.resizable({
        handles: 's',
        minHeight: DOCK_MIN_H,
        maxHeight: getDockMaxHeight(),
        stop: () => {
            const clamped = clampDockHeight(dock.height());
            dock.height(clamped);
            // Keep width flowing with the shell (CSS width:100%) instead of a
            // fixed inline px that would go stale if the shell is later resized.
            dock.css('width', '');
            getSettings().fixedHeight = clamped;
            saveSettings(); // immediate: resize stop is a rare event
        },
    });

    // Keep the dock within bounds when the viewport resizes.
    $(window).on('resize.isp_dock', () => {
        try {
            dock.resizable('option', 'maxHeight', getDockMaxHeight());
        } catch {
            // Resizable not initialized — nothing to update.
        }
        if (getSettings().fixedCollapsed) {
            return;
        }
        const clamped = clampDockHeight(dock.height());
        dock.height(clamped);
        getSettings().fixedHeight = clamped;
    });
}

// Switch the visible container between floating and fixed (docked) modes, and
// re-render the current chat's entry into the newly active container.
function switchPanelMode(mode) {
    getSettings().panelMode = mode;
    saveSettings(); // immediate: pin/unpin is a rare event

    const fixed = mode === 'fixed';
    if (fixed) {
        $('#isp_panel').removeClass('isp_open');
        $('#isp_dock').addClass('isp_open');
        $('#isp_toggle_btn').addClass('isp_active');
        // Honor the persisted collapsed state (do not force-expand on pin).
        applyDockCollapsed(!!getSettings().fixedCollapsed);
    } else {
        $('#isp_dock').removeClass('isp_open');
        // The floating panel keeps its saved rect (inline left/top/width/height
        // are untouched) — we only toggle visibility.
        $('#isp_panel').addClass('isp_open');
        $('#isp_toggle_btn').addClass('isp_active');
    }
    clearStatus();
    renderPanel();
}

function pinToFixed() {
    switchPanelMode('fixed');
}

function unpinToFloating() {
    switchPanelMode('floating');
}

// Show the correct container for the persisted panelMode on load. Floating is
// the default and starts collapsed (existing behavior); fixed shows the dock.
function applyInitialMode() {
    if (isFixedMode()) {
        $('#isp_panel').removeClass('isp_open');
        $('#isp_dock').addClass('isp_open');
        $('#isp_toggle_btn').addClass('isp_active');
        applyDockCollapsed(!!getSettings().fixedCollapsed);
    } else {
        $('#isp_dock').removeClass('isp_open');
        $('#isp_panel').removeClass('isp_open');
        $('#isp_toggle_btn').removeClass('isp_active');
    }
}

function buildDock() {
    const dock = $(`
        <div id="isp_dock" class="isp_dock">
            <div class="isp_dock_header isp_header">
                <span class="isp_title">圖片生成</span>
                <div class="isp_header_actions">
                    <div id="isp_dock_prev"
                         class="interactable fa-solid fa-chevron-left isp_disabled"
                         title="上一張"></div>
                    <span id="isp_dock_pos" class="isp_pos">0/0</span>
                    <div id="isp_dock_next"
                         class="interactable fa-solid fa-chevron-right isp_disabled"
                         title="下一張"></div>
                    <div id="isp_dock_refresh"
                         class="interactable fa-solid fa-rotate-right"
                         title="重新生成"></div>
                    <div id="isp_dock_auto_btn"
                         class="interactable fa-solid fa-camera"
                         title="自動生圖：關閉"></div>
                    <div id="isp_dock_prompt_toggle" class="interactable" title="展開/收合提示詞">
                        <span class="isp_prompt_toggle_label">💡 <span class="isp_prompt_chevron">▸</span></span>
                        <div id="isp_dock_copy" class="interactable fa-solid fa-copy" title="複製提示詞"></div>
                    </div>
                    <div id="isp_dock_collapse"
                         class="interactable fa-solid fa-chevron-up"
                         title="收合"></div>
                    <div id="isp_dock_unpin"
                         class="interactable fa-solid fa-unlink"
                         title="浮動模式"></div>
                </div>
            </div>
            <div class="isp_dock_body isp_body">
                <div id="isp_dock_status" class="isp_status"></div>
                <div id="isp_dock_img_wrap" class="isp_img_wrap"></div>
                <div id="isp_dock_prompt" class="isp_prompt"></div>
                <div class="isp_placeholder">點擊輸入框的 ⚡ 生成圖片</div>
            </div>
        </div>
    `);

    // Insert as the first visible child of #sheld, before #chat, so the strip
    // sits between the topbar and the chat area and takes real layout space
    // (#sheld is flex-direction:column; #chat has flex-grow:1 and shrinks).
    $('#sheld').find('#chat').before(dock);

    dock.find('#isp_dock_prev').on('click', pagerPrev);
    dock.find('#isp_dock_next').on('click', pagerNext);
    dock.find('#isp_dock_refresh').on('click', refreshImage);
    dock.find('#isp_dock_auto_btn').on('click', toggleAutoGenerate);
    dock.find('#isp_dock_unpin').on('click', unpinToFloating);
    dock.find('#isp_dock_collapse').on('click', toggleDockCollapse);
    dock.find('#isp_dock_copy').on('click', copyPrompt);

    // Prompt toggle lives in the dock header (wide layout); ignore clicks on
    // the copy button nested inside it.
    dock.find('#isp_dock_prompt_toggle').on('click', function (event) {
        if ($(event.target).closest('#isp_dock_copy').length) {
            return;
        }
        const open = dock.toggleClass('isp_dock_prompt_open').hasClass('isp_dock_prompt_open');
        dock.find('#isp_dock_prompt_toggle .isp_prompt_chevron').text(open ? '▾' : '▸');
    });

    // Clicking the (collapsed) header expands the dock back.
    dock.find('.isp_dock_header').on('click', function (event) {
        if (!getSettings().fixedCollapsed) {
            return;
        }
        if ($(event.target).closest('.isp_header_actions').length) {
            return;
        }
        expandDock();
    });

    initDockResize(dock);
    applyDockCollapsed(!!getSettings().fixedCollapsed);
}

// --- Settings panel ----------------------------------------------------------

// Populate the LLM profile dropdown from connectionManager.profiles. The first
// option (empty value) means "auto-pick DeepSeek" when profileId is unset.
function populateProfileDropdown() {
    const select = $('#isp_profile');
    if (!select.length) {
        return;
    }

    const settings = getSettings();
    const profiles = Array.isArray(extension_settings.connectionManager?.profiles)
        ? extension_settings.connectionManager.profiles
        : [];

    select.empty();
    $('<option>').val('').text('（自動選擇 DeepSeek）').appendTo(select);
    for (const profile of profiles) {
        if (!profile?.id) {
            continue;
        }
        $('<option>').val(profile.id).text(profile.name || profile.id).appendTo(select);
    }

    // Select the saved profile; fall back to the empty placeholder if it no
    // longer exists in the profile list.
    select.val(settings.profileId || '');
    if (select.val() === null) {
        select.val('');
    }
}

// Load the active template's text into the editor textarea (defensive DOM check).
// Text flows through jQuery .val() to avoid handlebars escaping issues.
function loadActiveTemplateEditor() {
    const textarea = $('#isp_conversion_template');
    if (!textarea.length) {
        return;
    }
    const settings = getSettings();
    const name = settings.activeTemplate;
    const templates = (settings.templates && typeof settings.templates === 'object' && !Array.isArray(settings.templates))
        ? settings.templates
        : {};
    textarea.val(templates[name] || '');
}

// Rebuild the template dropdown from settings.templates and select the active
// template (falling back to the first available if the active one is gone).
function refreshTemplateSelect() {
    const select = $('#isp_template_select');
    if (!select.length) {
        return;
    }
    const settings = getSettings();
    const templates = (settings.templates && typeof settings.templates === 'object' && !Array.isArray(settings.templates))
        ? settings.templates
        : {};

    select.empty();
    for (const name of Object.keys(templates)) {
        $('<option>').val(name).text(name).appendTo(select);
    }

    let active = settings.activeTemplate;
    if (!active || !Object.prototype.hasOwnProperty.call(templates, active)) {
        active = Object.prototype.hasOwnProperty.call(templates, DEFAULT_ACTIVE_TEMPLATE)
            ? DEFAULT_ACTIVE_TEMPLATE
            : (Object.keys(templates)[0] || '');
        settings.activeTemplate = active;
    }
    select.val(active);
    if (select.val() === null) {
        select.val('');
    }
}

// Add a new template: prompt for a name, reject empty/duplicate, seed the new
// template with a copy of the active template's text, make it active, and
// refresh the dropdown + editor.
async function addTemplate() {
    const settings = getSettings();
    if (!settings.templates || typeof settings.templates !== 'object' || Array.isArray(settings.templates)) {
        settings.templates = { ...DEFAULT_TEMPLATES };
    }

    const userInput = await callGenericPopup('新增模板名稱：', POPUP_TYPE.INPUT, '');
    // null = X/Escape, false = cancel button — both mean "user cancelled".
    if (userInput === null || userInput === false) {
        return;
    }
    const name = String(userInput).trim();
    if (!name) {
        toastr.warning('模板名稱不可為空', '圖片生成');
        return;
    }
    if (Object.prototype.hasOwnProperty.call(settings.templates, name)) {
        toastr.warning('模板名稱已存在', '圖片生成');
        return;
    }

    // New template starts with a copy of the active template's text.
    settings.templates[name] = settings.templates[settings.activeTemplate]
        || DEFAULT_TEMPLATES[DEFAULT_ACTIVE_TEMPLATE]
        || '';
    settings.activeTemplate = name;
    saveSettingsDebounced();

    refreshTemplateSelect();
    loadActiveTemplateEditor();
    toastr.success('已新增模板', '圖片生成');
}

// Delete the active template. Refuse when it is the LAST one; otherwise remove
// it and switch activeTemplate to the first remaining template.
function deleteTemplate() {
    const settings = getSettings();
    if (!settings.templates || typeof settings.templates !== 'object' || Array.isArray(settings.templates)) {
        settings.templates = { ...DEFAULT_TEMPLATES };
    }

    const names = Object.keys(settings.templates);
    if (names.length <= 1) {
        toastr.warning('至少需保留一個模板，無法刪除', '圖片生成');
        return;
    }

    const name = settings.activeTemplate;
    if (!name || !Object.prototype.hasOwnProperty.call(settings.templates, name)) {
        return;
    }

    delete settings.templates[name];
    // The deleted template was active → switch to the first remaining one.
    settings.activeTemplate = Object.keys(settings.templates)[0];
    saveSettingsDebounced();

    refreshTemplateSelect();
    loadActiveTemplateEditor();
    toastr.success('已刪除模板', '圖片生成');
}

function bindSettings() {
    $('#isp_profile').on('change', function () {
        getSettings().profileId = String($(this).val() || '');
        saveSettingsDebounced();
    });

    $('#isp_context_messages').on('input', function () {
        const value = Number($(this).val());
        getSettings().contextMessages = Math.min(10, Math.max(1, Number.isFinite(value) ? value : 2));
        saveSettingsDebounced();
    });

    // The conversion template textarea edits the CURRENTLY selected template's
    // text in place (auto-save on input), same flow as the old single field.
    $('#isp_conversion_template').on('input', function () {
        const settings = getSettings();
        const name = settings.activeTemplate;
        if (name && settings.templates && typeof settings.templates === 'object' && !Array.isArray(settings.templates)) {
            settings.templates[name] = String($(this).val() || '');
            saveSettingsDebounced();
        }
    });

    // Template selector: switching the active template saves it and reloads its
    // text into the editor.
    $('#isp_template_select').on('change', function () {
        getSettings().activeTemplate = String($(this).val() || DEFAULT_ACTIVE_TEMPLATE);
        saveSettingsDebounced();
        loadActiveTemplateEditor();
    });

    $('#isp_template_add').on('click', addTemplate);
    $('#isp_template_del').on('click', deleteTemplate);
}

// Render the inline-drawer settings template and wire its inputs. Profiles are
// static enough to populate once at init.
async function buildSettings() {
    const container = $('#extensions_settings');
    if (!container.length) {
        return;
    }

    const template = await renderExtensionTemplateAsync('sillytavern-img-sidepanel', 'settings');
    container.append(template);

    // Fill persisted values directly (avoids handlebars escaping issues).
    const settings = getSettings();
    $('#isp_context_messages').val(settings.contextMessages);

    populateProfileDropdown();
    refreshTemplateSelect();
    loadActiveTemplateEditor();
    bindSettings();
}

function jQueryReady() {
    return new Promise(resolve => $(resolve));
}

export async function init() {
    initSettings();

    // Wrap DOM work in jQuery ready to be safe against load ordering.
    await jQueryReady();

    buildButton();
    buildPanel();
    buildDock();
    applyInitialMode();
    syncAutoButton();

    // Switch the pager to the newly active chat whenever the user changes chats.
    eventSource.on(event_types.CHAT_CHANGED, () => jumpToNewest());

    // Auto-generate: after every completed AI reply, run one quiet generation
    // when the toggle is on (deduplicated per message id, never queued).
    eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);

    await buildSettings();

    // Restore the ACTIVE container to the newest entry of the current chat.
    jumpToNewest();
}

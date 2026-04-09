const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: document.getElementById('game-container').clientWidth,
    height: document.getElementById('game-container').clientHeight,
    transparent: true,
    scene: {
        preload: preload,
        create: create,
        update: update
    },
    scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
    }
};

let game = null;
/** Declared before `syncGameContainerPointerEvents` runs at load (avoid TDZ ReferenceError). */
let gameState = null;

function getGameContainer() {
    return document.getElementById('game-container');
}

/** Keep pointer-events off the canvas unless battle is active — otherwise WebKit can composite the WebGL layer above queue/hero-select HTML. Phaser sets the canvas to pointer-events:auto by default, which steals clicks in menu dead-zones (side margins). See `#game-container` / `.game-container--battle` in style.css. */
function syncGameContainerPointerEvents() {
    const gc = getGameContainer();
    if (!gc) return;
    const battle = !!(gameState && gameState.status === 'IN_PROGRESS');
    gc.classList.toggle('game-container--battle', battle);
    gc.style.pointerEvents = battle ? 'auto' : 'none';
}

function syncRootLayoutClasses() {
    const html = document.documentElement;
    html.classList.toggle('layout-mobile', window.matchMedia('(max-width: 768px)').matches);
    html.classList.toggle('layout-portrait', window.matchMedia('(orientation: portrait)').matches);
}

window.addEventListener('resize', syncRootLayoutClasses);
syncRootLayoutClasses();
syncGameContainerPointerEvents();

function initGame() {
    if (game) return; // Already running
    console.log("[Game] Initializing Phaser Instance");
    const container = document.getElementById('game-container');
    if (container) {
        container.style.display = 'block';
        container.innerHTML = ''; // Clear previous leftovers
    }
    game = new Phaser.Game(config);
}

function destroyGame() {
    if (!game) return;
    console.log("[Game] Nuclear Clear: Destroying Phaser Instance");
    try {
        game.destroy(true); // true = remove canvas from DOM
        game = null;
        playerLeftShape = null;
        playerRightShape = null;
        phaserLayoutBattleMode = false;
        const container = document.getElementById('game-container');
        if (container) {
            container.innerHTML = '';
            container.style.display = 'none';
        }
    } catch (e) {
        console.error("[Game] Destroy failed", e);
    }
}

// Initial boot
initGame();

let socket;
let myPlayerId = null;
let prevMyHealth = -1;
let prevOpponentHealth = -1;
let prevTeammateHealth = -1; // 2v2
let prevOpponent2Health = -1; // 2v2
let reconnectAttempts = 0;
let reconnectTimer = null;
let manualSocketClose = false;
let lastReportContext = { reportedUid: null, roomId: null };
let lastRoomId = null;
let lastTurnSnapshot = null;
let heroSelectLocked = false;
let heroSelectPick = { charId: null, skin: 'Default' };
let heroSelectCountdownUntil = 0;
let heroSelectCountdownTimer = null;

const matchStats = {
    active: false,
    damageDealt: 0,
    damageTaken: 0,
    abilitiesUsed: 0,
    turnSwaps: 0
};

// Session persistence logic
function generateUUID() {
    // crypto.randomUUID() only works in secure contexts (HTTPS/localhost).
    // This fallback works on plain HTTP LAN addresses too.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback using crypto.getRandomValues (works in all contexts)
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

let localUid = localStorage.getItem('lumen_clash_uid');
if (!localUid) {
    localUid = generateUUID();
    localStorage.setItem('lumen_clash_uid', localUid);
}

let activeSocialTab = 'friends';
let guildDirectoryCache = [];
let guildFocusState = null;
let guildScrollState = 0;
let guildContainerScrollState = 0;
let guildTabPanelScrollState = 0;
let guildDirectoryFilters = { query: '', recruitingOnly: true, sort: 'fit' };
let guildNoGuildView = 'home';
let guildInfoHydrationPromise = null;
let guildDraftState = {
    createName: '',
    createTag: '',
    createDescription: '',
    createIcon: 'comet',
    createBanner: 'aurora',
    createPrivacy: 'public',
    joinCode: '',
    adminGuildId: null,
    adminDescription: '',
    adminIcon: 'comet',
    adminBanner: 'aurora',
    adminPrivacy: 'public',
    adminRecruitmentStatus: 'recruiting',
    adminRecruitmentMessage: '',
    adminRecruitmentFocus: 'all_modes',
    adminRecruitmentPlaystyle: 'mixed',
    adminBulletinMessage: '',
    chatGuildId: null,
    chatInput: ''
};

const GUILD_ICON_PRESETS = [
    { id: 'comet', label: 'Comet', crest: 'CM' },
    { id: 'crown', label: 'Crown', crest: 'CR' },
    { id: 'nova', label: 'Nova', crest: 'NV' },
    { id: 'wolf', label: 'Wolf', crest: 'WF' }
];

const GUILD_BANNER_PRESETS = [
    { id: 'aurora', label: 'Aurora' },
    { id: 'ember', label: 'Ember' },
    { id: 'forest', label: 'Forest' },
    { id: 'royal', label: 'Royal' }
];

// ============================================================
// CLIENT PREFERENCES (perf overlay + accessibility)
// ============================================================
const PREF_KEYS = {
    perfOverlay: 'lumen_clash_perf_overlay',
    a11yLarge: 'lumen_clash_a11y_large',
    a11yContrast: 'lumen_clash_a11y_contrast',
    a11yHpAlt: 'lumen_clash_a11y_hp_alt',
    reduceMotion: 'lumen_clash_reduce_motion',
    menuVfxOff: 'lumen_clash_menu_vfx_off',
    cameraShake: 'lumen_clash_camera_shake',
    hitStop: 'lumen_clash_hit_stop',
    lastMenuCharacter: 'lumen_clash_last_char_id'
};

function prefOn(key) {
    return localStorage.getItem(key) === 'on';
}

function applyPreferenceClasses() {
    const root = document.documentElement;
    root.classList.toggle('pref-a11y-large', prefOn(PREF_KEYS.a11yLarge));
    root.classList.toggle('pref-a11y-contrast', prefOn(PREF_KEYS.a11yContrast));
    root.classList.toggle('pref-a11y-hp-alt', prefOn(PREF_KEYS.a11yHpAlt));
    root.classList.toggle('pref-reduce-motion', prefOn(PREF_KEYS.reduceMotion));
    root.classList.toggle('pref-menu-vfx-off', prefOn(PREF_KEYS.menuVfxOff));
}

let perfOverlayRunning = false;
let perfRafId = null;
let perfPingInterval = null;
let perfFrames = 0;
let perfLastStamp = performance.now();
let perfLastPingMs = null;

function syncPerfOverlayVisibility() {
    const el = document.getElementById('perf-overlay');
    if (!el) return;
    const show = prefOn(PREF_KEYS.perfOverlay);
    el.classList.toggle('hidden', !show);
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function perfFrame(now) {
    if (!prefOn(PREF_KEYS.perfOverlay)) {
        perfOverlayRunning = false;
        return;
    }
    perfFrames++;
    const dt = now - perfLastStamp;
    if (dt >= 500) {
        const fps = Math.round((perfFrames * 1000) / dt);
        perfFrames = 0;
        perfLastStamp = now;
        const fpsEl = document.getElementById('perf-fps');
        if (fpsEl) fpsEl.textContent = `${fps} FPS`;
        const pingEl = document.getElementById('perf-ping');
        if (pingEl) {
            pingEl.textContent = perfLastPingMs != null ? `Ping ${perfLastPingMs}ms` : 'Ping …';
        }
    }
    perfRafId = requestAnimationFrame(perfFrame);
}

function measureProfilePing() {
    if (!prefOn(PREF_KEYS.perfOverlay)) return;
    const uid = localUid;
    if (!uid) return;
    const t0 = performance.now();
    fetch(`/profile?uid=${encodeURIComponent(uid)}`, { cache: 'no-store' })
        .then(() => {
            perfLastPingMs = Math.round(performance.now() - t0);
        })
        .catch(() => {
            perfLastPingMs = null;
        });
}

function startPerfOverlayLoop() {
    if (perfOverlayRunning) return;
    perfOverlayRunning = true;
    perfLastStamp = performance.now();
    perfFrames = 0;
    perfRafId = requestAnimationFrame(perfFrame);
    measureProfilePing();
    if (perfPingInterval) clearInterval(perfPingInterval);
    perfPingInterval = setInterval(measureProfilePing, 5000);
}

function stopPerfOverlayLoop() {
    perfOverlayRunning = false;
    if (perfRafId) {
        cancelAnimationFrame(perfRafId);
        perfRafId = null;
    }
    if (perfPingInterval) {
        clearInterval(perfPingInterval);
        perfPingInterval = null;
    }
}

function setPerfOverlayPref(enabled) {
    localStorage.setItem(PREF_KEYS.perfOverlay, enabled ? 'on' : 'off');
    syncPerfOverlayVisibility();
    if (enabled) startPerfOverlayLoop();
    else stopPerfOverlayLoop();
}

function initClientPreferences() {
    applyPreferenceClasses();
    syncPerfOverlayVisibility();
    if (prefOn(PREF_KEYS.perfOverlay)) startPerfOverlayLoop();
}

function toggleStoredPref(key) {
    if (prefOn(key)) {
        localStorage.removeItem(key);
        return false;
    }
    localStorage.setItem(key, 'on');
    return true;
}

function getLevelPref(key, fallback = 'medium') {
    const val = localStorage.getItem(key);
    if (!val) return fallback;
    return val;
}

function cycleLevelPref(key) {
    const order = ['off', 'medium', 'high'];
    const current = getLevelPref(key);
    const idx = order.indexOf(current);
    const next = order[(idx + 1 + order.length) % order.length];
    localStorage.setItem(key, next);
    return next;
}

function toTitleCaseLevel(val) {
    if (val === 'off') return 'Off';
    if (val === 'high') return 'High';
    return 'Medium';
}

function cameraShakeAmount() {
    const level = getLevelPref(PREF_KEYS.cameraShake);
    if (level === 'off') return 0;
    if (level === 'high') return 0.03;
    return 0.015;
}

function hitStopMs() {
    const level = getLevelPref(PREF_KEYS.hitStop);
    if (level === 'off') return 0;
    if (level === 'high') return 90;
    return 45;
}

function refreshPreferenceSettingsLabels() {
    const perfBtn = document.getElementById('btn-perf-overlay');
    if (perfBtn) perfBtn.textContent = `Performance overlay: ${prefOn(PREF_KEYS.perfOverlay) ? 'ON' : 'OFF'}`;
    const largeBtn = document.getElementById('btn-a11y-large-text');
    if (largeBtn) largeBtn.textContent = `Larger UI text: ${prefOn(PREF_KEYS.a11yLarge) ? 'ON' : 'OFF'}`;
    const conBtn = document.getElementById('btn-a11y-high-contrast');
    if (conBtn) conBtn.textContent = `High contrast UI: ${prefOn(PREF_KEYS.a11yContrast) ? 'ON' : 'OFF'}`;
    const hpBtn = document.getElementById('btn-a11y-hp-bars');
    if (hpBtn) hpBtn.textContent = `HP bar colors: ${prefOn(PREF_KEYS.a11yHpAlt) ? 'High-visibility' : 'Default'}`;
    const rmBtn = document.getElementById('btn-reduce-motion');
    if (rmBtn) rmBtn.textContent = `Reduce motion: ${prefOn(PREF_KEYS.reduceMotion) ? 'ON' : 'OFF'}`;
    const vfxBtn = document.getElementById('btn-menu-vfx');
    if (vfxBtn) vfxBtn.textContent = `Menu VFX: ${prefOn(PREF_KEYS.menuVfxOff) ? 'OFF' : 'ON'}`;
    const csBtn = document.getElementById('btn-camera-shake');
    if (csBtn) csBtn.textContent = `Camera shake: ${toTitleCaseLevel(getLevelPref(PREF_KEYS.cameraShake))}`;
    const hsBtn = document.getElementById('btn-hit-stop');
    if (hsBtn) hsBtn.textContent = `Hit-stop: ${toTitleCaseLevel(getLevelPref(PREF_KEYS.hitStop))}`;
}

function initSettingsTabs() {
    const tabButtons = Array.from(document.querySelectorAll('.settings-tab-btn'));
    const panels = Array.from(document.querySelectorAll('.settings-tab-panel'));
    if (!tabButtons.length || !panels.length) return;

    function activate(tabName) {
        tabButtons.forEach((btn) => {
            const active = btn.dataset.settingsTab === tabName;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        panels.forEach((panel) => {
            panel.classList.toggle('active', panel.dataset.settingsTabPanel === tabName);
        });
    }

    tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => activate(btn.dataset.settingsTab));
    });
    activate('gameplay');
}

initClientPreferences();
initSettingsTabs();

// ============================================================
// PROCEDURAL SOUND MANAGER  (AudioContext — no audio files)
// ============================================================
class SoundManager {
    constructor() {
        this.ctx = null; // lazy-init on first interaction
        this.enabled = localStorage.getItem('lumen_clash_sound') !== 'off';
    }
    _ensureCtx() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
    }
    _osc(freq, duration, type = 'square', gainVal = 0.12) {
        if (!this.enabled) return;
        this._ensureCtx();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + duration);
    }
    playClick() {
        this._osc(880, 0.06, 'square', 0.08);
    }
    playAttack() {
        if (!this.enabled) return;
        this._ensureCtx();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(600, t);
        osc.frequency.linearRampToValueAtTime(150, t + 0.15);
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t); osc.stop(t + 0.2);
    }
    playHit() {
        if (!this.enabled) return;
        this._ensureCtx();
        const t = this.ctx.currentTime;
        // noise burst
        const bufferSize = this.ctx.sampleRate * 0.12;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        noise.connect(gain).connect(this.ctx.destination);
        noise.start(t); noise.stop(t + 0.12);
        // low thud
        this._osc(80, 0.1, 'sine', 0.2);
    }
    playHeal() {
        if (!this.enabled) return;
        this._ensureCtx();
        const t = this.ctx.currentTime;
        [440, 554, 659].forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t + i * 0.08);
            gain.gain.setValueAtTime(0.1, t + i * 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.2);
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.25);
        });
    }
    playShield() {
        if (!this.enabled) return;
        this._ensureCtx();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.linearRampToValueAtTime(900, t + 0.12);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t); osc.stop(t + 0.25);
    }
    playEmote() {
        this._osc(1200, 0.04, 'sine', 0.05);
        setTimeout(() => this._osc(1500, 0.04, 'sine', 0.05), 50);
    }
    playLevelUp() {
        if (!this.enabled) return;
        this._ensureCtx();
        const t = this.ctx.currentTime;
        const notes = [523, 659, 784, 1046]; // C5, E5, G5, C6
        notes.forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t + i * 0.1);
            gain.gain.setValueAtTime(0.1, t + i * 0.1);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.3);
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(t + i * 0.1); osc.stop(t + i * 0.1 + 0.4);
        });
    }
    playGameOver(won) {
        if (!this.enabled) return;
        this._ensureCtx();
        const t = this.ctx.currentTime;
        const notes = won ? [523, 659, 784] : [400, 350, 300];
        notes.forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = won ? 'square' : 'sawtooth';
            osc.frequency.setValueAtTime(f, t + i * 0.15);
            gain.gain.setValueAtTime(0.12, t + i * 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.35);
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(t + i * 0.15); osc.stop(t + i * 0.15 + 0.4);
        });
    }
    toggle() {
        this.enabled = !this.enabled;
        localStorage.setItem('lumen_clash_sound', this.enabled ? 'on' : 'off');
        return this.enabled;
    }
}
const sfx = new SoundManager();

// ============================================================
// EMOTE PRESETS (persisted in localStorage)
// ============================================================
const ALL_EMOTES = ['😡','😂','😭','🤠','💀','👽','🤡','👻','🔥','💪','😎','🫡','❤️','⚡','🎯','💤'];
const DEFAULT_EMOTES = ['😂','🔥','💀','😎'];

function loadEmotePresets() {
    try {
        const saved = JSON.parse(localStorage.getItem('lumen_clash_emotes'));
        if (Array.isArray(saved) && saved.length === 4) return saved;
    } catch(e) {}
    return [...DEFAULT_EMOTES];
}
function saveEmotePresets(arr) {
    localStorage.setItem('lumen_clash_emotes', JSON.stringify(arr));
}
let activeEmotes = loadEmotePresets();
let emoteCooldown = false;

let lastReportedPresence = '';

function computeDesiredPresence() {
    if (typeof document !== 'undefined' && document.hidden) return 'away';
    const mainHidden = document.getElementById('main-menu-container').classList.contains('hidden');
    const matchmaking = !document.getElementById('matchmaking-overlay').classList.contains('hidden');
    const heroSel = document.getElementById('hero-select-overlay');
    const heroSelectOpen = heroSel && !heroSel.classList.contains('hidden');
    const inGame = !document.getElementById('ui-container').classList.contains('hidden');
    const priv = !document.getElementById('private-match-container').classList.contains('hidden');
    if (inGame || matchmaking || heroSelectOpen) return 'match';
    if (priv) return 'private_lobby';
    if (!mainHidden) return 'menu';
    return 'menu';
}

let lastPresencePing = 0;
async function reportPresenceIfChanged(force = false) {
    const state = computeDesiredPresence();
    const now = Date.now();
    const needsPing = now - lastPresencePing >= 30000;
    if (!force && !needsPing && state === lastReportedPresence) return;
    lastReportedPresence = state;
    lastPresencePing = now;
    try {
        await fetch('/update-presence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, state })
        });
    } catch (e) {}
}

document.addEventListener('visibilitychange', () => reportPresenceIfChanged(true));

// Presence / Social Heartbeat (Reverted to 10s Separate Polls)
function pollMenuData() {
    reportPresenceIfChanged();
    fetchPublicConfig();
    // Only poll if on main menu
    const isMainMenu = !document.getElementById('main-menu-container').classList.contains('hidden');
    if (isMainMenu) {
        // Refresh social, leaderboard, and profile in background
        fetchFriends(true);
        
        if (!document.getElementById('leaderboard-container').classList.contains('hidden')) {
            fetchLeaderboard(true);
        }
        if (!document.getElementById('profile-container').classList.contains('hidden')) {
            fetchPlayerProfile(true);
        }
    }
}
setInterval(pollMenuData, 10000); // Back to 10s
pollMenuData();
fetchPublicConfig();

console.log("Auto-update heartbeat active (10s separate)");

// Fetch Profile Initialization
let myUsername = 'Player';
let lastSocialSnapshot = null;
let menuActivityPopoverOpen = false;
let currentAnnouncementMessage = '';
let lastPartyReadyCount = 0;

function renderAnnouncementBar(message) {
    const bar = document.getElementById('global-announcement-bar');
    const text = document.getElementById('global-announcement-text');
    if (!bar || !text) return;
    const nextMessage = (message || '').trim();
    if (!nextMessage) {
        bar.classList.add('hidden');
        text.textContent = '';
        currentAnnouncementMessage = '';
        return;
    }
    if (currentAnnouncementMessage !== nextMessage) {
        text.textContent = nextMessage + '   •   ' + nextMessage + '   •   ';
        currentAnnouncementMessage = nextMessage;
    }
    bar.classList.remove('hidden');
}

async function fetchPublicConfig() {
    try {
        const res = await fetch('/public-config');
        const data = await res.json();
        renderAnnouncementBar(data && data.announcement && data.announcement.active ? data.announcement.message : '');
    } catch (e) {}
}

function syncMainMenuHeaderProfile(data) {
    const nameEl = document.getElementById('menu-header-username');
    const rankEl = document.getElementById('menu-header-rank');
    const titleEl = document.getElementById('menu-header-title');
    if (!nameEl || !rankEl || !titleEl) return;
    const uname = (data && data.username) || myUsername || 'Pilot';
    nameEl.textContent = uname;
    const equippedTitle =
        data && data.equippedTitle !== undefined
            ? data.equippedTitle
            : (playerProfileData && playerProfileData.equippedTitle) || '';
    titleEl.textContent = equippedTitle && String(equippedTitle).trim() ? equippedTitle : '';
    const rank = data && data.level != null ? data.level : playerProfileData && playerProfileData.level != null ? playerProfileData.level : 1;
    rankEl.textContent = `Rank ${rank}`;
    syncMainMenuStatusWidgets(data);
}

function questMetricValue(bucket, quest) {
    if (!bucket || !quest) return 0;
    if (quest.metric === 'wins') return bucket.wins || 0;
    if (quest.metric === 'damage') return bucket.damage || 0;
    if (quest.metric === 'abilities') return bucket.abilities || 0;
    return bucket.matches || 0;
}

function getRetentionSnapshot(profile = null) {
    const p = profile || playerProfileData;
    const snapshot = {
        activeEvents: 0,
        claimableQuests: 0,
        trackedQuests: 0,
        nextQuest: null,
        nextQuestProgress: '',
        lumens: p && p.lumens != null ? Number(p.lumens) || 0 : 0,
        hasData: !!p
    };
    if (!p) return snapshot;

    const activeEvents = Array.isArray(p.activeEvents) ? p.activeEvents : [];
    snapshot.activeEvents = activeEvents.length;

    const daily = p.questMetrics && p.questMetrics.daily ? p.questMetrics.daily : {};
    const weekly = p.questMetrics && p.questMetrics.weekly ? p.questMetrics.weekly : {};
    const questCatalog = Array.isArray(p.questCatalog) ? p.questCatalog : [];
    const pending = [];
    const ready = [];

    questCatalog.forEach((quest) => {
        const bucket = quest.slot === 'daily' ? daily : weekly;
        const claimed = !!(bucket.claimed && bucket.claimed[quest.id]);
        if (claimed) return;
        const cur = questMetricValue(bucket, quest);
        const pct = Math.min(100, Math.round((cur / Math.max(1, quest.target)) * 100));
        const info = { quest, cur, pct };
        if (cur >= quest.target) ready.push(info);
        else pending.push(info);
    });

    pending.sort((a, b) => b.pct - a.pct);
    snapshot.claimableQuests = ready.length;
    snapshot.trackedQuests = pending.length + ready.length;
    snapshot.nextQuest = ready[0] || pending[0] || null;
    if (snapshot.nextQuest) {
        const q = snapshot.nextQuest.quest;
        snapshot.nextQuestProgress = snapshot.nextQuest.cur >= q.target
            ? `${q.label} is ready to claim.`
            : `${q.label} · ${snapshot.nextQuest.cur}/${q.target}`;
    }
    return snapshot;
}

function syncMainMenuStatusWidgets(data = null) {
    const liveData = data || playerProfileData || {};
    const statusMain = document.getElementById('menu-header-status-main');
    const statusSub = document.getElementById('menu-header-status-sub');
    const playRank = document.getElementById('menu-play-rank');
    const playLumens = document.getElementById('menu-play-lumens');
    const rank = liveData && liveData.level != null ? liveData.level : 1;
    const lumens = liveData && liveData.lumens != null ? liveData.lumens : 0;
    const snapshot = getRetentionSnapshot(liveData);
    const activeEvents = Array.isArray(liveData.activeEvents) ? liveData.activeEvents : [];
    if (statusMain) {
        if (snapshot.claimableQuests > 0) statusMain.textContent = 'Rewards Ready';
        else if (activeEvents.length) statusMain.textContent = 'Event Live';
        else if (snapshot.nextQuest) statusMain.textContent = 'Progressing';
        else statusMain.textContent = 'Online';
    }
    if (statusSub) {
        if (snapshot.claimableQuests > 0) {
            statusSub.textContent = `${snapshot.claimableQuests} quest${snapshot.claimableQuests === 1 ? '' : 's'} ready to claim`;
        } else if (activeEvents.length) {
            statusSub.textContent = `${activeEvents.length} event${activeEvents.length === 1 ? '' : 's'} active`;
        } else if (snapshot.nextQuestProgress) {
            statusSub.textContent = snapshot.nextQuestProgress;
        } else {
            statusSub.textContent = 'Arena calm';
        }
    }
    if (playRank) playRank.textContent = String(rank);
    if (playLumens) playLumens.textContent = String(lumens);
}

function refreshMenuActivityBadge(data) {
    if (!data) return;
    const n = (data.requests && data.requests.length) + (data.duelInvites && data.duelInvites.length);
    const badge = document.getElementById('menu-activity-badge');
    if (!badge) return;
    if (n > 0) {
        badge.textContent = n > 9 ? '9+' : String(n);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function renderEventsActivitySection() {
    const p = playerProfileData;
    if (!p || !p.activeEvents || !p.activeEvents.length) return '';
    const xm = p.eventXpMultiplier != null ? Number(p.eventXpMultiplier) : 1;
    const lm = p.eventLumenMultiplier != null ? Number(p.eventLumenMultiplier) : 1;
    
    let metaLines = [];
    if (xm !== 1 || lm !== 1) {
        metaLines.push(`Pass XP ×${xm.toFixed(2)} · Quest lumens ×${lm.toFixed(2)}`);
    }
    
    let rewardLines = [];
    p.activeEvents.forEach(e => {
        if (e.grantedTitles && e.grantedTitles.length) rewardLines.push(`Title: ${e.grantedTitles.join(', ')}`);
        if (e.grantedCosmetics && e.grantedCosmetics.length) rewardLines.push(`Unlocks: ${e.grantedCosmetics.join(', ')}`);
    });
    if (rewardLines.length) metaLines.push(rewardLines.join(' · '));

    const names = p.activeEvents.map((e) => e.name).join(' · ');
    return `<div class="menu-activity-quest-block menu-activity-events"><h3 class="menu-activity-quest-head">Live events</h3><p class="menu-activity-event-line">${names}</p><p class="menu-activity-event-meta">${metaLines.join('<br>')}</p></div>`;
}

function renderMenuFocusSection() {
    const snapshot = getRetentionSnapshot();
    if (!snapshot.hasData) return '';

    let title = 'Step back into the arena';
    let copy = 'Queue up and keep building your account, roster, and reward track.';
    if (snapshot.claimableQuests > 0) {
        title = 'You have rewards ready';
        copy = `${snapshot.claimableQuests} quest${snapshot.claimableQuests === 1 ? '' : 's'} can be claimed right now. Cash them in before your next match.`;
    } else if (snapshot.activeEvents > 0) {
        title = 'Live bonuses are active';
        copy = `${snapshot.activeEvents} event${snapshot.activeEvents === 1 ? '' : 's'} are boosting the arena. It is a strong time to queue or finish quests.`;
    } else if (snapshot.nextQuestProgress) {
        title = 'Next objective';
        copy = snapshot.nextQuestProgress;
    }

    return `<section class="menu-activity-focus">` +
        `<div class="menu-activity-focus-head">` +
            `<p class="menu-activity-focus-kicker">Recommended next move</p>` +
            `<h3 class="menu-activity-focus-title">${escapeHtml(title)}</h3>` +
            `<p class="menu-activity-focus-copy">${escapeHtml(copy)}</p>` +
        `</div>` +
        `<div class="menu-activity-focus-grid">` +
            `<div class="menu-activity-focus-stat"><strong>${snapshot.claimableQuests}</strong><span>Claimable quests</span></div>` +
            `<div class="menu-activity-focus-stat"><strong>${snapshot.activeEvents}</strong><span>Live events</span></div>` +
            `<div class="menu-activity-focus-stat"><strong>${snapshot.lumens}</strong><span>Lumens banked</span></div>` +
        `</div>` +
    `</section>`;
}

window.claimQuest = async function(questId, btn) {
    if (btn) {
        btn.disabled = true;
        btn.innerText = '...';
    }
    try {
        const res = await fetch('/claim-quest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, questId })
        });
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const data = contentType.includes('application/json')
            ? await res.json()
            : { ok: false, error: await res.text() || `Request failed (${res.status})` };
        if (data.ok) {
            if (window.sfx) window.sfx.playLevelUp(); // confetti sound equivalent
            await fetchPlayerProfile(true);
        } else if (data.error === 'Your account is banned from matchmaking.') {
            showBannedModal(data.bannedUntil);
        } else {
            console.error('Claim failed', data.error);
            if (btn) {
                btn.disabled = false;
                btn.innerText = 'Claim';
            }
            alert(data.error || 'Could not claim quest right now.');
        }
    } catch (e) {
        console.error('Claim error', e);
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Claim';
        }
        alert('Could not claim quest right now.');
    }
};

function renderQuestActivitySection() {
    const p = playerProfileData;
    if (!p || !p.questCatalog || !p.questMetrics) return '';
    const dm = p.questMetrics.daily || {};
    const wm = p.questMetrics.weekly || {};
    const rows = [];
    const orderedQuests = [...p.questCatalog].sort((a, b) => {
        const aBucket = a.slot === 'daily' ? dm : wm;
        const bBucket = b.slot === 'daily' ? dm : wm;

        const metricValue = (bucket, quest) => {
            if (quest.metric === 'wins') return bucket.wins || 0;
            if (quest.metric === 'damage') return bucket.damage || 0;
            if (quest.metric === 'abilities') return bucket.abilities || 0;
            return bucket.matches || 0;
        };

        const aClaimed = !!(aBucket.claimed && aBucket.claimed[a.id]);
        const bClaimed = !!(bBucket.claimed && bBucket.claimed[b.id]);
        const aCur = metricValue(aBucket, a);
        const bCur = metricValue(bBucket, b);
        const aDone = aCur >= a.target;
        const bDone = bCur >= b.target;

        const sortRank = (claimed, done) => {
            if (!claimed && !done) return 0;
            if (!claimed && done) return 1;
            return 2;
        };

        const rankDiff = sortRank(aClaimed, aDone) - sortRank(bClaimed, bDone);
        if (rankDiff !== 0) return rankDiff;

        const aPct = aCur / Math.max(1, a.target);
        const bPct = bCur / Math.max(1, b.target);
        return bPct - aPct;
    });

    for (const q of orderedQuests) {
        const bucket = q.slot === 'daily' ? dm : wm;
        const claimed = bucket.claimed && bucket.claimed[q.id];
        let cur = bucket.matches || 0;
        if (q.metric === 'wins') cur = bucket.wins || 0;
        else if (q.metric === 'damage') cur = bucket.damage || 0;
        else if (q.metric === 'abilities') cur = bucket.abilities || 0;
        const pct = Math.min(100, Math.round((cur / Math.max(1, q.target)) * 100));
        const done = !!claimed || cur >= q.target;
        
        let claimBtnHtml = '';
        if (claimed) {
            claimBtnHtml = `<span class="quest-status-claimed">✓ Claimed</span>`;
        } else if (done) {
            claimBtnHtml = `<button type="button" class="btn-claim-quest" onclick="claimQuest('${q.id}', this)">Claim</button>`;
        }
        
        rows.push(
            `<div class="menu-activity-quest"><div class="menu-activity-quest-label">${q.label}<span class="menu-activity-quest-pill">${q.slot}</span></div>` +
                `<div class="menu-activity-quest-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>` +
                `<div class="menu-activity-quest-meta" style="display:flex; justify-content:space-between; align-items:center;"><span>${cur} / ${q.target}</span> ${claimBtnHtml}</div></div>`
        );
    }
    return `<div class="menu-activity-quest-block"><h3 class="menu-activity-quest-head">Quests</h3>${rows.join('')}</div>`;
}

function renderMenuActivityPopoverBody() {
    const body = document.getElementById('menu-activity-popover-body');
    if (!body) return;
    const focusBlock = renderMenuFocusSection();
    const eventsBlock = renderEventsActivitySection();
    const questBlock = renderQuestActivitySection();
    const top = (focusBlock || '') + (eventsBlock || '') + (questBlock || '');

    if (!top) {
        body.innerHTML = '<p class="menu-activity-empty">No active quests or events.</p>';
        return;
    }
    body.innerHTML = top;
}

function closeMenuActivityPopover() {
    menuActivityPopoverOpen = false;
}

function openMenuActivityPopover() {
    menuActivityPopoverOpen = true;
}

async function fetchPlayerProfile(silent = false) {
    try {
        const res = await fetch(`/profile?uid=${localUid}`);
        const data = await res.json();
        playerProfileData = data;
        if (data.bpPremiumUnlocked) setBpPremiumUnlocked(true);
        myUsername = data.username || 'Player';
        
        document.getElementById('profile-username').innerText = myUsername;
        document.getElementById('profile-level').innerText = data.level; // Account rank (from class levels)
        
        const rPlacements = data.rankedRecord ? data.rankedRecord.placements : 0;
        const rMmr = data.rankedRecord ? data.rankedRecord.mmr : 1000;
        let rTier = `Unranked (${rPlacements}/5)`;
        if (rPlacements >= 5) {
            if (rMmr < 1150) rTier = `Bronze (${rMmr})`;
            else if (rMmr < 1300) rTier = `Silver (${rMmr})`;
            else if (rMmr < 1500) rTier = `Gold (${rMmr})`;
            else if (rMmr < 1850) rTier = `Platinum (${rMmr})`;
            else rTier = `Diamond (${rMmr})`;
        }
        document.getElementById('profile-ranked-tier').innerText = rTier;

        document.getElementById('profile-wins').innerText = data.wins;
        document.getElementById('profile-losses').innerText = data.losses;
        document.getElementById('profile-guild-name').innerText = data.guild ? `[${data.guild.tag}] ${data.guild.name}` : 'No guild';
        document.getElementById('btn-profile-leave-guild')?.classList.toggle('hidden', !data.guild);

        const roster = sumRosterXpProgress(data.classes);
        document.getElementById('profile-xp-fill').style.width = `${roster.pct}%`;
        document.getElementById('profile-xp-text').innerText = `${roster.sumXp} / ${roster.sumNeed}`;

        // Update BP badge on main menu if exists
        const bpBadge = document.getElementById('bp-account-level-button');
        if (bpBadge) bpBadge.innerText = `Rank ${data.level}`;

        syncMainMenuHeaderProfile(data);

        // Render match history
        updateMatchHistoryUI(data.matchHistory);

        fillProfileTitleSelect();

        renderMenuActivityPopoverBody();
        
        if (data.banned) {
            showBannedModal(data.bannedUntil);
        } else {
            const modal = document.getElementById('banned-modal');
            if (modal) modal.classList.add('hidden');
        }
    } catch (e) {
        console.error('Profile fetch failed', e);
        syncMainMenuHeaderProfile({ username: myUsername || 'Player', level: 1 });
    }
}

function fillProfileTitleSelect() {
    const titleSelect = document.getElementById('profile-select-title');
    if (!titleSelect || !playerProfileData) return;
    const current = titleSelect.value;
    titleSelect.innerHTML = '<option value="">No Title</option>';
    (playerProfileData.unlockedTitles || []).forEach(title => {
        const opt = document.createElement('option');
        opt.value = title;
        opt.innerText = title;
        titleSelect.appendChild(opt);
    });
    const equip = playerProfileData.equippedTitle || '';
    if (equip && [...titleSelect.options].some(o => o.value === equip)) {
        titleSelect.value = equip;
    } else if (current && [...titleSelect.options].some(o => o.value === current)) {
        titleSelect.value = current;
    }
}

function updateMatchHistoryUI(history) {
    if (!history) return;
    const historyList = document.getElementById('match-history-list');
    if (!historyList) return;
    historyList.innerHTML = [...history].reverse().map(m => {
        const date = new Date(m.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const charName = CHARACTER_CLASSES.find(c => c.id === m.classId)?.name || 'Unknown';
        return `<div style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items:center;">
            <div>
                <span style="color:${m.result === 'Win' ? '#00d2ff' : '#ff0055'}; font-weight:bold;">${m.result.toUpperCase()}</span>
                <span style="color:#666; font-size:0.75rem; margin-left:10px;">as ${charName}</span>
            </div>
            <div style="text-align:right;">
                <div style="color:#aaa; font-size:0.8rem;">+${m.xpEarned} XP</div>
                <div style="color:#444; font-size:0.7rem;">${date}</div>
            </div>
        </div>`;
    }).join('');
}

function updateProfileUI(data) {
    if (!data) return;
    myUsername = data.username || 'Player';
    document.getElementById('profile-username').innerText = myUsername;
    document.getElementById('profile-level').innerText = data.level;
    
    const rPlacements = data.rankedRecord ? data.rankedRecord.placements : 0;
    const rMmr = data.rankedRecord ? data.rankedRecord.mmr : 1000;
    let rTier = `Unranked (${rPlacements}/5)`;
    if (rPlacements >= 5) {
        if (rMmr < 1150) rTier = `Bronze (${rMmr})`;
        else if (rMmr < 1300) rTier = `Silver (${rMmr})`;
        else if (rMmr < 1500) rTier = `Gold (${rMmr})`;
        else if (rMmr < 1850) rTier = `Platinum (${rMmr})`;
        else rTier = `Diamond (${rMmr})`;
    }
    document.getElementById('profile-ranked-tier').innerText = rTier;

    document.getElementById('profile-wins').innerText = data.wins;
    document.getElementById('profile-losses').innerText = data.losses;
    document.getElementById('profile-guild-name').innerText = data.guild ? `[${data.guild.tag}] ${data.guild.name}` : 'No guild';
    document.getElementById('btn-profile-leave-guild')?.classList.toggle('hidden', !data.guild);

    const roster = sumRosterXpProgress(data.classes);
    document.getElementById('profile-xp-fill').style.width = `${roster.pct}%`;
    document.getElementById('profile-xp-text').innerText = `${roster.sumXp} / ${roster.sumNeed}`;

    syncMainMenuHeaderProfile(data);

    // Render match history if profile modal is open
    const isProfileOpen = !document.getElementById('profile-container').classList.contains('hidden');
    if (isProfileOpen && data.matchHistory && data.matchHistory.length > 0) {
        const historyList = document.getElementById('match-history-list');
        historyList.innerHTML = [...data.matchHistory].reverse().map(m => {
            const date = new Date(m.timestamp).toLocaleString();
            const color = m.result === 'Win' ? '#00d2ff' : '#ff0055';
            return `<div style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between;">
                <span style="color:${color}; font-weight:bold;">${m.result.toUpperCase()}</span>
                <span style="color:#aaa; font-size:0.8rem;">+${m.xpEarned} XP</span>
                <span style="color:#666; font-size:0.8rem;">${date}</span>
            </div>`;
        }).join('');
    }
}

// Character Definitions
const CHARACTER_CLASSES = [
    { id: 'aegisKnight', name: 'Knight', hp: 150, atk: 8, stats: 'Tank Class<br>High Health / Modest Damage' },
    { id: 'lumenSage', name: 'Sage', hp: 80, atk: 25, stats: 'Mage Class<br>Low Health / High Burst' },
    { id: 'voidWeaver', name: 'Void Weaver', hp: 110, atk: 18, stats: 'Assassin Class<br>Medium Health / High Speed' }
];

const MENU_CHARACTER_SPOTLIGHT = {
    aegisKnight: {
        hook: 'Anchor the front line and force every duel to happen on your terms.',
        pressure: 'Frontline control'
    },
    lumenSage: {
        hook: 'Burst windows, precision timing, and huge punish potential define this pick.',
        pressure: 'Burst caster'
    },
    voidWeaver: {
        hook: 'Slip through the fight, collapse on openings, and punish hesitation instantly.',
        pressure: 'Skirmish threat'
    }
};

const HERO_SELECT_METADATA = {
    aegisKnight: {
        icon: '🛡️',
        role: 'Tank',
        tagline: 'Reliable frontline captain',
        hook: 'Lead the front line with durable pressure and force every duel into your tempo.',
        desc: 'Tank · High HP'
    },
    lumenSage: {
        icon: '✨',
        role: 'Mage',
        tagline: 'Burst specialist',
        hook: 'Explode burst windows, punish mistakes, and swing fights with raw spell damage.',
        desc: 'Mage · Burst Damage'
    },
    voidWeaver: {
        icon: '🕳️',
        role: 'Assassin',
        tagline: 'Execution-focused diver',
        hook: 'Slip through openings, collapse fast, and pressure fragile targets before they recover.',
        desc: 'Assassin · Agile'
    }
};
let selectedCharacterIndex = 0;
let playerProfileData = null; // Full data from backend
fetchPlayerProfile();
syncMainMenuHeaderProfile({ username: myUsername, level: 1 });

let currentPreviewCharId = 'aegisKnight';
let currentSkinIndex = 0;

const BP_REWARDS = {
    1: { type: 'title', id: 'recruit', name: 'Recruit' },
    2: { type: 'emote', id: 'hype', name: '🎈 Hype' },
    3: { type: 'skin', id: 'verdant', name: 'Verdant' },
    4: { type: 'credits', id: 'lumens', amount: 20, name: '+20 Lumens' },
    5: { type: 'title', id: 'warrior', name: 'Warrior' },
    6: { type: 'skin', id: 'crimson_knight', name: 'Crimson Knight' },
    7: { type: 'credits', id: 'lumens', amount: 20, name: '+20 Lumens' },
    8: { type: 'title', id: 'tactician', name: 'Tactician' },
    9: { type: 'credits', id: 'lumens', amount: 20, name: '+20 Lumens' },
    10: { type: 'skin', id: 'abyssal', name: 'Abyssal' },
    11: { type: 'skin', id: 'astral_sage', name: 'Astral Sage' },
    12: { type: 'credits', id: 'lumens', amount: 20, name: '+20 Lumens' },
    13: { type: 'title', id: 'arc_warden', name: 'Arc Warden' },
    14: { type: 'title', id: 'starforged', name: 'Starforged' },
    15: { type: 'title', id: 'grandmaster', name: 'Grandmaster' },
    16: { type: 'title', id: 'mythbreaker', name: 'Mythbreaker' },
    17: { type: 'title', id: 'season_vanguard', name: 'Season Vanguard' },
    18: { type: 'credits', id: 'lumens', amount: 20, name: '+20 Lumens' },
    19: { type: 'title', id: 'paragon', name: 'Paragon' },
    20: { type: 'skin', id: 'legend', name: 'Lumen Legend' }
};

const BP_PREMIUM_UNLOCK_COST_LUMENS = 100;
const BP_PREMIUM_UNLOCK_KEY = 'lumen_clash_bp_premium_unlocked';

function bpPremiumUnlocked() {
    return localStorage.getItem(BP_PREMIUM_UNLOCK_KEY) === 'on';
}

function setBpPremiumUnlocked(on) {
    localStorage.setItem(BP_PREMIUM_UNLOCK_KEY, on ? 'on' : 'off');
}

function bpLumensEarnedByRank(rank) {
    const r = Math.max(1, Math.min(20, Number(rank) || 1));
    let sum = 0;
    for (let i = 1; i <= r; i++) {
        const rw = BP_REWARDS[i];
        if (rw && rw.type === 'credits' && rw.id === 'lumens') {
            sum += Math.max(0, Number(rw.amount) || 0);
        }
    }
    return sum;
}

function battlePassRewardPresentation(reward, level) {
    if (!reward && level === 1) {
        return { icon: '🌱', name: 'Start', desc: 'Your first step on the seasonal path.' };
    }
    if (!reward) {
        return { icon: '🔒', name: 'Mystery slot', desc: 'More rewards can be added to future passes.' };
    }
    if (reward.type === 'title') {
        return { icon: '📜', name: reward.name, desc: 'Equip a new player title to show off your progression.' };
    }
    if (reward.type === 'credits') {
        return { icon: '💠', name: reward.name, desc: 'Bank more lumens for premium unlocks, cosmetics, and future offerings.' };
    }
    if (reward.type === 'emote') {
        return { icon: reward.id === 'hype' ? '🎈' : reward.id, name: reward.name, desc: 'Add a little more personality to your in-match reactions.' };
    }
    return { icon: '🎨', name: reward.name, desc: 'Unlock a cosmetic look for your roster.' };
}

function textureKeyForClassAndSkin(classId, skinLabel) {
    if (classId === 'voidWeaver') {
        if (skinLabel === 'Verdant') return 'voidWeaver_green';
        if (skinLabel === 'Abyssal') return 'voidWeaver_abyssal';
        if (skinLabel === 'Lumen Legend') return 'voidWeaver_legend';
        return 'voidWeaver';
    }
    if (classId === 'aegisKnight') {
        if (skinLabel === 'Crimson') return 'aegisKnight_crimson';
        return 'aegisKnight';
    }
    if (classId === 'lumenSage') {
        if (skinLabel === 'Astral') return 'lumenSage_astral';
        return 'lumenSage';
    }
    return classId;
}

function getAllSkinsForChar(charId) {
    const skins = [{ name: 'Default', reqItem: null, reqLevel: 0 }];
    if (charId === 'voidWeaver') {
        skins.push({ name: 'Verdant', reqItem: null, reqLevel: 3 });
        skins.push({ name: 'Abyssal', reqItem: null, reqLevel: 10 });
        skins.push({ name: 'Lumen Legend', reqItem: null, reqLevel: 20 });
        skins.push({ name: 'Gold', reqItem: 'Gold', reqLevel: 0 });
    }
    if (charId === 'aegisKnight') {
        skins.push({ name: 'Crimson', reqItem: null, reqLevel: 6 });
    }
    if (charId === 'lumenSage') {
        skins.push({ name: 'Astral', reqItem: null, reqLevel: 11 });
    }
    return skins;
}

function availableSkinsForChar(charId, accountRank) {
    const r = Math.max(1, Number(accountRank) || 1);
    const all = getAllSkinsForChar(charId);
    return all.filter(s => {
        if (s.reqLevel > r) return false;
        if (s.reqItem && !(playerProfileData && playerProfileData.unlockedCosmetics && playerProfileData.unlockedCosmetics.includes(s.reqItem))) return false;
        return true;
    }).map(s => s.name);
}

/** Sum of (class xp) / sum of (level×100) — matches how ranks grow from class levels, not lifetime stats.xp */
function sumRosterXpProgress(classes) {
    let sumXp = 0;
    let sumNeed = 0;
    for (const c of Object.values(classes || {})) {
        const L = Math.max(1, Number(c.level) || 1);
        const need = L * 100;
        sumXp += Math.max(0, Number(c.xp) || 0);
        sumNeed += need;
    }
    if (sumNeed <= 0) return { sumXp: 0, sumNeed: 0, pct: 0 };
    return { sumXp, sumNeed, pct: Math.min(100, (sumXp / sumNeed) * 100) };
}

function classLevelProgress(classState) {
    const L = Math.max(1, Number(classState && classState.level) || 1);
    const need = L * 100;
    const xp = Math.max(0, Number(classState && classState.xp) || 0);
    return { need, xp, pct: need > 0 ? Math.min(100, (xp / need) * 100) : 0 };
}

function rosterPctAfterSubtractingClassXp(pg, classId, delta) {
    if (!pg || !pg.classes || !classId) return sumRosterXpProgress(pg && pg.classes).pct;
    const copy = JSON.parse(JSON.stringify(pg.classes));
    if (!copy[classId]) return sumRosterXpProgress(copy).pct;
    copy[classId].xp = Math.max(0, (Number(copy[classId].xp) || 0) - (Number(delta) || 0));
    return sumRosterXpProgress(copy).pct;
}

/** RGB max channel at or below this → alpha 0 (removes flat black / dark matte backdrops on PNGs). */
const CHAR_BITMAP_NEAR_BLACK_THRESHOLD = 28;
const CHARACTER_TEXTURE_KEYS_FOR_KNOCKOUT = [
    'voidWeaver',
    'voidWeaver_green',
    'voidWeaver_abyssal',
    'voidWeaver_legend',
    'aegisKnight',
    'aegisKnight_crimson',
    'lumenSage',
    'lumenSage_astral'
];

/** Variant texture keys → base key (for matching on-screen scale when PNG dimensions differ). */
const VARIANT_TEXTURE_BASE = {
    voidWeaver_green: 'voidWeaver',
    voidWeaver_abyssal: 'voidWeaver',
    voidWeaver_legend: 'voidWeaver',
    aegisKnight_crimson: 'aegisKnight',
    lumenSage_astral: 'lumenSage'
};

const characterPreviewImageCache = Object.create(null);

function processCharacterBitmap(source, threshold = CHAR_BITMAP_NEAR_BLACK_THRESHOLD) {
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        if (Math.max(r, g, b) <= threshold) {
            d[i + 3] = 0;
        }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

function getTextureSourceImage(texture) {
    if (texture && typeof texture.getSourceImage === 'function') return texture.getSourceImage();
    const s0 = texture && texture.source && texture.source[0];
    return s0 && s0.image ? s0.image : null;
}

function spriteVariantScaleFactor(scene, textureKey) {
    const baseKey = VARIANT_TEXTURE_BASE[textureKey];
    if (!baseKey || !scene || !scene.textures.exists(baseKey) || !scene.textures.exists(textureKey)) return 1;
    const baseImg = getTextureSourceImage(scene.textures.get(baseKey));
    const varImg = getTextureSourceImage(scene.textures.get(textureKey));
    if (!baseImg || !varImg) return 1;
    const bw = baseImg.naturalWidth || baseImg.width;
    const bh = baseImg.naturalHeight || baseImg.height;
    const vw = varImg.naturalWidth || varImg.width;
    const vh = varImg.naturalHeight || varImg.height;
    if (!bw || !bh || !vw || !vh) return 1;
    return Math.min(bw / vw, bh / vh);
}

function computePhaserSpriteBaseScales() {
    const gc = getGameContainer();
    if (!gc) return null;
    const cw = gc.clientWidth;
    const ch = gc.clientHeight;
    const inBattle = shouldUseBattleSpriteLayout();
    if (inBattle) {
        const s = Math.min(0.45, ch / 900);
        return { inBattle: true, leftBase: s, rightBase: s };
    }
    const narrowPortrait = document.documentElement.classList.contains('layout-portrait') && cw < 900;
    const mobile = document.documentElement.classList.contains('layout-mobile') || narrowPortrait;
    const portraitBoost = narrowPortrait ? 1.06 : 1;
    const baseScale = (mobile ? Math.min(0.58, ch / 760) : Math.min(0.68, ch / 700)) * portraitBoost;
    return { inBattle: false, leftBase: baseScale, rightBase: baseScale };
}

function applyPhaserCharacterScales(scene) {
    if (!playerLeftShape || !playerRightShape || !scene) return;
    const cfg = computePhaserSpriteBaseScales();
    if (!cfg) return;
    if (cfg.inBattle) {
        playerLeftShape.setScale(cfg.leftBase * spriteVariantScaleFactor(scene, playerLeftShape.texture.key)).setFlipX(false);
        playerRightShape.setScale(cfg.rightBase * spriteVariantScaleFactor(scene, playerRightShape.texture.key)).setFlipX(true);
    } else {
        playerLeftShape.setScale(cfg.leftBase * spriteVariantScaleFactor(scene, playerLeftShape.texture.key)).setFlipX(false);
    }
}

function applyCharacterTextureAlphaKnockout(scene) {
    CHARACTER_TEXTURE_KEYS_FOR_KNOCKOUT.forEach((key) => {
        try {
            if (!scene.textures.exists(key)) return;
            const texture = scene.textures.get(key);
            const src = getTextureSourceImage(texture);
            if (!src || !(src.naturalWidth || src.width)) return;
            const processed = processCharacterBitmap(src, CHAR_BITMAP_NEAR_BLACK_THRESHOLD);
            if (!processed) return;
            scene.textures.remove(key);
            const canvasTex = scene.textures.addCanvas(key, processed);
            if (canvasTex && typeof canvasTex.refresh === 'function') canvasTex.refresh();
        } catch (e) {
            console.warn('[Lumen] Texture alpha knockout failed for', key, e);
        }
    });
}

function characterPreviewAssetUrl(charId, skinLabel) {
    if (charId === 'voidWeaver' && skinLabel === 'Verdant') {
        return 'assets/void_weaver_green.png?v=1';
    }
    if (charId === 'voidWeaver' && skinLabel === 'Abyssal') {
        return 'assets/void_weaver_abyssal.png?v=1';
    }
    if (charId === 'voidWeaver' && skinLabel === 'Lumen Legend') {
        return 'assets/void_weaver_legend.png?v=1';
    }
    if (charId === 'aegisKnight' && skinLabel === 'Crimson') {
        return 'assets/aegis_knight_crimson.png?v=1';
    }
    if (charId === 'lumenSage' && skinLabel === 'Astral') {
        return 'assets/lumen_sage_astral.png?v=1';
    }
    const base = charId === 'aegisKnight' ? 'aegis_knight' : charId === 'lumenSage' ? 'lumen_sage' : 'void_weaver';
    return `assets/${base}.png?v=2`;
}

function refreshCharacterPreviewImg() {
    const container = document.getElementById('char-preview-sprite-container');
    if (!container) return;
    const skinEl = document.getElementById('current-skin-name');
    const skinLabel = skinEl ? skinEl.innerText.trim() : 'Default';
    const cacheKey = `${currentPreviewCharId}|${skinLabel}`;
    if (characterPreviewImageCache[cacheKey]) {
        mountPreviewImg(container, characterPreviewImageCache[cacheKey]);
        return;
    }
    const url = characterPreviewAssetUrl(currentPreviewCharId, skinLabel);
    const im = new Image();
    im.onload = () => {
        const canvas = processCharacterBitmap(im, CHAR_BITMAP_NEAR_BLACK_THRESHOLD);
        if (!canvas) return;
        const dataUrl = canvas.toDataURL('image/png');
        characterPreviewImageCache[cacheKey] = dataUrl;
        mountPreviewImg(container, dataUrl);
    };
    im.onerror = () => {
        container.innerHTML = '';
    };
    im.src = url;
}

function mountPreviewImg(container, dataUrl) {
    container.innerHTML = '';
    const el = document.createElement('img');
    el.className = 'lumen-character-sprite';
    el.src = dataUrl;
    el.alt = '';
    container.appendChild(el);
}

// Phaser Scene functions
function preload() {
    this.load.image('voidWeaver', 'assets/void_weaver.png?v=2');
    this.load.image('voidWeaver_green', 'assets/void_weaver_green.png?v=1');
    this.load.image('voidWeaver_abyssal', 'assets/void_weaver_abyssal.png?v=1');
    this.load.image('voidWeaver_legend', 'assets/void_weaver_legend.png?v=1');
    this.load.image('aegisKnight', 'assets/aegis_knight.png?v=2');
    this.load.image('lumenSage', 'assets/lumen_sage.png?v=2');
    this.load.image('aegisKnight_crimson', 'assets/aegis_knight_crimson.png?v=1');
    this.load.image('lumenSage_astral', 'assets/lumen_sage_astral.png?v=1');
}

let playerLeftShape;
let playerRightShape;
let playerLeftShape2;  // 2v2 ally
let playerRightShape2; // 2v2 enemy 2
let phaserLayoutBattleMode = false;

function menuHeroTextureKey(charId) {
    let key = charId;
    const skin = playerProfileData && playerProfileData.equippedSkins && playerProfileData.equippedSkins[charId];
    key = textureKeyForClassAndSkin(charId, skin || 'Default');
    return key;
}

function shouldUseBattleSpriteLayout() {
    return !!(gameState && gameState.status === 'IN_PROGRESS' && myPlayerId);
}

function refreshPhaserCharacterLayout() {
    if (!playerLeftShape || !playerRightShape || !playerLeftShape.scene) return;
    const scene = playerLeftShape.scene;
    const gc = getGameContainer();
    if (!gc) return;
    const cw = gc.clientWidth;
    const ch = gc.clientHeight;
    const inBattle = shouldUseBattleSpriteLayout();

    if (inBattle) {
        playerRightShape.setVisible(true);
        const spriteY = ch * 0.35;
        playerLeftShape.setPosition(cw * 0.22, spriteY);
        playerRightShape.setPosition(cw * 0.78, spriteY);
        
        // 2v2 secondary sprites — staggered behind primaries
        if (playerLeftShape2 && playerRightShape2) {
            const has4 = gameState && gameState.players && Object.keys(gameState.players).length > 2;
            playerLeftShape2.setVisible(has4);
            playerRightShape2.setVisible(has4);
            if (has4) {
                playerLeftShape2.setPosition(cw * 0.12, spriteY + ch * 0.08);
                playerRightShape2.setPosition(cw * 0.88, spriteY + ch * 0.08);
                playerLeftShape2.setScale(playerLeftShape.scaleX * 0.8, playerLeftShape.scaleY * 0.8);
                playerRightShape2.setScale(playerRightShape.scaleX * 0.8, playerRightShape.scaleY * 0.8);
                playerLeftShape2.setAlpha(0.85);
                playerRightShape2.setAlpha(0.85);
            }
        }
    } else {
        playerRightShape.setVisible(false);
        if (playerLeftShape2) playerLeftShape2.setVisible(false);
        if (playerRightShape2) playerRightShape2.setVisible(false);
        const narrowPortrait = document.documentElement.classList.contains('layout-portrait') && cw < 900;
        const spriteX = cw * 0.5; // Centered
        const spriteY = narrowPortrait ? ch * 0.34 : ch * 0.4;
        playerLeftShape.setPosition(spriteX, spriteY);
    }
    applyPhaserCharacterScales(scene);
}

function create() {
    applyCharacterTextureAlphaKnockout(this);

    // Add some starry/sci-fi background particles
    const particles = this.add.particles(0, 0, 'dummy', {
        x: { min: 0, max: this.scale.width },
        y: { min: 0, max: this.scale.height },
        lifespan: 3000,
        speed: { min: 10, max: 20 },
        angle: { min: 0, max: 360 },
        gravityY: 0,
        scale: { start: 0.2, end: 0 },
        quantity: 2,
        blendMode: 'ADD'
    });
    // Create a dummy texture for particles
    const graphics = this.make.graphics();
    graphics.fillStyle(0xffffff, 1);
    graphics.fillCircle(2, 2, 2);
    graphics.generateTexture('dot', 4, 4);
    particles.setTexture('dot');

    const container = document.getElementById('game-container');
    const ch = container ? container.clientHeight : 600;
    const cw = container ? container.clientWidth : 800;
    const startCharId = CHARACTER_CLASSES[selectedCharacterIndex] ? CHARACTER_CLASSES[selectedCharacterIndex].id : 'aegisKnight';
    const startTex = menuHeroTextureKey(startCharId);

    playerLeftShape = this.add.sprite(cw * 0.4, ch * 0.4, startTex);
    playerRightShape = this.add.sprite(cw * 0.75, ch * 0.35, 'voidWeaver');
    playerRightShape.setFlipX(true);
    playerLeftShape2 = this.add.sprite(cw * 0.15, ch * 0.45, 'aegisKnight');
    playerRightShape2 = this.add.sprite(cw * 0.85, ch * 0.45, 'voidWeaver');
    playerRightShape2.setFlipX(true);
    playerLeftShape2.setVisible(false);
    playerRightShape2.setVisible(false);

    refreshPhaserCharacterLayout();

    // Tweens for idle breathing effect
    this.tweens.add({
        targets: [playerLeftShape, playerRightShape, playerLeftShape2, playerRightShape2],
        y: '-=15',
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
    });

    // Connection is now triggered by the "Play" button, not on create()
    syncGameContainerPointerEvents();
    
    // Final sync: ensure sprites match latest server state if match already started
    if (typeof updateUI === 'function') updateUI();
}

function update() {
    // Real-time animation logic can go here
}

function resetMatchStats() {
    matchStats.active = true;
    matchStats.damageDealt = 0;
    matchStats.damageTaken = 0;
    matchStats.abilitiesUsed = 0;
    matchStats.turnSwaps = 0;
    lastTurnSnapshot = null;
}

function endMatchStatsSession() {
    matchStats.active = false;
}

function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

function clearHeroSelectCountdownTimer() {
    if (!heroSelectCountdownTimer) return;
    clearInterval(heroSelectCountdownTimer);
    heroSelectCountdownTimer = null;
}

function availableSkinsByHeroId(charId) {
    return availableSkinsForChar(charId, playerProfileData && playerProfileData.level ? playerProfileData.level : 1);
}

function setHeroSelectSkinOptions(charId, preferredSkin) {
    const select = document.getElementById('hero-select-skin');
    if (!select) return;
    const skins = availableSkinsByHeroId(charId);
    select.innerHTML = '';
    skins.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.innerText = s;
        select.appendChild(opt);
    });
    const fallback = skins.includes('Default') ? 'Default' : (skins[0] || 'Default');
    select.value = preferredSkin && skins.includes(preferredSkin) ? preferredSkin : fallback;
}

function updateHeroSelectCardClasses(charId) {
    document.querySelectorAll('.hero-select-card').forEach(card => {
        card.classList.toggle('active', card.getAttribute('data-hero-select') === charId);
    });
}

function syncHeroSelectFeature(charId) {
    const hero = CHARACTER_CLASSES.find((c) => c.id === charId) || CHARACTER_CLASSES[0];
    if (!hero) return;
    const meta = HERO_SELECT_METADATA[hero.id] || {};
    const iconEl = document.getElementById('hero-select-feature-icon');
    const roleEl = document.getElementById('hero-select-feature-role');
    const nameEl = document.getElementById('hero-select-feature-name');
    const taglineEl = document.getElementById('hero-select-feature-tagline');
    const hookEl = document.getElementById('hero-select-feature-hook');
    const hpEl = document.getElementById('hero-select-feature-hp');
    const atkEl = document.getElementById('hero-select-feature-atk');
    const descEl = document.getElementById('hero-select-feature-desc');
    if (iconEl) iconEl.textContent = meta.icon || '⚔️';
    if (roleEl) roleEl.textContent = meta.role || 'Hero';
    if (nameEl) nameEl.textContent = hero.name;
    if (taglineEl) taglineEl.textContent = meta.tagline || meta.role || 'Arena specialist';
    if (hookEl) hookEl.textContent = meta.hook || 'Lock your combatant and get ready to commit.';
    if (hpEl) hpEl.textContent = String(hero.hp || 0);
    if (atkEl) atkEl.textContent = String(hero.atk || 0);
    if (descEl) descEl.textContent = meta.desc || String(hero.stats || '').replace(/<br>/g, ' · ');
}

function extractHeroSelectServerState() {
    const hs = gameState && gameState.heroSelect;
    if (!hs) return null;
    const me = myPlayerId || 'p1';
    const opp = me === 'p1' ? 'p2' : 'p1';
    const players = hs.players || {};
    const meRow = players[me] || {};
    const oppRow = players[opp] || {};
    return {
        meChar: meRow.charId || null,
        meSkin: meRow.skin || 'Default',
        meReady: !!meRow.ready,
        oppReady: !!oppRow.ready,
        deadline: Number(hs.deadline) || 0
    };
}

function syncHeroSelectUIFromState() {
    const overlay = document.getElementById('hero-select-overlay');
    const countdown = document.getElementById('hero-select-countdown');
    const readyStatus = document.getElementById('hero-ready-status');
    const oppStatus = document.getElementById('hero-opponent-ready-status');
    const readyBtn = document.getElementById('btn-hero-ready');
    const phasePill = document.getElementById('hero-select-phase-pill');
    const selectionSummary = document.getElementById('hero-select-selection-summary');
    const skinNote = document.getElementById('hero-select-skin-note');
    const lockCopy = document.getElementById('hero-select-lock-copy');
    if (!overlay || !countdown || !readyStatus || !oppStatus || !readyBtn) return;

    const server = extractHeroSelectServerState();
    const effective = server || {
        meChar: heroSelectPick.charId,
        meSkin: heroSelectPick.skin || 'Default',
        meReady: heroSelectLocked,
        oppReady: false,
        deadline: 0
    };

    const fallbackChar = CHARACTER_CLASSES[selectedCharacterIndex] ? CHARACTER_CLASSES[selectedCharacterIndex].id : 'aegisKnight';
    const charId = effective.meChar || heroSelectPick.charId || fallbackChar;
    const skin = effective.meSkin || heroSelectPick.skin || 'Default';

    heroSelectPick.charId = charId;
    heroSelectPick.skin = skin;
    heroSelectLocked = !!effective.meReady;

    updateHeroSelectCardClasses(charId);
    syncHeroSelectFeature(charId);
    setHeroSelectSkinOptions(charId, skin);
    const hero = CHARACTER_CLASSES.find((c) => c.id === charId) || CHARACTER_CLASSES[0];
    const skins = availableSkinsByHeroId(charId);
    const unlockedExtras = Math.max(0, skins.length - 1);

    readyStatus.innerText = heroSelectLocked ? 'Locked in' : 'Not ready';
    oppStatus.innerText = effective.oppReady ? 'Opponent locked in' : 'Opponent selecting...';
    readyBtn.disabled = heroSelectLocked;
    readyBtn.innerText = heroSelectLocked ? 'Locked' : 'Lock In';
    if (phasePill) {
        phasePill.textContent = heroSelectLocked ? 'Locked' : 'Selecting';
        phasePill.classList.toggle('is-locked', heroSelectLocked);
    }
    if (selectionSummary) {
        selectionSummary.textContent = `Previewing ${hero ? hero.name : 'your hero'} with the ${skin} skin.`;
    }
    if (skinNote) {
        skinNote.textContent = unlockedExtras > 0
            ? `${skins.length} skins unlocked for this hero. ${skin} is currently equipped.`
            : `${skin} skin equipped. Unlock more looks by leveling your roster.`;
    }
    if (lockCopy) {
        lockCopy.textContent = heroSelectLocked
            ? 'Selection sent. Waiting for the final confirmation from the server.'
            : (effective.oppReady ? 'Opponent is ready. Lock in to avoid a last-second scramble.' : 'Lock now to secure your loadout.');
    }

    if (effective.deadline > Date.now()) {
        heroSelectCountdownUntil = effective.deadline;
        clearHeroSelectCountdownTimer();
        const tick = () => {
            const ms = Math.max(0, heroSelectCountdownUntil - Date.now());
            countdown.innerText = ms > 0 ? `Lock in your hero (${Math.ceil(ms / 1000)}s)` : 'Waiting for server...';
        };
        tick();
        heroSelectCountdownTimer = setInterval(tick, 200);
    } else {
        clearHeroSelectCountdownTimer();
        countdown.innerText = 'Lock in your hero';
    }
    reportPresenceIfChanged(true);
}

function scheduleReconnect() {
    if (manualSocketClose) return;
    const inMatchFlow = gameState && (gameState.status === 'IN_PROGRESS' || gameState.status === 'WAITING_FOR_PLAYERS' || gameState.status === 'HERO_SELECT');
    if (!inMatchFlow) return;
    if (reconnectAttempts >= 3) {
        document.getElementById('matchmaking-text').innerText = "Connection lost. Please return to menu.";
        document.getElementById('status-message').innerText = "Disconnected from server.";
        document.getElementById('ability-bar').classList.add('hidden');
        document.getElementById('btn-return').classList.remove('hidden');
        return;
    }
    const delayMs = 1200 * (reconnectAttempts + 1);
    reconnectAttempts += 1;
    document.getElementById('matchmaking-overlay').classList.remove('hidden');
    document.getElementById('matchmaking-text').innerText = `Reconnecting... (${reconnectAttempts}/3)`;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
        connectWebSocket(lastRoomId, lastQueueType);
    }, delayMs);
}

let lastQueueType = 'casual';

function connectWebSocket(specificRoomId = null, queue = 'casual') {
    if (socket) {
        manualSocketClose = true;
        try {
            socket.onclose = null;
            socket.close();
        } catch(e) {}
    }
    manualSocketClose = false;
    if (specificRoomId) lastRoomId = specificRoomId;
    // Server requires explicit hero (no default); prefer in-match pick over menu-only default.
    const menuChar = CHARACTER_CLASSES[selectedCharacterIndex] ? CHARACTER_CLASSES[selectedCharacterIndex].id : null;
    const charId = heroSelectPick.charId || menuChar;
    if (!charId) {
        console.warn('connectWebSocket: no hero');
        const mm = document.getElementById('matchmaking-text');
        if (mm) mm.innerText = 'Pick a hero before joining.';
        return;
    }

    if (playerProfileData && playerProfileData.banned) {
        showBannedModal(playerProfileData.bannedUntil);
        document.getElementById('matchmaking-overlay').classList.add('hidden');
        return;
    }
    heroSelectPick.charId = charId;
    if (!heroSelectPick.skin) heroSelectPick.skin = 'Default';
    const skin = heroSelectPick.skin || 'Default';
    persistLastSelectedCharacterId(charId);
    // Connect to Node.js proxy to bypass Firewall issues on Windows
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${wsProtocol}//${window.location.host}/play?char=${encodeURIComponent(charId)}&uid=${encodeURIComponent(localUid)}&skin=${encodeURIComponent(skin)}`;
    
    lastQueueType = queue;
    wsUrl += `&queue=${queue}`;

    if (specificRoomId) {
        wsUrl += `&roomId=${encodeURIComponent(specificRoomId)}`;
    }
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("Connected to game server");
        reconnectAttempts = 0;
        clearReconnectTimer();
        document.getElementById('status-message').innerText = "Connected. Waiting for opponent...";
        reportPresenceIfChanged(true);
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'STATE_UPDATE') {
            // Always trust server assignment; rematches may swap p1/p2.
            if (msg.me && myPlayerId !== msg.me) {
                myPlayerId = msg.me;
                console.log("Joined as " + myPlayerId);
                prevMyHealth = -1;
                prevOpponentHealth = -1;
            }
            gameState = msg.state;
            // Always sync whenever a state arrives to prevent sprite mismatches
            updateUI();
        }
        if (msg.type === 'HERO_SELECT_UPDATE') {
            if (gameState && msg.heroSelect) {
                gameState.heroSelect = msg.heroSelect;
            }
            syncHeroSelectUIFromState();
        }
        if (msg.type === 'EMOTE') {
            showEmoteBubble(msg.pId, msg.emote);
            sfx.playEmote();
        }
        if (msg.type === 'REMATCH_VOTE') {
            if (msg.pId !== myPlayerId) {
                const status = document.getElementById('rematch-status');
                if (status) {
                    const map = { bo3: 'Best of 3', continue: 'Next round', single: 'One more game' };
                    const label = map[msg.choice] || 'One more game';
                    status.innerText = `Opponent chose: ${label}`;
                }
            }
        }
        if (msg.type === 'REMATCH_MODE_MISMATCH') {
            const status = document.getElementById('rematch-status');
            if (status) status.innerText = 'Choose the same option (or both Best of 3).';
            const btn = document.getElementById('btn-rematch');
            const bo3 = document.getElementById('btn-rematch-bo3');
            if (btn) btn.disabled = false;
            if (bo3) bo3.disabled = false;
            const label = document.getElementById('btn-rematch-label');
            if (label) {
                const ser = gameState && gameState.series;
                label.textContent = ser && !ser.complete ? 'Next round' : 'Challenge Again';
            }
        }
    };

    socket.onerror = (error) => {
        console.error("WebSocket error observed:", error);
        document.getElementById('matchmaking-text').innerText = "Connection Failed!";
    };

    socket.onclose = (event) => {
        console.log("WebSocket closed", event);
        if (manualSocketClose) return;
        if (event.code === 4000) {
            connectWebSocket(null, lastQueueType || 'casual');
            return;
        }

        if (event.reason === "Opponent disconnected") {
            // Show custom modal instead of alert
            document.getElementById('disconnect-modal').classList.remove('hidden');
            // Hide the normal return button since the modal handles it
            document.getElementById('btn-return').classList.add('hidden');
            return;
        }

        document.getElementById('matchmaking-text').innerText = "Disconnected from server.";
        document.getElementById('status-message').innerText = "Disconnected from server.";
        scheduleReconnect();
    };
}

/** Clear victory/defeat overlay whenever the server leaves GAME_OVER (rematch, queue, new round). */
function hideVictorySplashForActiveMatch() {
    const splash = document.getElementById('xp-splash-overlay');
    if (!splash) return;
    splash.classList.add('hidden');
    splash.classList.remove('active-showing');
    splash.style.display = '';
}

function triggerDamageFeedback(scene, damagedSprite, counterSprite, hurtKickX, counterKickX) {
    if (!scene || !damagedSprite || !damagedSprite.active) return;
    const shake = cameraShakeAmount();
    if (shake > 0 && scene.cameras && scene.cameras.main) {
        scene.cameras.main.shake(100, shake, true);
    }
    const stopMs = hitStopMs();
    if (stopMs > 0 && scene.tweens) {
        scene.tweens.timeScale = 0.01;
        setTimeout(() => {
            if (scene && scene.tweens) scene.tweens.timeScale = 1;
        }, stopMs);
    }
    scene.tweens.add({ targets: damagedSprite, x: hurtKickX, yoyo: true, duration: 50, repeat: 3 });
    damagedSprite.setTintFill(0xff0000);
    setTimeout(() => {
        if (damagedSprite && damagedSprite.active) damagedSprite.clearTint();
    }, 200);
    if (counterSprite && counterSprite.active) {
        scene.tweens.add({ targets: counterSprite, x: counterKickX, duration: 150, yoyo: true });
    }
}

function updateUI() {
    if (!gameState) return;

    if (gameState.status !== 'GAME_OVER') {
        hideVictorySplashForActiveMatch();
    }

    // Hide Main Menu and ALL modals if game started
    if (gameState.status === 'IN_PROGRESS') {
        document.getElementById('matchmaking-overlay').classList.add('hidden');
        document.getElementById('hero-select-overlay').classList.add('hidden');
        clearHeroSelectCountdownTimer();
        document.getElementById('main-menu-container').classList.add('hidden');
        
        // Hide every modal just in case
        ['play-mode-modal', 'private-match-container', 'social-container', 'profile-container', 'character-menu-container', 'leaderboard-container', 'changelog-modal', 'settings-container'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });

        document.getElementById('ui-container').classList.remove('hidden');
        document.getElementById('emote-bar').classList.remove('hidden');
        renderEmoteBar();
    } else if (gameState.status === 'HERO_SELECT') {
        document.getElementById('matchmaking-overlay').classList.add('hidden');
        document.getElementById('ui-container').classList.add('hidden');
        document.getElementById('main-menu-container').classList.add('hidden');
        document.getElementById('hero-select-overlay').classList.remove('hidden');
        document.getElementById('emote-bar').classList.add('hidden');
        syncHeroSelectUIFromState();
        syncSpritesToLatestPlayers();
        reportPresenceIfChanged(true);
    } else if (gameState.status === 'WAITING_FOR_PLAYERS') {
        document.getElementById('ui-container').classList.add('hidden');
        
        if (gameState.isPrivate) {
            document.getElementById('main-menu-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.add('hidden');
            document.getElementById('hero-select-overlay').classList.remove('hidden');
            syncHeroSelectUIFromState();
        } else {
            // Keep background visible behind the translucent matching screen
            document.getElementById('main-menu-container').classList.remove('hidden');
            document.getElementById('hero-select-overlay').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
        }
        syncSpritesToLatestPlayers();
        reportPresenceIfChanged(true);
    } else if (gameState.status !== 'GAME_OVER') {
        document.getElementById('ui-container').classList.add('hidden');
        document.getElementById('emote-bar').classList.add('hidden');
    }

    // Update Health Bars & Animations
    if (gameState.status === 'IN_PROGRESS' && myPlayerId) {
        if (!matchStats.active) resetMatchStats();

        // Map players to slots depending on team
        const is2v2 = Object.keys(gameState.players).length > 2;
        
        let layoutSlots;
        if (is2v2) {
            const isTeamB = myPlayerId === 'p3' || myPlayerId === 'p4';
            const teamA = ['p1', 'p2'];
            const teamB = ['p3', 'p4'];
            const myTeam = isTeamB ? teamB : teamA;
            const enemyTeam = isTeamB ? teamA : teamB;
            layoutSlots = {
                'hud-p1': { id: myTeam[0], isEnemy: false },
                'hud-p2': { id: myTeam[1], isEnemy: false },
                'hud-p3': { id: enemyTeam[0], isEnemy: true },
                'hud-p4': { id: enemyTeam[1], isEnemy: true }
            };
        } else {
            // 1v1: me on left (hud-p1), opponent on right (hud-p3)
            const oppId = myPlayerId === 'p1' ? 'p2' : 'p1';
            layoutSlots = {
                'hud-p1': { id: myPlayerId, isEnemy: false },
                'hud-p3': { id: oppId, isEnemy: true }
            };
        }

        let myTeamHealth = 0;
        let oppTeamHealth = 0;

        for (const [slotId, slotInfo] of Object.entries(layoutSlots)) {
            const player = gameState.players[slotInfo.id];
            const hudEl = document.getElementById(slotId);
            if (!hudEl) continue;
            
            if (!player) {
                hudEl.classList.add('hidden');
                continue;
            }
            hudEl.classList.remove('hidden');

            const isMe = player.id === myPlayerId;
            const hpPct = (player.health / player.maxHealth) * 100;
            const hpEl = document.getElementById(slotId.replace('hud-', 'hp-'));
            const nameEl = document.getElementById(slotId.replace('hud-', 'name-'));
            const statusEl = document.getElementById(slotId.replace('hud-', 'status-'));

            if (hpEl) hpEl.style.width = `${Math.max(0, hpPct)}%`;
            if (nameEl) {
                let suffix = '';
                if (isMe) suffix = ' (You)';
                nameEl.innerText = `${player.username || 'Player'} - ${player.class}${suffix}`;
            }

            // Sync Phaser Avatars
            if (slotId === 'hud-p1' && playerLeftShape && player.classId) {
                let textureKey = textureKeyForClassAndSkin(player.classId, player.equippedSkin || 'Default');
                if (playerLeftShape.active && playerLeftShape.texture.key !== textureKey) {
                    playerLeftShape.setTexture(textureKey);
                    applyPhaserCharacterScales(playerLeftShape.scene);
                }
            } else if (slotId === 'hud-p3' && playerRightShape && player.classId) {
                let textureKey = textureKeyForClassAndSkin(player.classId, player.equippedSkin || 'Default');
                if (playerRightShape.active && playerRightShape.texture.key !== textureKey) {
                    playerRightShape.setTexture(textureKey);
                    applyPhaserCharacterScales(playerRightShape.scene);
                }
            } else if (slotId === 'hud-p2' && playerLeftShape2 && player.classId) {
                let textureKey = textureKeyForClassAndSkin(player.classId, player.equippedSkin || 'Default');
                if (playerLeftShape2.active && playerLeftShape2.texture.key !== textureKey) {
                    playerLeftShape2.setTexture(textureKey);
                }
            } else if (slotId === 'hud-p4' && playerRightShape2 && player.classId) {
                let textureKey = textureKeyForClassAndSkin(player.classId, player.equippedSkin || 'Default');
                if (playerRightShape2.active && playerRightShape2.texture.key !== textureKey) {
                    playerRightShape2.setTexture(textureKey);
                }
            }

            // Accumulate team health for win/loss
            if (slotInfo.isEnemy) oppTeamHealth += Math.max(0, player.health);
            else myTeamHealth += Math.max(0, player.health);

            // Damage Tracking Logic (Frontend Delta)
            if (matchStats.active) {
                let prevH = -1;
                if (slotId === 'hud-p1') prevH = prevMyHealth;
                else if (slotId === 'hud-p2') prevH = prevTeammateHealth;
                else if (slotId === 'hud-p3') prevH = prevOpponentHealth;
                else if (slotId === 'hud-p4') prevH = prevOpponent2Health;

                if (prevH !== -1) {
                    const diff = prevH - player.health;
                    if (diff > 0) {
                        // Someone took damage
                        if (slotInfo.isEnemy) {
                            // I (or my team) dealt damage to an enemy
                            // For simplicity, we credit it to the local player's matchStats if it happened on their turn,
                            // but usually damage-based quests are individual.
                            // Server-side tracking is accurate; this is for the live UI/splash fallback.
                            matchStats.damageDealt += diff;
                        } else {
                            // My team took damage
                            if (isMe) matchStats.damageTaken += diff;
                        }
                    }
                }

                // Update prev values
                if (slotId === 'hud-p1') prevMyHealth = player.health;
                else if (slotId === 'hud-p2') prevTeammateHealth = player.health;
                else if (slotId === 'hud-p3') prevOpponentHealth = player.health;
                else if (slotId === 'hud-p4') prevOpponent2Health = player.health;
            }

            // Render status badges
            statusEl.innerHTML = '';
            if (player.shield && player.shield.active) statusEl.innerHTML += `<span class="status-badge shield">🛡 ${player.shield.percent}%</span>`;
            if (player.dodge) statusEl.innerHTML += `<span class="status-badge dodge">⚡ Dodge</span>`;
        }

        if (lastTurnSnapshot !== null && lastTurnSnapshot !== gameState.turn) {
            matchStats.turnSwaps += 1;
        }
        lastTurnSnapshot = gameState.turn;
    }

    if (gameState.status === 'WAITING_FOR_PLAYERS') {
        document.getElementById('status-message').innerText = "Waiting for players...";
        document.getElementById('turn-timer').classList.add('hidden');
        document.querySelectorAll('.ability-btn').forEach(b => b.disabled = true);
    } else if (gameState.status === 'HERO_SELECT') {
        document.getElementById('status-message').innerText = "Hero Select";
        document.getElementById('turn-timer').classList.add('hidden');
        document.getElementById('ability-bar').classList.add('hidden');
        document.querySelectorAll('.ability-btn').forEach(b => b.disabled = true);
    } else if (gameState.status === 'IN_PROGRESS') {
        document.getElementById('main-menu-container').classList.add('hidden');
        document.getElementById('hero-select-overlay').classList.add('hidden');
        document.getElementById('matchmaking-overlay').classList.add('hidden');
        document.getElementById('game-container').classList.remove('hidden');
        document.getElementById('ui-container').classList.remove('hidden');
        document.getElementById('emote-bar').classList.remove('hidden');

        const is2v2 = Object.keys(gameState.players).length > 2;
        const myPlayer = gameState.players[myPlayerId];
        
        // In 2v2, turns are simultaneous. Everyone can act if alive and haven't acted yet.
        // Pending actions aren't directly sent to clients yet to prevent peeking, but we can assume 'isMyTurn=true' continuously.
        const isMyTurn = is2v2 ? (myPlayer && myPlayer.health > 0) : ((myPlayerId === 'p1' && gameState.turn === 0) || (myPlayerId === 'p2' && gameState.turn === 1));

        document.getElementById('status-message').innerText = isMyTurn ? "Your Turn!" : "Waiting...";
        
        document.getElementById('ability-bar').classList.remove('hidden');
        document.getElementById('btn-return').classList.add('hidden');

        if (myPlayer && myPlayer.abilities) {
            document.querySelectorAll('.ability-btn').forEach((btn, i) => {
                const ab = myPlayer.abilities[i];
                if (!ab) return;
                btn.querySelector('.ability-name').innerText = ab.name;
                if (ab.currentCd > 0) {
                    btn.disabled = true;
                    btn.classList.add('on-cooldown');
                    btn.querySelector('.ability-cd').innerText = `${ab.currentCd} turns`;
                    btn.querySelector('.ability-cd').classList.remove('hidden');
                } else {
                    btn.disabled = !isMyTurn;
                    btn.classList.remove('on-cooldown');
                    btn.querySelector('.ability-cd').classList.add('hidden');
                }
            });
        }

        if (gameState.turnDeadline) {
            document.getElementById('turn-timer').classList.remove('hidden');
            updateTurnTimer();
        }

        // Highlight active sides
        if (!is2v2) {
            document.getElementById('team-left').classList.toggle('active-turn', isMyTurn);
            document.getElementById('team-right').classList.toggle('active-turn', !isMyTurn);
        } else {
            document.getElementById('team-left').classList.add('active-turn');
            document.getElementById('team-right').classList.add('active-turn');
        }
    } else if (gameState.status === 'GAME_OVER') {
        let winnerMsg = "Game Over - Draw";
        
        const isTeamB = myPlayerId === 'p3' || myPlayerId === 'p4';
        const teamA = [gameState.players['p1'], gameState.players['p2']].filter(Boolean);
        const teamB = [gameState.players['p3'], gameState.players['p4']].filter(Boolean);
        
        const myTeamAlive = isTeamB ? teamB.some(p => p.health > 0) : teamA.some(p => p.health > 0);
        const enemyTeamAlive = isTeamB ? teamA.some(p => p.health > 0) : teamB.some(p => p.health > 0);
        
        if (myTeamAlive && !enemyTeamAlive) winnerMsg = "Victory!";
        else if (!myTeamAlive && enemyTeamAlive) winnerMsg = "Defeat!";

        const me = gameState.players[myPlayerId];
        const opp = gameState.players[myPlayerId === 'p1' ? 'p2' : 'p1']; // purely for sounds

        document.getElementById('status-message').innerText = winnerMsg;
        document.getElementById('ability-bar').classList.add('hidden');
        document.getElementById('emote-bar').classList.add('hidden');
        document.getElementById('turn-timer').classList.add('hidden');

        // Trigger XP Splash once
        const canShowSplash = me && (me.postGame || (winnerMsg !== "Game Over - Draw"));
        if (canShowSplash && !document.getElementById('xp-splash-overlay').classList.contains('active-showing')) {
            const won = me && me.health > 0;
            // The active-showing class ensures we only trigger this ONCE per game completion
            document.getElementById('xp-splash-overlay').classList.add('active-showing');
            
            // GO NUCLEAR: Clear game to prevent click interception
            destroyGame();
            
            showXPSplash(won, me ? me.postGame : null).catch(e => console.error("[Splash] Critical fail", e));
        }

        // Play game-over sound once
        if (me && opp && !document.getElementById('xp-splash-overlay').classList.contains('active-showing')) {
            const iWon = me.health > 0 && opp.health <= 0;
            sfx.playGameOver(iWon);
        }
    } else {
        // Rematch / odd states: hide splash (hero-select visibility is handled in the first updateUI block only)
        document.getElementById('xp-splash-overlay').classList.add('hidden');
        document.getElementById('xp-splash-overlay').classList.remove('active-showing');
        if (gameState.status !== 'IN_PROGRESS') endMatchStatsSession();
    }

    const nowBattle = shouldUseBattleSpriteLayout();
    if (nowBattle !== phaserLayoutBattleMode) {
        phaserLayoutBattleMode = nowBattle;
        refreshPhaserCharacterLayout();
    }
    syncGameContainerPointerEvents();
}

// Turn timer client-side display
let timerInterval = null;
function updateTurnTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (!gameState || !gameState.turnDeadline || gameState.status !== 'IN_PROGRESS') {
            clearInterval(timerInterval);
            return;
        }
        const remaining = Math.max(0, gameState.turnDeadline - Date.now());
        const pct = (remaining / 15000) * 100;
        document.getElementById('timer-bar').style.setProperty('--timer-pct', `${pct}%`);
        document.getElementById('timer-text').innerText = `${Math.ceil(remaining / 1000)}s`;
    }, 200);
}

// Main Menu Events
document.getElementById('btn-character').addEventListener('click', () => {
    document.getElementById('character-menu-container').classList.remove('hidden');
});

document.getElementById('btn-close-char-menu').addEventListener('click', () => {
    document.getElementById('character-menu-container').classList.add('hidden');
});

document.getElementById('btn-play-game').addEventListener('click', () => {
    closeMenuActivityPopover();
    initGame();
    document.getElementById('play-mode-modal').classList.remove('hidden');
});

document.getElementById('btn-close-play-mode').addEventListener('click', () => {
    document.getElementById('play-mode-modal').classList.add('hidden');
});

function startMatchmaking(queueType) {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    document.getElementById('play-mode-modal').classList.add('hidden');
    document.getElementById('matchmaking-overlay').classList.remove('hidden');
    
    let mmText = "Finding Match...";
    if (queueType === '2v2') mmText = "Finding 2v2 Match...";
    if (queueType === 'ranked') mmText = "Finding Ranked Match...";
    if (queueType === 'casual') mmText = "Finding 1v1 Match...";
    document.getElementById('matchmaking-text').innerText = mmText;
    
    reportPresenceIfChanged(true);
    heroSelectLocked = false;
    heroSelectCountdownUntil = 0;
    clearHeroSelectCountdownTimer();
    const initialChar = CHARACTER_CLASSES[selectedCharacterIndex] ? CHARACTER_CLASSES[selectedCharacterIndex].id : 'aegisKnight';
    heroSelectPick = { charId: initialChar, skin: 'Default' };
    setHeroSelectSkinOptions(initialChar, 'Default');
    updateHeroSelectCardClasses(initialChar);
    syncHeroSelectFeature(initialChar);
    connectWebSocket(null, queueType);
}

document.getElementById('btn-quick-match-1v1').addEventListener('click', () => startMatchmaking('casual'));
document.getElementById('btn-quick-match-2v2').addEventListener('click', () => startMatchmaking('2v2'));
document.getElementById('btn-ranked-match').addEventListener('click', () => startMatchmaking('ranked'));

document.getElementById('btn-private-choice').addEventListener('click', () => {
    document.getElementById('play-mode-modal').classList.add('hidden');
    document.getElementById('private-match-container').classList.remove('hidden');
    reportPresenceIfChanged(true);
});

document.querySelectorAll('.char-card').forEach(card => {
    card.addEventListener('click', (e) => {
        const charId = card.getAttribute('data-char');
        selectedCharacterIndex = CHARACTER_CLASSES.findIndex(c => c.id === charId);
        
        // Highlight selection
        document.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected-card'));
        card.classList.add('selected-card');
        
        sfx.playClick();
        persistLastSelectedCharacterId(charId);
        updateMenuCharacterDisplay();
    });
});

document.querySelectorAll('.hero-select-card').forEach(card => {
    card.addEventListener('click', () => {
        if (heroSelectLocked) return;
        const charId = card.getAttribute('data-hero-select');
        heroSelectPick.charId = charId;
        heroSelectPick.skin = 'Default';
        updateHeroSelectCardClasses(charId);
        syncHeroSelectFeature(charId);
        setHeroSelectSkinOptions(charId, 'Default');
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: 'hero-pick', charId, skin: heroSelectPick.skin }));
        }
    });
});

const heroSelectSkinEl = document.getElementById('hero-select-skin');
if (heroSelectSkinEl) {
    heroSelectSkinEl.addEventListener('change', () => {
        if (heroSelectLocked) return;
        heroSelectPick.skin = heroSelectSkinEl.value || 'Default';
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: 'hero-pick', charId: heroSelectPick.charId, skin: heroSelectPick.skin }));
        }
    });
}

const btnHeroReady = document.getElementById('btn-hero-ready');
if (btnHeroReady) {
    btnHeroReady.addEventListener('click', () => {
        if (heroSelectLocked) return;
        if (!heroSelectPick.charId) return;
        heroSelectLocked = true;
        syncHeroSelectUIFromState();
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                action: 'hero-ready',
                charId: heroSelectPick.charId,
                skin: heroSelectPick.skin || 'Default'
            }));
        }
    });
}

// Customize links inside cards
document.querySelectorAll('.btn-customize-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const charId = btn.closest('.char-card').getAttribute('data-char');
        openCharacterPreview(charId);
    });
});

document.getElementById('btn-battle-pass').addEventListener('click', () => {
    openBattlePass();
});

document.getElementById('btn-shop').addEventListener('click', () => {
    document.getElementById('shop-container').classList.remove('hidden');
    renderShop();
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
});

document.getElementById('btn-close-shop').addEventListener('click', () => {
    document.getElementById('shop-container').classList.add('hidden');
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
});

window.buyShopItem = async function(itemId) {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    try {
        const res = await fetch('/shop/purchase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, itemId })
        });
        const data = await res.json();
        if (data.ok) {
            playerProfileData = data.stats;
            renderShop();
            updateRosterStats();
        } else {
            alert("Shop Error: " + data.error);
        }
    } catch (e) { console.error(e); }
};

function renderShop() {
    const grid = document.getElementById('shop-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const catalog = playerProfileData && playerProfileData.shopCatalog ? playerProfileData.shopCatalog : [];
    const lumens = playerProfileData ? playerProfileData.lumens || 0 : 0;
    
    document.getElementById('nav-lumen-count').innerText = lumens;

    catalog.forEach(item => {
        const titleOwned = item.type === 'title' && playerProfileData.unlockedTitles && playerProfileData.unlockedTitles.includes(item.name);
        const cosmeticOwned = item.type !== 'title' && playerProfileData.unlockedCosmetics && playerProfileData.unlockedCosmetics.includes(item.name);
        const owned = titleOwned || cosmeticOwned;
        const canAfford = lumens >= item.price;
        
        let icon = '🎁';
        if (item.type === 'emote') icon = item.name;
        if (item.type === 'title') icon = '🏅';
        if (item.type === 'skin') icon = '🎭';

        grid.innerHTML += `
            <div class="shop-card ${owned ? 'owned' : ''}" style="background: rgba(0,0,0,0.5); padding: 15px; border-radius: 8px; text-align: center; border: 1px solid ${owned ? '#555' : (canAfford ? '#ff00cc' : '#333')}; transition: border 0.3s;">
                <div style="font-size: 2rem; margin-bottom: 10px;">${icon}</div>
                <h3 style="font-size: 1.1rem; margin-bottom: 5px; color: ${owned ? '#888' : '#fff'};">${item.name}</h3>
                <p style="font-size: 0.8rem; color: #aaa; margin-bottom: 15px; text-transform: uppercase;">${item.type}</p>
                ${owned 
                    ? `<button disabled class="menu-btn secondary-btn" style="width: 100%; padding: 10px; opacity: 0.5;">Owned</button>` 
                    : `<button class="menu-btn" style="width: 100%; padding: 10px; background: ${canAfford ? 'linear-gradient(45deg, #ff00cc, #4a00e0)' : '#333'}; color: ${canAfford ? '#fff' : '#888'}; border: none;" onclick="buyShopItem('${item.id}')" ${canAfford ? '' : 'disabled'}>${item.price} L</button>`
                }
            </div>
        `;
    });
}

document.getElementById('btn-save-customization').addEventListener('click', () => {
    saveCustomization();
});

const btnSaveProfileTitle = document.getElementById('btn-save-profile-title');
if (btnSaveProfileTitle) {
    btnSaveProfileTitle.addEventListener('click', () => {
        saveProfileTitle();
    });
}

function updateMenuCharacterDisplay() {
    const char = CHARACTER_CLASSES[selectedCharacterIndex];
    if (!char) return;
    const roleLine = String(char.stats || '').split('<br>')[0] || '';
    const pressureLine = String(char.stats || '').split('<br>')[1] || '';
    const roleName = roleLine.replace(/\s*Class\s*$/i, '').trim() || 'Hero';
    const spotlight = MENU_CHARACTER_SPOTLIGHT[char.id] || {};
    document.getElementById('menu-char-name').innerText = char.name;
    document.getElementById('menu-char-stats').innerHTML = char.stats;
    const rolePill = document.getElementById('menu-char-role');
    if (rolePill) rolePill.innerText = roleName;
    const roleNameEl = document.getElementById('menu-char-role-name');
    if (roleNameEl) roleNameEl.innerText = roleName;
    const pressureEl = document.getElementById('menu-char-pressure');
    if (pressureEl) pressureEl.innerText = spotlight.pressure || pressureLine || 'Flexible pressure';
    const hookEl = document.getElementById('menu-char-hook');
    if (hookEl) hookEl.innerText = spotlight.hook || 'Step into the arena with a tuned combat style and sharpened matchup plan.';
    const hpEl = document.getElementById('menu-char-hp');
    if (hpEl) hpEl.innerText = String(char.hp || 0);
    const atkEl = document.getElementById('menu-char-atk');
    if (atkEl) atkEl.innerText = String(char.atk || 0);
    const playSelectedEl = document.getElementById('menu-play-selected-hero');
    if (playSelectedEl) playSelectedEl.innerText = char.name;

    if (playerProfileData && playerProfileData.classes[char.id]) {
        const pClass = playerProfileData.classes[char.id];
        document.getElementById('menu-char-name').innerText = `${char.name} (Lv. ${pClass.level})`;
        if (playSelectedEl) playSelectedEl.innerText = `${char.name} Lv. ${pClass.level}`;
    }

    const tex = menuHeroTextureKey(char.id);
    if (playerLeftShape && playerLeftShape.active) {
        playerLeftShape.setTexture(tex);
        refreshPhaserCharacterLayout();
    }
}

function persistLastSelectedCharacterId(charId) {
    if (!CHARACTER_CLASSES.some(c => c.id === charId)) return;
    localStorage.setItem(PREF_KEYS.lastMenuCharacter, charId);
}

function hydrateSelectedCharacterFromStorage() {
    const raw = localStorage.getItem(PREF_KEYS.lastMenuCharacter);
    if (!raw) return;
    const idx = CHARACTER_CLASSES.findIndex(c => c.id === raw);
    if (idx >= 0) {
        selectedCharacterIndex = idx;
        currentPreviewCharId = CHARACTER_CLASSES[idx].id;
    }
}

function syncRosterCardSelectionClasses() {
    const id = CHARACTER_CLASSES[selectedCharacterIndex]?.id;
    if (!id) return;
    document.querySelectorAll('.char-card').forEach(c => {
        c.classList.toggle('selected-card', c.getAttribute('data-char') === id);
    });
}

hydrateSelectedCharacterFromStorage();
syncRosterCardSelectionClasses();
updateMenuCharacterDisplay();

// Update character card levels/xp from profile
function updateRosterStats() {
    if (!playerProfileData) return;
    
    const lCount = document.getElementById('nav-lumen-count');
    if (lCount) lCount.innerText = playerProfileData.lumens || 0;
    syncMainMenuStatusWidgets(playerProfileData);

    document.querySelectorAll('.char-card').forEach(card => {
        const charId = card.getAttribute('data-char');
        const pClass = playerProfileData.classes[charId] || { level: 1, xp: 0 };
        
        const badge = card.querySelector('.char-level-badge');
        if (badge) badge.innerText = `Lv. ${pClass.level}`;
        
        const fill = card.querySelector('.char-card-xp-bar .fill');
        if (fill) fill.style.width = `${classLevelProgress(pClass).pct}%`;
    });
}
// Hook into profile fetch
const oldFetch = fetchPlayerProfile;
fetchPlayerProfile = async function(silent) {
    if (typeof oldFetch === 'function') await oldFetch(silent);
    updateRosterStats();
    updateMenuCharacterDisplay();
};

// Username editing
document.getElementById('btn-edit-username').addEventListener('click', () => {
    document.getElementById('username-display').classList.add('hidden');
    document.getElementById('username-editor').classList.remove('hidden');
    document.getElementById('input-username').value = myUsername;
    document.getElementById('input-username').focus();
    document.getElementById('username-error').classList.add('hidden');
});

document.getElementById('btn-save-username').addEventListener('click', async () => {
    const newName = document.getElementById('input-username').value.trim();
    const errorEl = document.getElementById('username-error');
    errorEl.classList.add('hidden');

    if (newName.length < 3 || newName.length > 16) {
        errorEl.innerText = '3-16 characters required';
        errorEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/set-username`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, username: newName })
        });
        const data = await res.json();
        if (data.ok) {
            myUsername = data.username;
            document.getElementById('profile-username').innerText = data.username;
            document.getElementById('username-editor').classList.add('hidden');
            document.getElementById('username-display').classList.remove('hidden');
            syncMainMenuHeaderProfile({
                username: data.username,
                level: playerProfileData && playerProfileData.level != null ? playerProfileData.level : 1
            });
        } else {
            errorEl.innerText = data.error || 'Failed to save';
            errorEl.classList.remove('hidden');
        }
    } catch (e) {
        errorEl.innerText = 'Connection error';
        errorEl.classList.remove('hidden');
    }
});

function syncSocialModalHeader() {
    const eyebrow = document.getElementById('social-modal-eyebrow');
    const title = document.getElementById('social-modal-title');
    const friendsBtn = document.getElementById('btn-friends');
    const guildBtn = document.getElementById('btn-guild');
    const onGuild = activeSocialTab === 'guild';
    if (eyebrow) eyebrow.innerText = onGuild ? 'Guild Network' : 'Friends Network';
    if (title) title.innerText = onGuild ? 'Guild' : 'Friends';
    friendsBtn?.classList.toggle('menu-nav-item--active', !onGuild);
    guildBtn?.classList.toggle('menu-nav-item--active', onGuild);
}

function openSocialHub(tabName = 'friends') {
    document.getElementById('social-container').classList.remove('hidden');
    setActiveSocialTab(tabName === 'guild' ? 'guild' : 'friends');
    fetchFriends();
}

document.getElementById('btn-friends').addEventListener('click', () => {
    openSocialHub('friends');
});

document.getElementById('btn-guild').addEventListener('click', () => {
    openSocialHub('guild');
});

document.getElementById('btn-close-social').addEventListener('click', () => {
    document.getElementById('social-container').classList.add('hidden');
    document.getElementById('btn-friends')?.classList.remove('menu-nav-item--active');
    document.getElementById('btn-guild')?.classList.remove('menu-nav-item--active');
});

async function parseJsonResponse(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new Error(
            snippet ? `Server returned non-JSON (HTTP ${res.status}): ${snippet}` : `Bad response (HTTP ${res.status})`
        );
    }
}

async function fetchFriends(silent = false) {
    if (!silent) document.getElementById('friends-list').innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Updating social...</div>';
    if (!silent) document.getElementById('guild-panel').innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Syncing guild...</div>';
    try {
        const res = await fetch(`/friends-status?uid=${localUid}`);
        const data = await res.json();
        await fetchGuildDirectory(true);
        updateSocialUI(data, { passiveRefresh: !!silent });
    } catch (e) {}
}

async function fetchGuildDirectory(silent = false) {
    try {
        const res = await fetch('/guild/directory');
        const data = await parseJsonResponse(res);
        guildDirectoryCache = Array.isArray(data.guilds) ? data.guilds : [];
        if (!silent && lastSocialSnapshot && !lastSocialSnapshot.guild) renderGuildPanel(null);
    } catch (e) {
        if (!silent) guildDirectoryCache = [];
    }
}

function guildIconCrest(iconId) {
    switch (iconId) {
        case 'crown':
            return `
                <div class="guild-crest-mark guild-crest-mark--crown" aria-hidden="true">
                    <span></span><span></span><span></span><span></span>
                </div>
            `;
        case 'nova':
            return `
                <div class="guild-crest-mark guild-crest-mark--nova" aria-hidden="true">
                    <span></span><span></span><span></span><span></span>
                </div>
            `;
        case 'wolf':
            return `
                <div class="guild-crest-mark guild-crest-mark--wolf" aria-hidden="true">
                    <span></span><span></span><span></span>
                </div>
            `;
        case 'comet':
        default:
            return `
                <div class="guild-crest-mark guild-crest-mark--comet" aria-hidden="true">
                    <span></span><span></span><span></span>
                </div>
            `;
    }
}

function guildBannerClass(bannerId) {
    return `guild-hero guild-hero--${bannerId || 'aurora'}`;
}

function guildVisualSelectOptions(options, currentId) {
    return options.map((option) => `<option value="${option.id}" ${option.id === currentId ? 'selected' : ''}>${option.label}</option>`).join('');
}

function guildRecruitmentLabel(status) {
    switch (status) {
        case 'invite_only': return 'Invite Only';
        case 'closed': return 'Closed';
        case 'recruiting':
        default: return 'Recruiting';
    }
}

function guildRecruitmentFocusLabel(focus) {
    switch (focus) {
        case 'duels': return '1v1 Focus';
        case 'squads': return '2v2 Focus';
        case 'all_modes':
        default: return 'All Modes';
    }
}

function guildRecruitmentPlaystyleLabel(playstyle) {
    switch (playstyle) {
        case 'casual': return 'Casual';
        case 'competitive': return 'Competitive';
        case 'mixed':
        default: return 'Mixed';
    }
}

function guildDirectoryEntries(currentGuildId = null) {
    const query = (guildDirectoryFilters.query || '').trim().toLowerCase();
    const recruitingOnly = !!guildDirectoryFilters.recruitingOnly;
    const sort = guildDirectoryFilters.sort || 'fit';
    const entries = guildDirectoryCache.filter((entry) => {
        const recruitment = entry.recruitment || {};
        const status = recruitment.status || 'recruiting';
        if (entry.id && entry.id === currentGuildId) return true;
        if (recruitingOnly && status !== 'recruiting') return false;
        if (!query) return true;
        const blob = [
            entry.name,
            entry.tag,
            entry.leaderName,
            entry.description,
            recruitment.message,
            recruitment.focus,
            recruitment.playstyle,
            entry.bulletin && entry.bulletin.message
        ].join(' ').toLowerCase();
        return blob.includes(query);
    });
    entries.sort((a, b) => {
        const aStatus = (a.recruitment && a.recruitment.status) || 'recruiting';
        const bStatus = (b.recruitment && b.recruitment.status) || 'recruiting';
        if (sort === 'newest') return (b.createdAt || 0) - (a.createdAt || 0);
        if (sort === 'xp') return (b.xp || 0) - (a.xp || 0) || (b.memberCount || 0) - (a.memberCount || 0);
        if (sort === 'members') return (b.memberCount || 0) - (a.memberCount || 0) || (b.xp || 0) - (a.xp || 0);
        const statusScore = { recruiting: 3, invite_only: 2, closed: 1 };
        return (statusScore[bStatus] || 0) - (statusScore[aStatus] || 0)
            || ((b.memberCount || 0) - (a.memberCount || 0))
            || ((b.xp || 0) - (a.xp || 0));
    });
    return entries;
}

function setGuildNoGuildView(view = 'home') {
    guildNoGuildView = ['home', 'create', 'join'].includes(view) ? view : 'home';
    renderGuildPanel(null);
}

function getKnownPlayerGuild() {
    return playerProfileData && playerProfileData.guild ? playerProfileData.guild : null;
}

async function hydrateCurrentGuildFromBackend() {
    if (guildInfoHydrationPromise) return guildInfoHydrationPromise;
    guildInfoHydrationPromise = (async () => {
        try {
            const res = await fetch(`/guild/info?uid=${localUid}`);
            const data = await parseJsonResponse(res);
            if (data && data.ok && data.guild) {
                applyGuildToSocialState(data.guild);
            }
        } catch (e) {
        } finally {
            guildInfoHydrationPromise = null;
        }
    })();
    return guildInfoHydrationPromise;
}

function escapeGuildFieldValue(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function captureGuildDraftState() {
    const createName = document.getElementById('guild-create-name');
    if (createName) guildDraftState.createName = createName.value;
    const createTag = document.getElementById('guild-create-tag');
    if (createTag) guildDraftState.createTag = createTag.value;
    const createDescription = document.getElementById('guild-create-description');
    if (createDescription) guildDraftState.createDescription = createDescription.value;
    const createIcon = document.getElementById('guild-create-icon');
    if (createIcon) guildDraftState.createIcon = createIcon.value || 'comet';
    const createBanner = document.getElementById('guild-create-banner');
    if (createBanner) guildDraftState.createBanner = createBanner.value || 'aurora';
    const createPrivacy = document.getElementById('guild-create-privacy');
    if (createPrivacy) guildDraftState.createPrivacy = createPrivacy.value || 'public';
    const joinCode = document.getElementById('guild-join-code');
    if (joinCode) guildDraftState.joinCode = joinCode.value;

    const guildId = lastSocialSnapshot?.guild?.id || null;
    const adminDescription = document.getElementById('guild-admin-description');
    if (adminDescription) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminDescription = adminDescription.value;
    }
    const adminIcon = document.getElementById('guild-admin-icon');
    if (adminIcon) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminIcon = adminIcon.value || 'comet';
    }
    const adminBanner = document.getElementById('guild-admin-banner');
    if (adminBanner) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminBanner = adminBanner.value || 'aurora';
    }
    const adminPrivacy = document.getElementById('guild-admin-privacy');
    if (adminPrivacy) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminPrivacy = adminPrivacy.value || 'public';
    }
    const adminRecruitmentStatus = document.getElementById('guild-admin-recruitment-status');
    if (adminRecruitmentStatus) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminRecruitmentStatus = adminRecruitmentStatus.value || 'recruiting';
    }
    const adminRecruitmentMessage = document.getElementById('guild-admin-recruitment-message');
    if (adminRecruitmentMessage) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminRecruitmentMessage = adminRecruitmentMessage.value;
    }
    const adminRecruitmentFocus = document.getElementById('guild-admin-recruitment-focus');
    if (adminRecruitmentFocus) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminRecruitmentFocus = adminRecruitmentFocus.value || 'all_modes';
    }
    const adminRecruitmentPlaystyle = document.getElementById('guild-admin-recruitment-playstyle');
    if (adminRecruitmentPlaystyle) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminRecruitmentPlaystyle = adminRecruitmentPlaystyle.value || 'mixed';
    }
    const adminBulletinMessage = document.getElementById('guild-admin-bulletin-message');
    if (adminBulletinMessage) {
        guildDraftState.adminGuildId = guildId;
        guildDraftState.adminBulletinMessage = adminBulletinMessage.value;
    }
    const chatInput = document.getElementById('guild-chat-input');
    if (chatInput) {
        guildDraftState.chatGuildId = guildId;
        guildDraftState.chatInput = chatInput.value;
    }
}

function captureGuildFocusState() {
    const active = document.activeElement;
    if (!active || !active.id || !active.closest('#guild-panel')) {
        guildFocusState = null;
        return;
    }
    guildFocusState = {
        id: active.id,
        selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    };
}

function restoreGuildFocusState() {
    if (!guildFocusState || document.activeElement?.id === guildFocusState.id) return;
    const target = document.getElementById(guildFocusState.id);
    if (!target) {
        guildFocusState = null;
        return;
    }
    try {
        target.focus({ preventScroll: true });
    } catch (e) {
        target.focus();
    }
    if (typeof guildFocusState.selectionStart === 'number' && typeof target.setSelectionRange === 'function') {
        try {
            target.setSelectionRange(guildFocusState.selectionStart, guildFocusState.selectionEnd ?? guildFocusState.selectionStart);
        } catch (e) {}
    }
    guildFocusState = null;
}

function captureGuildScrollState() {
    const panel = document.getElementById('guild-panel');
    const socialContainer = document.getElementById('social-container');
    const guildTabPanel = document.getElementById('social-guild-tab-panel');
    guildScrollState = panel ? (panel.scrollTop || 0) : 0;
    guildContainerScrollState = socialContainer ? (socialContainer.scrollTop || 0) : 0;
    guildTabPanelScrollState = guildTabPanel ? (guildTabPanel.scrollTop || 0) : 0;
}

function restoreGuildScrollState() {
    const panel = document.getElementById('guild-panel');
    const socialContainer = document.getElementById('social-container');
    const guildTabPanel = document.getElementById('social-guild-tab-panel');
    if (socialContainer) socialContainer.scrollTop = Math.max(0, guildContainerScrollState || 0);
    if (guildTabPanel) guildTabPanel.scrollTop = Math.max(0, guildTabPanelScrollState || 0);
    if (panel) panel.scrollTop = Math.max(0, guildScrollState || 0);
}

function restoreGuildViewStateDeferred() {
    const restore = () => {
        restoreGuildFocusState();
        restoreGuildScrollState();
    };
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        restore();
        return;
    }
    window.requestAnimationFrame(() => {
        restore();
        window.requestAnimationFrame(restoreGuildScrollState);
    });
}

function clearGuildDraftState(mode = 'all') {
    if (mode === 'all' || mode === 'noguild') {
        guildDraftState.createName = '';
        guildDraftState.createTag = '';
        guildDraftState.createDescription = '';
        guildDraftState.createIcon = 'comet';
        guildDraftState.createBanner = 'aurora';
        guildDraftState.createPrivacy = 'public';
        guildDraftState.joinCode = '';
    }
    if (mode === 'all' || mode === 'guild') {
        guildDraftState.adminGuildId = null;
        guildDraftState.adminDescription = '';
        guildDraftState.adminIcon = 'comet';
        guildDraftState.adminBanner = 'aurora';
        guildDraftState.adminPrivacy = 'public';
        guildDraftState.adminRecruitmentStatus = 'recruiting';
        guildDraftState.adminRecruitmentMessage = '';
        guildDraftState.adminRecruitmentFocus = 'all_modes';
        guildDraftState.adminRecruitmentPlaystyle = 'mixed';
        guildDraftState.adminBulletinMessage = '';
        guildDraftState.chatGuildId = null;
        guildDraftState.chatInput = '';
    }
}

function applyGuildToSocialState(guild, options = {}) {
    const preferTab = options.preferTab === 'guild' ? 'guild' : 'friends';
    captureGuildDraftState();
    captureGuildFocusState();
    captureGuildScrollState();
    const base = lastSocialSnapshot || { friends: [], requests: [], invites: [] };
    const next = { ...base, guild: guild || null };
    lastSocialSnapshot = next;
    if (guild) clearGuildDraftState('noguild');
    else {
        clearGuildDraftState('guild');
        guildNoGuildView = 'home';
    }
    renderSocialGuildPreview(next.guild);
    renderGuildPanel(next.guild);
    restoreGuildViewStateDeferred();
    setActiveSocialTab(next.guild ? 'guild' : preferTab);
}

function setActiveSocialTab(tabName = 'friends') {
    activeSocialTab = tabName === 'guild' ? 'guild' : 'friends';
    document.querySelectorAll('[data-social-tab]').forEach((btn) => {
        const isActive = btn.dataset.socialTab === activeSocialTab;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('[data-social-tab-panel]').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.socialTabPanel === activeSocialTab);
    });
    syncSocialModalHeader();
}

function renderSocialGuildPreview(guild) {
    const preview = document.getElementById('social-guild-preview');
    if (!preview) return;
    if (!guild) {
        preview.classList.add('hidden');
        preview.innerHTML = '';
        return;
    }
    preview.classList.remove('hidden');
    preview.innerHTML = `
        <div class="social-guild-preview-main">
            <div class="social-guild-preview-title">[${guild.tag}] ${guild.name}</div>
            <div class="social-guild-preview-meta">Guild Lv. ${guild.level || 1} · ${guild.memberCount || 0}/${guild.memberCap || 50} members · Leader ${guild.leaderName || 'Unknown'}</div>
        </div>
        <div class="social-guild-preview-actions">
            <button type="button" id="btn-open-guild-tab" class="menu-btn secondary-btn social-guild-preview-btn">Open Guild</button>
            <button type="button" id="btn-leave-guild-preview" class="menu-btn secondary-btn social-guild-preview-btn">Leave Guild</button>
        </div>
    `;
    document.getElementById('btn-open-guild-tab')?.addEventListener('click', () => openSocialHub('guild'));
    document.getElementById('btn-leave-guild-preview')?.addEventListener('click', leaveGuild);
}


function renderGuildPanel(guild) {
    const panel = document.getElementById('guild-panel');
    const count = document.getElementById('guild-count');
    if (!panel || !count) return;
    const currentGuildId = lastSocialSnapshot?.guild?.id || null;
    const createName = escapeGuildFieldValue(guildDraftState.createName || '');
    const createTag = escapeGuildFieldValue(guildDraftState.createTag || '');
    const createDescription = escapeGuildFieldValue(guildDraftState.createDescription || '');
    const createIcon = guildDraftState.createIcon || 'comet';
    const createBanner = guildDraftState.createBanner || 'aurora';
    const createPrivacy = guildDraftState.createPrivacy || 'public';
    const joinCode = escapeGuildFieldValue(guildDraftState.joinCode || '');
    const adminDraftMatchesGuild = !!(guild && guildDraftState.adminGuildId === guild.id);
    const chatDraftMatchesGuild = !!(guild && guildDraftState.chatGuildId === guild.id);
    const browserQuery = escapeGuildFieldValue(guildDirectoryFilters.query || '');
    const browserEntries = guildDirectoryEntries(currentGuildId);
    const knownPlayerGuild = getKnownPlayerGuild();

    if (!guild && ['home', 'create', 'join'].includes(guildNoGuildView)) {
        if (knownPlayerGuild) {
            count.innerText = `${knownPlayerGuild.memberCount || '...'} members`;
            panel.innerHTML = `
                <div class="guild-shell">
                    <div class="guild-panel-note">Loading your guild data for [${knownPlayerGuild.tag}] ${knownPlayerGuild.name}...</div>
                    <div class="guild-admin-panel">
                        <div class="guild-section-title">Guild Sync</div>
                        <div class="guild-directory-meta">You are already in a guild, so this tab is syncing your live guild page instead of showing create or join options.</div>
                    </div>
                </div>
            `;
            hydrateCurrentGuildFromBackend();
            return;
        }
        count.innerText = 'Solo';
        panel.innerHTML = `
            <div class="guild-shell">
                <div class="guild-panel-note">Choose how you want to get into a guild. Create one for your squad or browse and join an existing community.</div>
                <div class="guild-choice-shell ${guildNoGuildView === 'home' ? '' : 'hidden'}">
                    <button type="button" id="btn-guild-open-create" class="guild-choice-card">
                        <strong>Create Guild</strong>
                        <span>Start a new guild with your own tag, visuals, and recruiting setup.</span>
                    </button>
                    <button type="button" id="btn-guild-open-join" class="guild-choice-card">
                        <strong>Join Guild</strong>
                        <span>Use a guild code or browse public guilds that are currently recruiting.</span>
                    </button>
                </div>
                <div class="guild-subview ${guildNoGuildView === 'create' ? '' : 'hidden'}">
                    <div class="guild-subview-head">
                        <div>
                            <div class="guild-section-title">Create Guild</div>
                            <div class="guild-panel-note">Set up your guild identity first. You can tune recruiting details after it is created.</div>
                        </div>
                        <button type="button" id="btn-guild-back-home-create" class="menu-btn secondary-btn guild-inline-btn">Back</button>
                    </div>
                    <div class="guild-form-grid">
                        <input type="text" id="guild-create-name" class="social-input" maxlength="32" placeholder="Guild name" value="${createName}">
                        <input type="text" id="guild-create-tag" class="social-input" maxlength="5" placeholder="Tag" value="${createTag}">
                        <button type="button" id="btn-guild-create" class="action-btn social-add-btn guild-inline-btn">Create</button>
                    </div>
                    <textarea id="guild-create-description" class="social-input" maxlength="180" placeholder="Guild description" style="min-height:84px; resize:vertical;">${createDescription}</textarea>
                    <div class="guild-admin-grid">
                        <select id="guild-create-icon" class="social-input">${guildVisualSelectOptions(GUILD_ICON_PRESETS, createIcon)}</select>
                        <select id="guild-create-banner" class="social-input">${guildVisualSelectOptions(GUILD_BANNER_PRESETS, createBanner)}</select>
                        <select id="guild-create-privacy" class="social-input">
                            <option value="public" ${createPrivacy === 'public' ? 'selected' : ''}>Public guild</option>
                            <option value="private" ${createPrivacy === 'private' ? 'selected' : ''}>Private guild</option>
                        </select>
                    </div>
                </div>
                <div class="guild-subview ${guildNoGuildView === 'join' ? '' : 'hidden'}">
                    <div class="guild-subview-head">
                        <div>
                            <div class="guild-section-title">Join Guild</div>
                            <div class="guild-panel-note">Enter a guild code or look through guilds that match your style.</div>
                        </div>
                        <button type="button" id="btn-guild-back-home-join" class="menu-btn secondary-btn guild-inline-btn">Back</button>
                    </div>
                    <div class="guild-form-grid guild-form-grid--join">
                        <input type="text" id="guild-join-code" class="social-input" maxlength="8" placeholder="Guild code" value="${joinCode}">
                        <button type="button" id="btn-guild-join" class="action-btn social-add-btn guild-inline-btn">Join</button>
                    </div>
                    <div class="guild-directory-shell">
                        <div class="guild-section-title">Guild Directory</div>
                        <div class="guild-directory-toolbar">
                            <input type="text" id="guild-directory-search" class="social-input" maxlength="48" placeholder="Search guilds, tags, leaders..." value="${browserQuery}">
                            <label class="guild-directory-toggle">
                                <input type="checkbox" id="guild-directory-recruiting-only" ${guildDirectoryFilters.recruitingOnly ? 'checked' : ''}>
                                <span>Recruiting only</span>
                            </label>
                            <select id="guild-directory-sort" class="social-input">
                                <option value="fit" ${guildDirectoryFilters.sort === 'fit' ? 'selected' : ''}>Best fit</option>
                                <option value="members" ${guildDirectoryFilters.sort === 'members' ? 'selected' : ''}>Most members</option>
                                <option value="xp" ${guildDirectoryFilters.sort === 'xp' ? 'selected' : ''}>Most guild XP</option>
                                <option value="newest" ${guildDirectoryFilters.sort === 'newest' ? 'selected' : ''}>Newest</option>
                            </select>
                        </div>
                        ${browserEntries.length ? browserEntries.map((entry) => `
                            <div class="guild-directory-card">
                                <div class="guild-directory-head">
                                    <div>
                                        <div class="guild-name-line">
                                            <span class="guild-tag-badge">${entry.tag}</span>
                                            <span class="guild-name-title">${entry.name}</span>
                                        </div>
                                        <div class="guild-directory-meta">Guild Lv. ${entry.level || 1} · ${entry.memberCount || 0}/${entry.memberCap || 50} members · Leader ${entry.leaderName || 'Unknown'}</div>
                                    </div>
                                    <div class="guild-crest">${guildIconCrest(entry.icon)}</div>
                                </div>
                                <div class="guild-directory-meta">${entry.description || 'No description yet.'}</div>
                                <div class="guild-directory-pills">
                                    <span class="guild-pill guild-pill--status guild-pill--${(entry.recruitment && entry.recruitment.status) || 'recruiting'}">${guildRecruitmentLabel(entry.recruitment && entry.recruitment.status)}</span>
                                    <span class="guild-pill">${guildRecruitmentFocusLabel(entry.recruitment && entry.recruitment.focus)}</span>
                                    <span class="guild-pill">${guildRecruitmentPlaystyleLabel(entry.recruitment && entry.recruitment.playstyle)}</span>
                                </div>
                                ${entry.recruitment && entry.recruitment.message ? `<div class="guild-directory-recruitment">${entry.recruitment.message}</div>` : ''}
                                ${entry.bulletin && entry.bulletin.message ? `<div class="guild-directory-bulletin">Guild bulletin: ${entry.bulletin.message}</div>` : ''}
                                <div class="guild-directory-actions">
                                    ${((entry.recruitment && entry.recruitment.status) === 'closed'
                                        ? `<span class="guild-directory-status guild-directory-status--muted">Recruitment Closed</span>`
                                        : (entry.recruitment && entry.recruitment.status) === 'invite_only'
                                            ? `<span class="guild-directory-status guild-directory-status--muted">Invite Only</span>`
                                            : `<button type="button" class="action-btn social-add-btn guild-inline-btn" onclick="joinGuildByCode('${entry.joinCode}', true)">Join ${entry.tag}</button>`)}
                                </div>
                            </div>
                        `).join('') : '<div class="guild-directory-empty">No guilds match those filters right now.</div>'}
                    </div>
                </div>
            </div>
        `;
        document.getElementById('btn-guild-open-create')?.addEventListener('click', () => setGuildNoGuildView('create'));
        document.getElementById('btn-guild-open-join')?.addEventListener('click', () => setGuildNoGuildView('join'));
        document.getElementById('btn-guild-back-home-create')?.addEventListener('click', () => setGuildNoGuildView('home'));
        document.getElementById('btn-guild-back-home-join')?.addEventListener('click', () => setGuildNoGuildView('home'));
        document.getElementById('btn-guild-create')?.addEventListener('click', createGuild);
        document.getElementById('btn-guild-join')?.addEventListener('click', joinGuild);
        document.getElementById('guild-directory-search')?.addEventListener('input', (e) => {
            captureGuildFocusState();
            captureGuildScrollState();
            guildDirectoryFilters.query = e.target.value || '';
            renderGuildPanel(null);
            restoreGuildViewStateDeferred();
        });
        document.getElementById('guild-directory-recruiting-only')?.addEventListener('change', (e) => {
            captureGuildFocusState();
            captureGuildScrollState();
            guildDirectoryFilters.recruitingOnly = !!e.target.checked;
            renderGuildPanel(null);
            restoreGuildViewStateDeferred();
        });
        document.getElementById('guild-directory-sort')?.addEventListener('change', (e) => {
            captureGuildFocusState();
            captureGuildScrollState();
            guildDirectoryFilters.sort = e.target.value || 'fit';
            renderGuildPanel(null);
            restoreGuildViewStateDeferred();
        });
        return;
    }

    if (!guild) {
        count.innerText = 'Solo';
        panel.innerHTML = `
            <div class="guild-shell">
                <div class="guild-panel-note">Build a guild identity, browse public guilds, or join an invite code from your squad leader.</div>
                <div class="guild-form-grid">
                    <input type="text" id="guild-create-name" class="social-input" maxlength="32" placeholder="Guild name" value="${createName}">
                    <input type="text" id="guild-create-tag" class="social-input" maxlength="5" placeholder="Tag" value="${createTag}">
                    <button type="button" id="btn-guild-create" class="action-btn social-add-btn guild-inline-btn">Create</button>
                </div>
                <textarea id="guild-create-description" class="social-input" maxlength="180" placeholder="Guild description" style="min-height:84px; resize:vertical;">${createDescription}</textarea>
                <div class="guild-admin-grid">
                    <select id="guild-create-icon" class="social-input">${guildVisualSelectOptions(GUILD_ICON_PRESETS, createIcon)}</select>
                    <select id="guild-create-banner" class="social-input">${guildVisualSelectOptions(GUILD_BANNER_PRESETS, createBanner)}</select>
                    <select id="guild-create-privacy" class="social-input">
                        <option value="public" ${createPrivacy === 'public' ? 'selected' : ''}>Public guild</option>
                        <option value="private" ${createPrivacy === 'private' ? 'selected' : ''}>Private guild</option>
                    </select>
                </div>
                <div class="guild-form-grid guild-form-grid--join">
                    <input type="text" id="guild-join-code" class="social-input" maxlength="8" placeholder="Guild code" value="${joinCode}">
                    <button type="button" id="btn-guild-join" class="action-btn social-add-btn guild-inline-btn">Join</button>
                </div>
                <div class="guild-directory-shell">
                    <div class="guild-section-title">Guild Directory</div>
                    <div class="guild-directory-toolbar">
                        <input type="text" id="guild-directory-search" class="social-input" maxlength="48" placeholder="Search guilds, tags, leaders..." value="${browserQuery}">
                        <label class="guild-directory-toggle">
                            <input type="checkbox" id="guild-directory-recruiting-only" ${guildDirectoryFilters.recruitingOnly ? 'checked' : ''}>
                            <span>Recruiting only</span>
                        </label>
                        <select id="guild-directory-sort" class="social-input">
                            <option value="fit" ${guildDirectoryFilters.sort === 'fit' ? 'selected' : ''}>Best fit</option>
                            <option value="members" ${guildDirectoryFilters.sort === 'members' ? 'selected' : ''}>Most members</option>
                            <option value="xp" ${guildDirectoryFilters.sort === 'xp' ? 'selected' : ''}>Most guild XP</option>
                            <option value="newest" ${guildDirectoryFilters.sort === 'newest' ? 'selected' : ''}>Newest</option>
                        </select>
                    </div>
                    ${browserEntries.length ? browserEntries.map((entry) => `
                        <div class="guild-directory-card">
                            <div class="guild-directory-head">
                                <div>
                                    <div class="guild-name-line">
                                        <span class="guild-tag-badge">${entry.tag}</span>
                                        <span class="guild-name-title">${entry.name}</span>
                                    </div>
                                    <div class="guild-directory-meta">Guild Lv. ${entry.level || 1} · ${entry.memberCount || 0}/${entry.memberCap || 50} members · Leader ${entry.leaderName || 'Unknown'}</div>
                                </div>
                                <div class="guild-crest">${guildIconCrest(entry.icon)}</div>
                            </div>
                            <div class="guild-directory-meta">${entry.description || 'No description yet.'}</div>
                            <div class="guild-directory-pills">
                                <span class="guild-pill guild-pill--status guild-pill--${(entry.recruitment && entry.recruitment.status) || 'recruiting'}">${guildRecruitmentLabel(entry.recruitment && entry.recruitment.status)}</span>
                                <span class="guild-pill">${guildRecruitmentFocusLabel(entry.recruitment && entry.recruitment.focus)}</span>
                                <span class="guild-pill">${guildRecruitmentPlaystyleLabel(entry.recruitment && entry.recruitment.playstyle)}</span>
                            </div>
                            ${entry.recruitment && entry.recruitment.message ? `<div class="guild-directory-recruitment">${entry.recruitment.message}</div>` : ''}
                            ${entry.bulletin && entry.bulletin.message ? `<div class="guild-directory-bulletin">Guild bulletin: ${entry.bulletin.message}</div>` : ''}
                            <div class="guild-directory-actions">
                                ${entry.id && entry.id === currentGuildId
                                    ? `<span class="guild-directory-status">Current Guild</span>`
                                    : ((entry.recruitment && entry.recruitment.status) === 'closed'
                                        ? `<span class="guild-directory-status guild-directory-status--muted">Recruitment Closed</span>`
                                        : (entry.recruitment && entry.recruitment.status) === 'invite_only'
                                            ? `<span class="guild-directory-status guild-directory-status--muted">Invite Only</span>`
                                            : `<button type="button" class="action-btn social-add-btn guild-inline-btn" onclick="joinGuildByCode('${entry.joinCode}', true)">Join ${entry.tag}</button>`)}
                            </div>
                        </div>
                    `).join('') : '<div class="guild-directory-empty">No guilds match those filters right now.</div>'}
                </div>
            </div>
        `;
        document.getElementById('btn-guild-create')?.addEventListener('click', createGuild);
        document.getElementById('btn-guild-join')?.addEventListener('click', joinGuild);
        document.getElementById('guild-directory-search')?.addEventListener('input', (e) => {
            captureGuildFocusState();
            guildDirectoryFilters.query = e.target.value || '';
            renderGuildPanel(null);
            restoreGuildFocusState();
        });
        document.getElementById('guild-directory-recruiting-only')?.addEventListener('change', (e) => {
            captureGuildFocusState();
            guildDirectoryFilters.recruitingOnly = !!e.target.checked;
            renderGuildPanel(null);
            restoreGuildFocusState();
        });
        document.getElementById('guild-directory-sort')?.addEventListener('change', (e) => {
            captureGuildFocusState();
            guildDirectoryFilters.sort = e.target.value || 'fit';
            renderGuildPanel(null);
            restoreGuildFocusState();
        });
        return;
    }

    const recruitment = guild.recruitment || {};
    const members = (guild.members || []).slice().sort((a, b) => {
        const roleScore = (m) => (m.role === 'Leader' ? 1 : 0);
        return roleScore(b) - roleScore(a) || (b.contributedXp || 0) - (a.contributedXp || 0);
    });
    const leader = members.find((member) => member.role === 'Leader');
    const foundedLabel = guild.createdAt ? new Date(guild.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
    const topContributor = guild.topContributor ? `${guild.topContributor.username} (${guild.topContributor.contributedXp || 0} XP)` : 'No data yet';
    const progressPct = Math.max(0, Math.min(100, Number(guild.levelProgressPct) || 0));
    const progressLabel = `${guild.xpIntoLevel || 0} / ${Math.max(1, (guild.nextLevelXp || 0) - (guild.levelFloorXp || 0))} XP`;
    const myMember = members.find((member) => member.uid === localUid);
    const canManageGuild = !!(myMember && (myMember.role === 'Leader' || myMember.role === 'Officer'));
    const canManageRoles = !!(myMember && myMember.role === 'Leader');
    const canManageRecruitment = !!(myMember && (myMember.role === 'Leader' || myMember.role === 'Recruiter'));
    const adminDescription = escapeGuildFieldValue(adminDraftMatchesGuild ? guildDraftState.adminDescription : (guild.description || ''));
    const adminIcon = adminDraftMatchesGuild ? guildDraftState.adminIcon : (guild.icon || 'comet');
    const adminBanner = adminDraftMatchesGuild ? guildDraftState.adminBanner : (guild.banner || 'aurora');
    const adminPrivacy = adminDraftMatchesGuild ? guildDraftState.adminPrivacy : (guild.isPublic ? 'public' : 'private');
    const adminRecruitmentStatus = adminDraftMatchesGuild ? guildDraftState.adminRecruitmentStatus : (recruitment.status || (guild.isPublic ? 'recruiting' : 'invite_only'));
    const adminRecruitmentMessage = escapeGuildFieldValue(adminDraftMatchesGuild ? guildDraftState.adminRecruitmentMessage : (recruitment.message || ''));
    const adminRecruitmentFocus = adminDraftMatchesGuild ? guildDraftState.adminRecruitmentFocus : (recruitment.focus || 'all_modes');
    const adminRecruitmentPlaystyle = adminDraftMatchesGuild ? guildDraftState.adminRecruitmentPlaystyle : (recruitment.playstyle || 'mixed');
    const adminBulletinMessage = escapeGuildFieldValue(adminDraftMatchesGuild ? guildDraftState.adminBulletinMessage : ((guild.bulletin && guild.bulletin.message) || ''));
    const chatInputValue = escapeGuildFieldValue(chatDraftMatchesGuild ? guildDraftState.chatInput : '');
    const chatRows = (guild.chat || []).slice(-20).map((msg) => {
        const when = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="guild-chat-row">
                <div class="guild-chat-head">
                    <span class="guild-chat-user">${msg.username}</span>
                    <span class="guild-chat-time">${when}</span>
                </div>
                <div class="guild-chat-msg">${msg.message}</div>
            </div>
        `;
    }).join('');
    count.innerText = `${guild.memberCount || members.length}/${guild.memberCap || 50}`;
    panel.innerHTML = `
        <div class="guild-shell">
            <div class="${guildBannerClass(guild.banner)}">
                <div class="guild-hero-top">
                    <div class="guild-crest">${guildIconCrest(guild.icon)}</div>
                    <div class="guild-hero-copy">
                        <div class="guild-identity">
                            <div>
                                <div class="guild-name-line">
                                    <span class="guild-tag-badge">${guild.tag}</span>
                                    <span class="guild-name-title">${guild.name}</span>
                                </div>
                                <div class="guild-meta-line">Guild Lv. ${guild.level || 1} · ${(guild.xp || 0)} XP · ${guild.isPublic ? 'Public guild' : 'Private guild'} · Join code <span class="guild-code">${guild.joinCode}</span></div>
                                <div class="guild-directory-pills" style="margin-top:10px">
                                    <span class="guild-pill guild-pill--status guild-pill--${recruitment.status || 'recruiting'}">${guildRecruitmentLabel(recruitment.status)}</span>
                                    <span class="guild-pill">${guildRecruitmentFocusLabel(recruitment.focus)}</span>
                                    <span class="guild-pill">${guildRecruitmentPlaystyleLabel(recruitment.playstyle)}</span>
                                </div>
                            </div>
                            <button type="button" id="btn-guild-leave" class="menu-btn secondary-btn guild-inline-btn">Leave</button>
                        </div>
                        <div class="guild-hero-description">${guild.description || 'No guild description set yet.'}</div>
                        ${recruitment.message ? `<div class="guild-recruitment-banner">${recruitment.message}</div>` : ''}
                        ${guild.bulletin && guild.bulletin.message ? `<div class="guild-bulletin-card"><strong>Guild Bulletin</strong><span>${guild.bulletin.message}</span></div>` : ''}
                    </div>
                </div>
            </div>
            <div class="guild-summary-grid">
                <div class="guild-summary-card"><div class="guild-summary-label">Leader</div><div class="guild-summary-value">${guild.leaderName || (leader ? leader.username : 'Unknown')}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Members</div><div class="guild-summary-value">${guild.memberCount || members.length}/${guild.memberCap || 50}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Guild XP</div><div class="guild-summary-value">${guild.xp || 0}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Founded</div><div class="guild-summary-value">${foundedLabel}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Top Contributor</div><div class="guild-summary-value">${topContributor}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Total Member XP</div><div class="guild-summary-value">${guild.totalContributionXp || 0}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Join Code</div><div class="guild-summary-value">${guild.joinCode}</div></div>
                <div class="guild-summary-card"><div class="guild-summary-label">Next Level</div><div class="guild-summary-value">${guild.xpNeededForNextLevel || 0} XP away</div></div>
            </div>
            <div class="guild-progress-shell">
                <div class="guild-progress-head">
                    <div class="guild-progress-title">Guild Progress</div>
                    <div class="guild-progress-meta">${progressLabel}</div>
                </div>
                <div class="guild-progress-bar">
                    <div class="guild-progress-fill" style="width:${progressPct}%"></div>
                </div>
            </div>
            ${canManageGuild ? `
                <div class="guild-admin-panel">
                    <div class="guild-section-title">Guild Admin</div>
                    <div class="guild-admin-note">Guild admins can update the description, icon, banner, and privacy. Public guilds appear in the guild directory.</div>
                    <textarea id="guild-admin-description" class="social-input" maxlength="180" placeholder="Guild description" style="min-height:84px; resize:vertical;">${adminDescription}</textarea>
                    <div class="guild-admin-grid">
                        <select id="guild-admin-icon" class="social-input">${guildVisualSelectOptions(GUILD_ICON_PRESETS, adminIcon)}</select>
                        <select id="guild-admin-banner" class="social-input">${guildVisualSelectOptions(GUILD_BANNER_PRESETS, adminBanner)}</select>
                        <select id="guild-admin-privacy" class="social-input">
                            <option value="public" ${adminPrivacy === 'public' ? 'selected' : ''}>Public guild</option>
                            <option value="private" ${adminPrivacy === 'private' ? 'selected' : ''}>Private guild</option>
                        </select>
                        <button type="button" id="btn-guild-save-settings" class="action-btn social-add-btn guild-inline-btn">Save Settings</button>
                    </div>
                </div>
            ` : ''}
            ${canManageRecruitment ? `
                <div class="guild-admin-panel">
                    <div class="guild-section-title">Recruitment Studio</div>
                    <div class="guild-admin-note">Leaders and approved recruiters can publish the guild's browser pitch and keep a short bulletin up to date for members and recruits.</div>
                    <textarea id="guild-admin-recruitment-message" class="social-input" maxlength="200" placeholder="What kind of players are you looking for?" style="min-height:84px; resize:vertical;">${adminRecruitmentMessage}</textarea>
                    <div class="guild-admin-grid">
                        <select id="guild-admin-recruitment-status" class="social-input">
                            <option value="recruiting" ${adminRecruitmentStatus === 'recruiting' ? 'selected' : ''}>Recruiting</option>
                            <option value="invite_only" ${adminRecruitmentStatus === 'invite_only' ? 'selected' : ''}>Invite only</option>
                            <option value="closed" ${adminRecruitmentStatus === 'closed' ? 'selected' : ''}>Closed</option>
                        </select>
                        <select id="guild-admin-recruitment-focus" class="social-input">
                            <option value="all_modes" ${adminRecruitmentFocus === 'all_modes' ? 'selected' : ''}>All modes</option>
                            <option value="duels" ${adminRecruitmentFocus === 'duels' ? 'selected' : ''}>1v1 focus</option>
                            <option value="squads" ${adminRecruitmentFocus === 'squads' ? 'selected' : ''}>2v2 focus</option>
                        </select>
                        <select id="guild-admin-recruitment-playstyle" class="social-input">
                            <option value="mixed" ${adminRecruitmentPlaystyle === 'mixed' ? 'selected' : ''}>Mixed</option>
                            <option value="casual" ${adminRecruitmentPlaystyle === 'casual' ? 'selected' : ''}>Casual</option>
                            <option value="competitive" ${adminRecruitmentPlaystyle === 'competitive' ? 'selected' : ''}>Competitive</option>
                        </select>
                    </div>
                    <textarea id="guild-admin-bulletin-message" class="social-input" maxlength="160" placeholder="Guild bulletin for members and visitors" style="min-height:68px; resize:vertical;">${adminBulletinMessage}</textarea>
                    <button type="button" id="btn-guild-save-recruitment" class="action-btn social-add-btn guild-inline-btn">Publish Recruitment</button>
                </div>
            ` : ''}
            <div class="guild-section-title">Roster</div>
            <div class="guild-members">
                ${members.map((m) => `
                    <div class="guild-member-row">
                        <div class="guild-member-main">
                            <div class="guild-member-name">${m.username}</div>
                            <div class="guild-member-role">${m.role || 'Member'}</div>
                            <div class="guild-member-meta">Joined ${new Date(m.joinedAt || Date.now()).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                            <div class="guild-member-xp">${m.contributedXp || 0} XP</div>
                            ${canManageRoles && m.uid !== localUid ? `
                                <button type="button" class="menu-btn secondary-btn guild-inline-btn" onclick="setGuildMemberRole('${m.uid}', 'Officer')">Officer</button>
                                <button type="button" class="menu-btn secondary-btn guild-inline-btn" onclick="setGuildMemberRole('${m.uid}', 'Recruiter')">Recruiter</button>
                                <button type="button" class="menu-btn secondary-btn guild-inline-btn" onclick="setGuildMemberRole('${m.uid}', 'Member')">Member</button>
                            ` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="guild-chat-shell">
                <div class="guild-section-title">Guild Chat</div>
                <div id="guild-chat-list" class="guild-chat-list">${chatRows || '<div class="guild-chat-empty">No guild chatter yet. Break the silence.</div>'}</div>
                <div class="guild-chat-compose">
                    <input type="text" id="guild-chat-input" class="social-input" maxlength="160" placeholder="Message your guild" value="${chatInputValue}">
                    <button type="button" id="btn-guild-chat-send" class="action-btn social-add-btn guild-inline-btn">Send</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('btn-guild-leave')?.addEventListener('click', leaveGuild);
    document.getElementById('btn-guild-save-settings')?.addEventListener('click', saveGuildSettings);
    document.getElementById('btn-guild-save-recruitment')?.addEventListener('click', saveGuildSettings);
    document.getElementById('btn-guild-chat-send')?.addEventListener('click', sendGuildChat);
    document.getElementById('guild-chat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendGuildChat();
        }
    });
}

function guildRenderSignature(guild) {
    if (!guild) return 'noguild';
    return JSON.stringify({
        id: guild.id || null,
        name: guild.name || '',
        tag: guild.tag || '',
        description: guild.description || '',
        level: guild.level || 1,
        xp: guild.xp || 0,
        memberCount: guild.memberCount || 0,
        memberCap: guild.memberCap || 0,
        leaderName: guild.leaderName || '',
        isPublic: !!guild.isPublic,
        icon: guild.icon || '',
        banner: guild.banner || '',
        recruitment: guild.recruitment || null,
        bulletin: guild.bulletin || null,
        members: Array.isArray(guild.members) ? guild.members.map((member) => ({
            uid: member.uid || '',
            username: member.username || '',
            role: member.role || '',
            contributedXp: member.contributedXp || 0,
            joinedAt: member.joinedAt || ''
        })) : [],
        chat: Array.isArray(guild.chat) ? guild.chat.map((entry) => ({
            uid: entry.uid || '',
            username: entry.username || '',
            role: entry.role || '',
            message: entry.message || '',
            createdAt: entry.createdAt || ''
        })) : []
    });
}

function updateSocialUI(data, options = {}) {
    if (!data) return;
    const passiveRefresh = !!options.passiveRefresh;
    captureGuildDraftState();
    captureGuildFocusState();
    captureGuildScrollState();
    const previousGuild = lastSocialSnapshot ? lastSocialSnapshot.guild : null;
    lastSocialSnapshot = data;
    const friends = data.friends || [];
    const requests = data.requests || [];
    const invites = data.invites || [];
    const guild = data.guild || null;
    const isSocialOpen = !document.getElementById('social-container').classList.contains('hidden');
    const shouldFreezeGuildRender = passiveRefresh
        && isSocialOpen
        && activeSocialTab === 'guild';
    if (!guild && getKnownPlayerGuild()) {
        renderSocialGuildPreview(getKnownPlayerGuild());
        if (!shouldFreezeGuildRender) {
            renderGuildPanel(null);
            restoreGuildViewStateDeferred();
        }
        const friendsBadge = document.getElementById('social-tab-friends-badge');
        const guildBadge = document.getElementById('social-tab-guild-badge');
        if (friendsBadge) friendsBadge.innerText = `${friends.length}`;
        if (guildBadge) guildBadge.innerText = `${getKnownPlayerGuild().memberCount || '...'} members`;
        return;
    }
    
    document.getElementById('friends-count').innerText = `${friends.length}/100`;
    renderSocialGuildPreview(guild);
    if (!shouldFreezeGuildRender) {
        renderGuildPanel(guild);
        restoreGuildViewStateDeferred();
    }
    const friendsBadge = document.getElementById('social-tab-friends-badge');
    const guildBadge = document.getElementById('social-tab-guild-badge');
    if (friendsBadge) friendsBadge.innerText = `${friends.length}`;
    if (guildBadge) guildBadge.innerText = guild ? `${guild.memberCount || (guild.members || []).length} members` : 'Solo';

    // Update notification dot (friend requests + invites)
    const dot = document.getElementById('social-dot');
    if (requests.length > 0 || invites.length > 0) dot.classList.remove('hidden');
    else dot.classList.add('hidden');

    refreshMenuActivityBadge(data);

    const duelToast = document.getElementById('menu-duel-invite-toast');
    if (duelToast) {
        if (invites.length > 0) {
            duelToast.classList.remove('hidden');
            const t = duelToast.querySelector('.menu-duel-invite-toast-text');
            if (t) t.textContent = invites.length === 1 ? 'You have a game invite from a friend.' : `You have ${invites.length} game invites.`;
        } else {
            duelToast.classList.add('hidden');
        }
    }

    if (menuActivityPopoverOpen) renderMenuActivityPopoverBody();

    // Only update the list if the container is open
    if (!isSocialOpen) return;
    if (guild && !previousGuild) setActiveSocialTab('guild');

    const list = document.getElementById('friends-list');
    let html = '';

    if (invites.length > 0) {
        html += `<div style="background: rgba(255, 200, 120, 0.08); padding: 10px; font-weight: bold; font-size: 0.9rem; color: #ffcc80; margin-bottom: 5px;">Game Invites (${invites.length})</div>`;
        invites.forEach((d) => {
            if (d.type === 'duel') {
                html += `
                    <div style="padding: 10px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; background: rgba(255, 180, 80, 0.06);">
                        <div>
                            <div style="font-weight: bold; color: #eee;">${d.fromUsername}</div>
                            <div style="font-size: 0.75rem; color: #888;">Private match · code ${d.code}</div>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button onclick="acceptInvite('${d.fromUid}', 'duel')" style="background: #00ffcc; border: none; color: #000; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer; font-weight: bold;">Accept</button>
                            <button onclick="declineInvite('${d.fromUid}', 'duel')" style="background: #444; border: none; color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">Decline</button>
                        </div>
                    </div>
                `;
            } else if (d.type === 'party') {
                html += `
                    <div style="padding: 10px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; background: rgba(200, 100, 255, 0.06);">
                        <div>
                            <div style="font-weight: bold; color: #eee;">${d.fromUsername}</div>
                            <div style="font-size: 0.75rem; color: #888;">Party invite (2v2)</div>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button onclick="acceptInvite('${d.fromUid}', 'party')" style="background: #cc66ff; border: none; color: #000; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer; font-weight: bold;">Accept</button>
                            <button onclick="declineInvite('${d.fromUid}', 'party')" style="background: #444; border: none; color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">Decline</button>
                        </div>
                    </div>
                `;
            } else if (d.type === 'guild') {
                html += `
                    <div style="padding: 10px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; background: rgba(80, 170, 255, 0.07);">
                        <div>
                            <div style="font-weight: bold; color: #eee;">${d.fromUsername}</div>
                            <div style="font-size: 0.75rem; color: #888;">Guild invite · [${d.guildTag || 'TAG'}] ${d.guildName || 'Guild'}</div>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button onclick="acceptInvite('${d.fromUid}', 'guild')" style="background: #7dcfff; border: none; color: #00111f; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer; font-weight: bold;">Join</button>
                            <button onclick="declineInvite('${d.fromUid}', 'guild')" style="background: #444; border: none; color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">Decline</button>
                        </div>
                    </div>
                `;
            }
        });
        html += '<div style="height: 15px;"></div>';
    }

    // Pending Requests Section
    if (requests.length > 0) {
        html += `<div style="background: rgba(255, 255, 255, 0.05); padding: 10px; font-weight: bold; font-size: 0.9rem; color: #00d2ff; margin-bottom: 5px;">Pending Requests (${requests.length})</div>`;
        requests.forEach(r => {
            html += `
                <div style="padding: 10px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; background: rgba(0, 210, 255, 0.05);">
                    <div>
                        <div style="font-weight: bold; color: #eee;">${r.username}</div>
                        <div style="font-size: 0.75rem; color: #888;">Level ${r.level}</div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button onclick="acceptFriend('${r.uid}')" style="background: #00ffcc; border: none; color: #000; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer; font-weight: bold;">Accept</button>
                        <button onclick="declineFriend('${r.uid}')" style="background: #ff4444; border: none; color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">Decline</button>
                    </div>
                </div>
            `;
        });
        html += '<div style="height: 15px;"></div>';
    }

    // Friends Section
    if (friends.length === 0 && requests.length === 0 && invites.length === 0) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No friends yet. Add some to play together!</div>';
        return;
    }

    if (friends.length > 0) {
        html += `<div style="padding: 5px 10px; font-weight: bold; font-size: 0.9rem; opacity: 0.7;">My Friends</div>`;
        friends.forEach(f => {
            const statusColor = f.status === 'Online' ? '#00ffcc' : '#666';
            const presenceLine = f.presenceLabel || (f.status === 'Online' ? 'Online' : 'Offline');
            html += `
                <div style="padding: 12px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
                        <div style="width: 10px; height: 10px; flex-shrink: 0; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 5px ${statusColor};"></div>
                        <div style="min-width: 0;">
                            <div style="font-weight: bold; color: #eee;">${f.username}</div>
                            <div style="font-size: 0.72rem; color: #6a7a9a;">${presenceLine}</div>
                        </div>
                    </div>
                    <div style="display: flex; flex-shrink: 0; flex-wrap: wrap; gap: 6px; justify-content: flex-end;">
                        ${lastSocialSnapshot && lastSocialSnapshot.guild ? `<button type="button" onclick="sendInvite('${f.uid}', 'guild')" style="background: rgba(125, 207, 255, 0.18); border: 1px solid rgba(125, 207, 255, 0.4); color: #bfeaff; border-radius: 4px; padding: 4px 10px; font-size: 0.75rem; cursor: pointer; font-weight: bold;">Guild</button>` : ''}
                        <button type="button" onclick="sendInvite('${f.uid}', 'party')" style="background: rgba(204, 102, 255, 0.2); border: 1px solid rgba(204, 102, 255, 0.45); color: #e6b3ff; border-radius: 4px; padding: 4px 10px; font-size: 0.75rem; cursor: pointer; font-weight: bold;">+ Party</button>
                        <button type="button" onclick="sendInvite('${f.uid}', 'duel')" style="background: rgba(0, 210, 255, 0.2); border: 1px solid rgba(0, 210, 255, 0.45); color: #9ef0ff; border-radius: 4px; padding: 4px 10px; font-size: 0.75rem; cursor: pointer; font-weight: bold;">Challenge</button>
                        <button onclick="removeFriend('${f.uid}')" style="background: none; border: none; color: #ff0055; opacity: 0.5; cursor: pointer; font-size: 0.8rem; padding: 5px;">Remove</button>
                    </div>
                </div>
            `;
        });
    } else if (friends.length === 0 && requests.length > 0) {
        html += '<div style="padding: 20px; text-align: center; color: #666; font-size: 0.9rem;">No active friends yet.</div>';
    }
    list.innerHTML = html;
}

window.sendInvite = async (targetUid, type = 'duel') => {
    try {
        const res = await fetch('/friend-invite-send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, targetUid, type })
        });
        const data = await parseJsonResponse(res);
        if (data.ok && data.roomId) {
            document.getElementById('social-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
            document.getElementById('matchmaking-text').innerText = 'Waiting for friend to join...';
            reportPresenceIfChanged(true);
            connectWebSocket(data.roomId);
            fetchFriends(true);
        } else if (data.ok && data.partyId) {
            connectParty(data.partyId);
        } else {
            alert(data.error || 'Could not send invite');
        }
    } catch (e) {
        alert(e.message || 'Connection error');
    }
};

window.acceptInvite = async (fromUid, type) => {
    try {
        const res = await fetch('/friend-invite-accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, fromUid, type })
        });
        const data = await parseJsonResponse(res);
        if (data.ok && data.type === 'duel' && data.roomId) {
            document.getElementById('social-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
            document.getElementById('matchmaking-text').innerText = 'Joining private match...';
            reportPresenceIfChanged(true);
            connectWebSocket(data.roomId);
            fetchFriends(true);
        } else if (data.ok && data.type === 'party' && data.partyId) {
            connectParty(data.partyId);
        } else if (data.ok && data.type === 'guild' && data.guild) {
            const errorEl = document.getElementById('social-error');
            applyGuildToSocialState(data.guild);
            errorEl.style.color = '#00ffcc';
            errorEl.innerText = `Joined guild: ${data.guild.name}`;
            errorEl.classList.remove('hidden');
            fetchFriends();
            fetchPlayerProfile(true);
        } else {
            alert(data.error || 'Invite is no longer valid');
            fetchFriends();
        }
    } catch (e) {
        alert(e.message || 'Could not accept invite');
        fetchFriends();
    }
};

window.declineInvite = async (fromUid, type) => {
    try {
        await fetch('/friend-invite-decline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, fromUid, type })
        });
        fetchFriends();
    } catch (e) {}
};

window.acceptFriend = async (friendUid) => {
    try {
        const res = await fetch('/accept-friend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, friendUid })
        });
        fetchFriends();
    } catch (e) {}
};

window.declineFriend = async (friendUid) => {
    try {
        await fetch('/decline-friend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, friendUid })
        });
        fetchFriends();
    } catch (e) {}
};

document.getElementById('btn-add-friend').addEventListener('click', async () => {
    const name = document.getElementById('input-friend-name').value.trim();
    if (!name) return;
    
    const errorEl = document.getElementById('social-error');
    errorEl.classList.add('hidden');
    errorEl.style.color = '#ff4444';

    try {
        const res = await fetch('/add-friend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, friendName: name })
        });
        const data = await res.json();
        if (data.ok) {
            document.getElementById('input-friend-name').value = '';
            errorEl.innerText = 'Request sent!';
            errorEl.style.color = '#00ffcc';
            errorEl.classList.remove('hidden');
            setTimeout(() => errorEl.classList.add('hidden'), 3000);
            fetchFriends();
        } else {
            errorEl.innerText = data.error || 'Failed to add friend';
            errorEl.classList.remove('hidden');
        }
    } catch (e) {
        errorEl.innerText = 'Connection error';
        errorEl.classList.remove('hidden');
    }
});

document.getElementById('btn-profile-leave-guild')?.addEventListener('click', leaveGuild);

window.removeFriend = async (friendUid) => {
    if (!confirm('Are you sure you want to remove this friend?')) return;
    try {
        await fetch('/remove-friend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, friendUid })
        });
        fetchFriends();
    } catch (e) {}
};

async function createGuild() {
    const errorEl = document.getElementById('social-error');
    const name = document.getElementById('guild-create-name')?.value?.trim() || '';
    const tag = document.getElementById('guild-create-tag')?.value?.trim() || '';
    const description = document.getElementById('guild-create-description')?.value?.trim() || '';
    const icon = document.getElementById('guild-create-icon')?.value || 'comet';
    const banner = document.getElementById('guild-create-banner')?.value || 'aurora';
    const isPublic = (document.getElementById('guild-create-privacy')?.value || 'public') === 'public';
    errorEl.classList.add('hidden');
    try {
        const res = await fetch('/guild/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, name, tag, description, icon, banner, isPublic })
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not create guild');
        applyGuildToSocialState(data.guild);
        errorEl.style.color = '#00ffcc';
        errorEl.innerText = `Guild created: ${data.guild.name}`;
        errorEl.classList.remove('hidden');
        fetchFriends();
        fetchPlayerProfile(true);
    } catch (e) {
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not create guild';
        errorEl.classList.remove('hidden');
    }
}

async function joinGuild() {
    const errorEl = document.getElementById('social-error');
    const code = document.getElementById('guild-join-code')?.value?.trim() || '';
    errorEl.classList.add('hidden');
    try {
        const res = await fetch('/guild/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, code })
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not join guild');
        applyGuildToSocialState(data.guild);
        errorEl.style.color = '#00ffcc';
        errorEl.innerText = `Joined guild: ${data.guild.name}`;
        errorEl.classList.remove('hidden');
        fetchFriends();
        fetchPlayerProfile(true);
    } catch (e) {
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not join guild';
        errorEl.classList.remove('hidden');
    }
}

async function leaveGuild() {
    const guild = lastSocialSnapshot && lastSocialSnapshot.guild ? lastSocialSnapshot.guild : null;
    const isLastMember = guild && Number(guild.memberCount || 0) <= 1;
    const confirmMessage = isLastMember
        ? 'Leave your current guild? You are the last member, so the guild will be permanently disbanded.'
        : 'Leave your current guild? If you are the last member, the guild will be disbanded.';
    if (!confirm(confirmMessage)) return;
    const errorEl = document.getElementById('social-error');
    errorEl.classList.add('hidden');
    try {
        const res = await fetch('/guild/leave', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid })
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not leave guild');
        errorEl.style.color = '#00ffcc';
        errorEl.innerText = data.disbanded ? 'You left the guild. Since no members remained, the guild was disbanded.' : 'You left the guild.';
        errorEl.classList.remove('hidden');
        applyGuildToSocialState(null, { preferTab: 'guild' });
        fetchFriends();
        fetchPlayerProfile(true);
    } catch (e) {
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not leave guild';
        errorEl.classList.remove('hidden');
    }
}

async function sendGuildChat() {
    const input = document.getElementById('guild-chat-input');
    const errorEl = document.getElementById('social-error');
    const message = input?.value?.trim() || '';
    if (!message) return;
    errorEl.classList.add('hidden');
    try {
        const res = await fetch('/guild/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, message })
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not send message');
        if (input) input.value = '';
        if (data.guild) applyGuildToSocialState(data.guild);
        fetchFriends(true);
    } catch (e) {
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not send guild message';
        errorEl.classList.remove('hidden');
    }
}

window.joinGuildByCode = async (code, allowPrivateJoin = false) => {
    const joinInput = document.getElementById('guild-join-code');
    if (joinInput) joinInput.value = code;
    try {
        const res = await fetch('/guild/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, code, allowPrivateJoin })
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not join guild');
        const errorEl = document.getElementById('social-error');
        applyGuildToSocialState(data.guild);
        errorEl.style.color = '#00ffcc';
        errorEl.innerText = `Joined guild: ${data.guild.name}`;
        errorEl.classList.remove('hidden');
        fetchFriends();
        fetchPlayerProfile(true);
    } catch (e) {
        const errorEl = document.getElementById('social-error');
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not join guild';
        errorEl.classList.remove('hidden');
    }
};

async function saveGuildSettings() {
    const errorEl = document.getElementById('social-error');
    errorEl.classList.add('hidden');
    try {
        const payload = { uid: localUid };
        const adminDescriptionEl = document.getElementById('guild-admin-description');
        const adminIconEl = document.getElementById('guild-admin-icon');
        const adminBannerEl = document.getElementById('guild-admin-banner');
        const adminPrivacyEl = document.getElementById('guild-admin-privacy');
        if (adminDescriptionEl) payload.description = adminDescriptionEl.value.trim();
        if (adminIconEl) payload.icon = adminIconEl.value || 'comet';
        if (adminBannerEl) payload.banner = adminBannerEl.value || 'aurora';
        if (adminPrivacyEl) payload.isPublic = (adminPrivacyEl.value || 'public') === 'public';
        const recruitmentStatusEl = document.getElementById('guild-admin-recruitment-status');
        const recruitmentMessageEl = document.getElementById('guild-admin-recruitment-message');
        const recruitmentFocusEl = document.getElementById('guild-admin-recruitment-focus');
        const recruitmentPlaystyleEl = document.getElementById('guild-admin-recruitment-playstyle');
        const bulletinEl = document.getElementById('guild-admin-bulletin-message');
        if (recruitmentStatusEl) payload.recruitmentStatus = recruitmentStatusEl.value || 'recruiting';
        if (recruitmentMessageEl) payload.recruitmentMessage = recruitmentMessageEl.value.trim();
        if (recruitmentFocusEl) payload.recruitmentFocus = recruitmentFocusEl.value || 'all_modes';
        if (recruitmentPlaystyleEl) payload.recruitmentPlaystyle = recruitmentPlaystyleEl.value || 'mixed';
        if (bulletinEl) payload.bulletinMessage = bulletinEl.value.trim();
        const res = await fetch('/guild/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not save guild settings');
        applyGuildToSocialState(data.guild);
        errorEl.style.color = '#00ffcc';
        errorEl.innerText = 'Guild settings updated.';
        errorEl.classList.remove('hidden');
        fetchFriends(true);
        fetchGuildDirectory(true);
        fetchPlayerProfile(true);
    } catch (e) {
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not save guild settings';
        errorEl.classList.remove('hidden');
    }
}

window.setGuildMemberRole = async (targetUid, role) => {
    const errorEl = document.getElementById('social-error');
    errorEl.classList.add('hidden');
    try {
        const res = await fetch('/guild/member-role', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, targetUid, role })
        });
        const data = await parseJsonResponse(res);
        if (!data.ok) throw new Error(data.error || 'Could not update guild member role');
        applyGuildToSocialState(data.guild);
        errorEl.style.color = '#00ffcc';
        errorEl.innerText = 'Guild roster updated.';
        errorEl.classList.remove('hidden');
        fetchFriends(true);
    } catch (e) {
        errorEl.style.color = '#ff4444';
        errorEl.innerText = e.message || 'Could not update guild member role';
        errorEl.classList.remove('hidden');
    }
};

document.querySelectorAll('[data-social-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
        setActiveSocialTab(btn.dataset.socialTab);
    });
});

setActiveSocialTab('friends');

// Private Match UI
document.getElementById('btn-close-private').addEventListener('click', () => {
    const choiceView = document.getElementById('private-choice-view');
    if (choiceView.classList.contains('hidden')) {
        // Go back to choice sub-view
        document.getElementById('private-host-view').classList.add('hidden');
        document.getElementById('private-join-view').classList.add('hidden');
        choiceView.classList.remove('hidden');
    } else {
        // Close entire modal and go back to play mode selection
        document.getElementById('private-match-container').classList.add('hidden');
        document.getElementById('play-mode-modal').classList.remove('hidden');
        reportPresenceIfChanged(true);
    }
});

document.getElementById('btn-host-choice').addEventListener('click', async () => {
    const btn = document.getElementById('btn-host-choice');
    btn.disabled = true;
    btn.innerText = 'Initializing Room...';
    
    try {
        const res = await fetch('/create-private');
        const data = await res.json();
        if (data.roomId && data.code) {
            document.getElementById('private-room-code').innerText = data.code;
            
            // Switch views
            document.getElementById('private-choice-view').classList.add('hidden');
            document.getElementById('private-host-view').classList.remove('hidden');
            
            // Host joins the room automatically
            reportPresenceIfChanged(true);
            connectWebSocket(data.roomId);
        }
    } catch (e) {
        alert('Failed to create private match');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Host New Match';
    }
});

document.getElementById('btn-join-choice').addEventListener('click', () => {
    document.getElementById('private-choice-view').classList.add('hidden');
    document.getElementById('private-join-view').classList.remove('hidden');
    document.getElementById('input-private-code').focus();
});

document.getElementById('btn-submit-join').addEventListener('click', async () => {
    const code = document.getElementById('input-private-code').value.trim();
    if (code.length < 6) return;
    
    document.getElementById('btn-submit-join').disabled = true;
    document.getElementById('btn-submit-join').innerText = 'Validating...';
    
    try {
        const res = await fetch(`/join-private?code=${code}`);
        const data = await res.json();
        if (data.ok && data.roomId) {
            // Instant feedback: Hide the private menu and show the matchmaking overlay
            document.getElementById('private-match-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
            document.getElementById('matchmaking-text').innerText = "Joining Battle...";
            reportPresenceIfChanged(true);
            // Join matched room
            connectWebSocket(data.roomId);
        } else {
            alert(data.error || 'Invalid code');
        }
    } catch (e) {
        alert('Connection error');
    } finally {
        document.getElementById('btn-submit-join').disabled = false;
        document.getElementById('btn-submit-join').innerText = 'Join Battle';
    }
});

// ==========================================
// PARTY MATCH LOGIC
// ==========================================
let partySocket = null;
let currentPartyData = null;

function connectParty(partyId) {
    if (partySocket) partySocket.close();
    
    document.getElementById('social-container').classList.add('hidden');
    document.getElementById('play-mode-modal').classList.add('hidden');
    document.getElementById('party-lobby-container').classList.remove('hidden');
    
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const encodedUser = encodeURIComponent(myUsername);
    partySocket = new WebSocket(`${wsProto}//${location.host}/join-party?partyId=${partyId}&uid=${localUid}&username=${encodedUser}`);
    
    partySocket.onopen = () => {
        console.log("Party WS Connected");
    };
    partySocket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state' || msg.type === 'PARTY_STATE') {
            currentPartyData = msg.state;
            renderPartyUI();
        } else if (msg.type === 'error') {
            alert(msg.message || msg.error || 'Party error');
        } else if (msg.type === 'match_found' || msg.type === 'MATCH_FOUND') {
            partySocket.close();
            partySocket = null;
            document.getElementById('party-lobby-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
            document.getElementById('matchmaking-text').innerText = "Joining 2v2 Match...";
            // Use same GameRoom WS flow for the 2v2
            connectWebSocket(msg.roomId, '2v2');
        }
    };
    partySocket.onclose = () => {
        if (document.getElementById('party-lobby-container').classList.contains('hidden')) return;
        document.getElementById('party-lobby-container').classList.add('hidden');
        document.getElementById('main-menu-container').classList.remove('hidden');
        currentPartyData = null;
        lastPartyReadyCount = 0;
    };
}

function renderPartyUI() {
    if (!currentPartyData) return;
    const grid = document.getElementById('party-members-list');
    grid.innerHTML = '';
    
    const members = currentPartyData.members || [];
    const leaderUid = currentPartyData.leader || currentPartyData.leaderUid;
    const readyCount = members.filter(m => m.isReady).length;
    if (readyCount > lastPartyReadyCount && typeof sfx !== 'undefined' && typeof sfx.playLevelUp === 'function') {
        sfx.playLevelUp();
    }
    lastPartyReadyCount = readyCount;
    members.forEach(m => {
        const isLeader = m.uid === leaderUid;
        const isReady = !!m.isReady;
        const isMe = m.uid === localUid;
        const badges = [
            isLeader ? '<span class="party-member-badge party-member-badge--leader">Leader</span>' : '',
            isReady ? '<span class="party-member-badge party-member-badge--ready">Ready</span>' : '',
            isMe ? '<span class="party-member-badge party-member-badge--you">You</span>' : ''
        ].filter(Boolean).join('');
        grid.innerHTML += `
            <div class="party-member-card ${isLeader ? 'leader' : ''} ${isReady ? 'ready party-member-card--pulse' : ''}">
                ${isLeader ? '<div class="party-member-leader-crown">👑</div>' : ''}
                <div class="party-member-badges">${badges}</div>
                <div class="party-member-name">${m.username}</div>
                <div class="party-member-status">${isReady ? 'Ready to queue' : 'Waiting to ready up'}</div>
            </div>
        `;
    });
    
    // Pad with empty cards
    for (let i = members.length; i < 4; i++) {
        grid.innerHTML += `
            <div class="party-member-card" style="opacity: 0.5; border-style: dashed;">
                <div class="party-member-name">Empty</div>
                <div class="party-member-status">Waiting...</div>
            </div>
        `;
    }
    
    const isMeLeader = localUid === leaderUid;
    const myMemberInfo = members.find(m => m.uid === localUid);
    const amIReady = myMemberInfo ? myMemberInfo.isReady : false;
    
    const btnReady = document.getElementById('btn-party-ready');
    const btnFindMatch = document.getElementById('btn-party-find-match');
    const statusText = document.getElementById('party-status-text');
    
    btnReady.innerText = amIReady ? 'Unready' : 'Ready up!';
    
    if (isMeLeader) {
        btnFindMatch.classList.remove('hidden');
        const allReady = members.every(m => m.isReady);
        btnFindMatch.disabled = !allReady || members.length < 2; 
        statusText.innerText = allReady ? `Squad ready (${readyCount}/${members.length})` : `Ready players: ${readyCount}/${members.length}`;
        statusText.classList.toggle('party-status-text--ready', allReady);
        statusText.style.color = allReady ? "#00ffcc" : "#ffaa00";
    } else {
        btnFindMatch.classList.add('hidden');
        statusText.innerText = `Waiting for Leader... (${readyCount}/${members.length} ready)`;
        statusText.style.color = "#ffaa00";
        statusText.classList.remove('party-status-text--ready');
    }
}

document.getElementById('btn-party-ready')?.addEventListener('click', () => {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    if (partySocket && partySocket.readyState === WebSocket.OPEN) {
        const myMemberInfo = currentPartyData?.members.find(m => m.uid === localUid);
        if (myMemberInfo) {
            partySocket.send(JSON.stringify({ action: 'set_ready', isReady: !myMemberInfo.isReady }));
        }
    }
});

document.getElementById('btn-party-find-match')?.addEventListener('click', () => {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    if (partySocket && partySocket.readyState === WebSocket.OPEN) {
        partySocket.send(JSON.stringify({ action: 'find_match' }));
        document.getElementById('party-status-text').innerText = "Entering 2v2 Matchmaking...";
    }
});

document.getElementById('btn-leave-party')?.addEventListener('click', () => {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    if (partySocket) {
        partySocket.close();
        partySocket = null;
    }
    document.getElementById('party-lobby-container').classList.add('hidden');
    document.getElementById('main-menu-container').classList.remove('hidden');
    currentPartyData = null;
    lastPartyReadyCount = 0;
});

// Ability bar click handler
window.targetModeIndex = -1;

window.selectTarget = function(targetId) {
    if (window.targetModeIndex !== -1 && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'ability', abilityIndex: window.targetModeIndex, targetId }));
        if (matchStats.active) matchStats.abilitiesUsed += 1;
        if (typeof sfx !== 'undefined' && sfx.playAttack) sfx.playAttack();
        
        // Hide prompt
        window.targetModeIndex = -1;
        document.getElementById('target-prompt').classList.add('hidden');
        document.querySelectorAll('.player-hud').forEach(el => el.style.border = '2px solid transparent');
        
        document.getElementById('status-message').innerText = "Action Locked In!";
    }
};

document.querySelectorAll('.ability-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            const idx = parseInt(btn.dataset.index);
            const is2v2 = gameState && Object.keys(gameState.players).length > 2;

            if (is2v2) {
                // Enter target select mode
                window.targetModeIndex = idx;
                document.getElementById('target-prompt').classList.remove('hidden');
                document.querySelectorAll('.player-hud').forEach(el => {
                    el.style.border = '2px solid #00ffcc';
                    el.style.cursor = 'pointer';
                });
            } else {
                // 1v1 auto-target
                socket.send(JSON.stringify({ action: 'ability', abilityIndex: idx, targetId: (myPlayerId === 'p1' ? 'p2' : 'p1') }));
                if (matchStats.active) matchStats.abilitiesUsed += 1;
                if (typeof sfx !== 'undefined' && sfx.playAttack) sfx.playAttack();
                // Sequence attack animation omitted to stay lean
            }
        }
    });
});

document.getElementById('btn-disconnect-ok').addEventListener('click', () => {
    document.getElementById('disconnect-modal').classList.add('hidden');
    document.getElementById('btn-return').click();
});

document.getElementById('btn-return').addEventListener('click', () => {
    clearReconnectTimer();
    reconnectAttempts = 0;
    if (socket && socket.readyState === WebSocket.OPEN) {
        manualSocketClose = true;
        socket.close(1000, "User Left Screen");
    }
    
    // Nuclear Clear on Return
    destroyGame();

    // Reset DOM
    document.getElementById('ui-container').classList.add('hidden');
    document.getElementById('main-menu-container').classList.remove('hidden');
    document.getElementById('matchmaking-overlay').classList.add('hidden');
    reportPresenceIfChanged(true);
    
    // Refresh stats
    fetchPlayerProfile();
    document.getElementById('matchmaking-text').innerText = "Connecting to Server...";
    
    // Reset ability bar
    document.getElementById('ability-bar').classList.remove('hidden');
    document.getElementById('btn-return').classList.add('hidden');
    document.querySelectorAll('.ability-btn').forEach(btn => {
        btn.disabled = true;
        btn.classList.remove('on-cooldown');
        btn.querySelector('.ability-name').innerText = '---';
        btn.querySelector('.ability-cd').classList.add('hidden');
    });
    document.getElementById('turn-timer').classList.add('hidden');
    document.getElementById('status-left').innerHTML = '';
    document.getElementById('status-right').innerHTML = '';
    if (timerInterval) clearInterval(timerInterval);
    
    // Visually reset health bars
    document.getElementById('hp-left').style.width = '100%';
    document.getElementById('hp-right').style.width = '100%';

    initGame();
    const layoutWhenReady = () => {
        if (playerLeftShape && playerLeftShape.scene) {
            updateMenuCharacterDisplay();
            refreshPhaserCharacterLayout();
            syncGameContainerPointerEvents();
        } else {
            requestAnimationFrame(layoutWhenReady);
        }
    };
    requestAnimationFrame(layoutWhenReady);

    // Reset multiplayer state
    myPlayerId = null;
    gameState = null;
    prevMyHealth = -1;
    prevOpponentHealth = -1;
});

// Leaderboard UI logic
document.getElementById('btn-leaderboard').addEventListener('click', () => {
    document.getElementById('leaderboard-container').classList.remove('hidden');
    fetchLeaderboard();
});

document.getElementById('btn-close-leaderboard').addEventListener('click', () => {
    document.getElementById('leaderboard-container').classList.add('hidden');
});

async function fetchLeaderboard(silent = false) {
    if (!silent) document.getElementById('leaderboard-list').innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Loading leaderboard...</div>';
    try {
        const res = await fetch(`/leaderboard`);
        const data = await res.json();
        updateLeaderboardUI(data);
    } catch (e) {}
}

function updateLeaderboardUI(data) {
    if (!data) return;
    const isLeaderboardOpen = !document.getElementById('leaderboard-container').classList.contains('hidden');
    if (!isLeaderboardOpen) return;

    const list = document.getElementById('leaderboard-list');
    if (data.length === 0) {
        list.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">No ranked players yet. Go win a match!</div>';
        return;
    }

    list.innerHTML = data.map((player, index) => {
        let rankClass = '';
        let rankIcon = index + 1;
        if (index === 0) { rankClass = 'rank-1'; rankIcon = '🥇'; }
        else if (index === 1) { rankClass = 'rank-2'; rankIcon = '🥈'; }
        else if (index === 2) { rankClass = 'rank-3'; rankIcon = '🥉'; }

        return `
            <div class="leaderboard-row ${rankClass}">
                <div class="lb-rank">${rankIcon}</div>
                <div class="lb-player">${player.username}</div>
                <div class="lb-level">Lvl ${player.level}</div>
                <div class="lb-wins">${player.wins} W</div>
            </div>
        `;
    }).join('');
}

// Window resize handling for Phaser canvas
window.addEventListener('resize', () => {
    syncRootLayoutClasses();
    const gc = getGameContainer();
    if (!gc || !game || !game.scale) return;
    game.scale.resize(gc.clientWidth, gc.clientHeight);
    refreshPhaserCharacterLayout();
});

// Settings & Profile UI Logic
document.getElementById('btn-profile').addEventListener('click', () => {
    document.getElementById('profile-container').classList.remove('hidden');
    const st = document.getElementById('profile-title-status');
    if (st) {
        st.classList.add('hidden');
        st.textContent = '';
        st.classList.remove('profile-title-status--error');
    }
    fetchPlayerProfile();
});
document.getElementById('btn-close-profile').addEventListener('click', () => {
    document.getElementById('profile-container').classList.add('hidden');
});

document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-container').classList.remove('hidden');
    const firstTab = document.querySelector('.settings-tab-btn[data-settings-tab="gameplay"]');
    if (firstTab) firstTab.click();
    refreshPreferenceSettingsLabels();
    updateSoundBtn();
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-container').classList.add('hidden');
});

const btnWipe = document.getElementById('btn-wipe-data');
if (btnWipe) {
    btnWipe.addEventListener('click', async () => {
        if (confirm("⚠️ Are you sure you want to delete your save data? This will reset your progress and free up your username. This cannot be undone.")) {
            try {
                const uid = localStorage.getItem('lumen_clash_uid');
                if (uid) {
                    await fetch(`/reset-player?uid=${uid}`);
                }
                localStorage.removeItem('lumen_clash_uid');
                window.location.reload();
            } catch (e) {
                alert("Reset failed: " + e.message);
            }
        }
    });
}

const btnViewChangelog = document.getElementById('btn-view-changelog');

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    return out;
}

function renderChangelogMarkdown(markdown) {
    const lines = markdown.split(/\r?\n/);
    const html = [];
    let inList = false;

    const closeList = () => {
        if (inList) {
            html.push('</ul>');
            inList = false;
        }
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const trimmed = line.trim();

        if (!trimmed) {
            closeList();
            continue;
        }

        if (trimmed.startsWith('### ')) {
            closeList();
            html.push(`<h3>${renderInlineMarkdown(trimmed.slice(4))}</h3>`);
            continue;
        }
        if (trimmed.startsWith('## ')) {
            closeList();
            html.push(`<h2>${renderInlineMarkdown(trimmed.slice(3))}</h2>`);
            continue;
        }
        if (trimmed.startsWith('# ')) {
            closeList();
            html.push(`<h1>${renderInlineMarkdown(trimmed.slice(2))}</h1>`);
            continue;
        }
        if (trimmed.startsWith('- ')) {
            if (!inList) {
                html.push('<ul>');
                inList = true;
            }
            html.push(`<li>${renderInlineMarkdown(trimmed.slice(2))}</li>`);
            continue;
        }
        if (/^\d+\.\s+/.test(trimmed)) {
            closeList();
            html.push(`<p class="changelog-ordered-line">${renderInlineMarkdown(trimmed)}</p>`);
            continue;
        }

        closeList();
        html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
    }

    closeList();
    return html.join('');
}

if (btnViewChangelog) {
    btnViewChangelog.addEventListener('click', async () => {
        document.getElementById('changelog-modal').classList.remove('hidden');
        const contentDiv = document.getElementById('changelog-content');
        if (contentDiv) contentDiv.innerHTML = '<p class="changelog-loading">Loading changelog...</p>';
        try {
            const res = await fetch('/lumen-clash/CHANGELOG.md');
            if (!res.ok) throw new Error("Changelog not found");
            const text = await res.text();
            if (contentDiv) {
                contentDiv.innerHTML = renderChangelogMarkdown(text);
            }
        } catch (e) {
            if (contentDiv) contentDiv.innerHTML = '<p class="changelog-error">Failed to load changelog. Make sure the local server is running.</p>';
        }
    });
}

const btnCloseChangelog = document.getElementById('btn-close-changelog');
if (btnCloseChangelog) {
    btnCloseChangelog.addEventListener('click', () => {
        document.getElementById('changelog-modal').classList.add('hidden');
    });
}

// Click outside background to close modals
const UI_MODALS = [
    { container: 'character-menu-container', closeBtn: 'btn-close-char-menu' },
    { container: 'profile-container', closeBtn: 'btn-close-profile' },
    { container: 'settings-container', closeBtn: 'btn-close-settings' },
    { container: 'social-container', closeBtn: 'btn-close-social' },
    { container: 'leaderboard-container', closeBtn: 'btn-close-leaderboard' },
    { container: 'changelog-modal', closeBtn: 'btn-close-changelog' },
    { container: 'play-mode-modal', closeBtn: 'btn-close-play-mode' },
    { container: 'private-match-container', closeBtn: 'btn-close-private' },
    { container: 'emote-presets-modal', closeBtn: 'btn-close-emote-presets' },
    { container: 'battle-pass-modal', closeBtn: 'btn-close-bp' },
    { container: 'character-preview-modal', closeBtn: 'btn-close-cp' }
];

window.closeModal = function(id) {
    document.getElementById(id).classList.add('hidden');
    sfx.playClick();
};

UI_MODALS.forEach(modal => {
    const el = document.getElementById(modal.container);
    if (el) {
        el.addEventListener('click', (e) => {
            // Close if clicking directly on the container background
            if (e.target.id === modal.container) {
                document.getElementById(modal.closeBtn).click();
            }
        });
    }
});

// ============================================================
// FLOATING EMOTE BUBBLE
// ============================================================
function showEmoteBubble(pId, emote) {
    // Decide which side: my player = left, opponent = right
    const isMe = pId === myPlayerId;
    const bubbleId = isMe ? 'emote-bubble-left' : 'emote-bubble-right';
    const el = document.getElementById(bubbleId);
    if (!el) return;
    el.innerText = emote;
    el.classList.remove('hidden');
    // Re-trigger animation
    el.style.animation = 'none';
    void el.offsetHeight; // force reflow
    el.style.animation = '';
    setTimeout(() => el.classList.add('hidden'), 2100);
}



// ============================================================
// XP SPLASH / REMATCH
// ============================================================
// ============================================================
// BATTLE PASS & CUSTOMIZATION
// ============================================================
function openBattlePass() {
    if (!playerProfileData) return;
    const track = document.getElementById('bp-track');
    const rankEl = document.getElementById('bp-account-level');
    const heroRankEl = document.getElementById('bp-hero-rank');
    const nextRankEl = document.getElementById('bp-next-rank');
    const statusHeadingEl = document.getElementById('bp-status-heading');
    const statusCopyEl = document.getElementById('bp-status-copy');
    const progressSummaryEl = document.getElementById('bp-progress-summary');
    const trackProgressFillEl = document.getElementById('bp-track-progress-fill');
    const premiumStatusCopyEl = document.getElementById('bp-premium-status-copy');
    const nextRewardIconEl = document.getElementById('bp-next-reward-icon');
    const nextRewardNameEl = document.getElementById('bp-next-reward-name');
    const nextRewardDescEl = document.getElementById('bp-next-reward-desc');
    rankEl.innerText = playerProfileData.level;
    const passXpEl = document.getElementById('bp-pass-xp');
    const lumensSrvEl = document.getElementById('bp-lumens-server');
    if (passXpEl) passXpEl.innerText = String(Math.max(0, Number(playerProfileData.luminaryPassXp) || 0));
    if (lumensSrvEl) lumensSrvEl.innerText = String(Math.max(0, Number(playerProfileData.lumens) || 0));

    track.innerHTML = '';
    // Generate nodes for levels 1-20
    const accLevel = Math.max(1, Number(playerProfileData.level) || 1);

    // Premium unlock UI (server banked Lumens; localStorage mirrors after unlock)
    const lumensEarned = bpLumensEarnedByRank(accLevel);
    const cost = BP_PREMIUM_UNLOCK_COST_LUMENS;
    const serverLumens = Math.max(0, Number(playerProfileData.lumens) || 0);
    const premiumAlready = bpPremiumUnlocked() || !!playerProfileData.bpPremiumUnlocked;
    const eligible = serverLumens >= cost;
    const premiumActive = premiumAlready || eligible;
    const nextRank = Math.min(20, accLevel + 1);
    const nextReward = BP_REWARDS[nextRank];
    const rewardCard = battlePassRewardPresentation(nextReward, nextRank);
    const completionPct = Math.min(100, (accLevel / 20) * 100);

    if (heroRankEl) heroRankEl.textContent = String(accLevel);
    if (nextRankEl) nextRankEl.textContent = String(nextRank);
    if (progressSummaryEl) progressSummaryEl.textContent = `Rank ${accLevel} of 20`;
    if (trackProgressFillEl) trackProgressFillEl.style.width = `${completionPct}%`;
    if (nextRewardIconEl) nextRewardIconEl.textContent = rewardCard.icon;
    if (nextRewardNameEl) nextRewardNameEl.textContent = `Rank ${nextRank}: ${rewardCard.name}`;
    if (nextRewardDescEl) nextRewardDescEl.textContent = rewardCard.desc;
    if (statusHeadingEl) {
        statusHeadingEl.textContent = premiumAlready
            ? 'Premium season active'
            : eligible
                ? 'You can unlock premium now'
                : 'Keep climbing the pass';
    }
    if (statusCopyEl) {
        if (premiumAlready) {
            statusCopyEl.textContent = 'Your premium track is active, so every new rank adds more value to each session.';
        } else if (eligible) {
            statusCopyEl.textContent = `You have enough lumens to unlock premium right now and start claiming the paid side of the track.`;
        } else {
            statusCopyEl.textContent = `Your next highlighted reward lands at rank ${nextRank}. Keep playing matches to move the track forward.`;
        }
    }

    const premiumStatus = document.getElementById('bp-premium-status');
    if (premiumStatus) {
        premiumStatus.textContent = premiumActive ? 'Premium active' : 'Premium locked';
        premiumStatus.classList.toggle('bp-premium-status--active', premiumActive);
        premiumStatus.classList.toggle('bp-premium-status--locked', !premiumActive);
    }
    if (premiumStatusCopyEl) premiumStatusCopyEl.textContent = premiumActive ? 'Active' : 'Locked';

    const creditsEarnedEl = document.getElementById('bp-credits-earned');
    if (creditsEarnedEl) creditsEarnedEl.textContent = `${lumensEarned}`;
    const creditsCostEl = document.getElementById('bp-credits-cost');
    if (creditsCostEl) creditsCostEl.textContent = `${cost}`;
    const creditsFill = document.getElementById('bp-credits-fill');
    if (creditsFill) creditsFill.style.width = `${Math.min(100, (lumensEarned / cost) * 100)}%`;

    const unlockBtn = document.getElementById('btn-bp-unlock-premium');
    if (unlockBtn) {
        unlockBtn.classList.toggle('hidden', premiumAlready || !eligible);
        unlockBtn.disabled = premiumAlready || !eligible;
        unlockBtn.textContent = premiumAlready ? 'Premium unlocked' : 'Unlock Premium';
        unlockBtn.onclick = async () => {
            if (bpPremiumUnlocked() || playerProfileData.bpPremiumUnlocked) return;
            if (serverLumens < cost) return;
            try {
                const r = await fetch('/unlock-premium', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid: localUid })
                });
                const j = await r.json();
                if (!j.ok) return;
                if (j.stats) playerProfileData = { ...playerProfileData, ...j.stats };
                setBpPremiumUnlocked(true);
                openBattlePass();
            } catch (e) {
                console.error('unlock-premium failed', e);
            }
        };
    }
    for (let i = 1; i <= 20; i++) {
        const node = document.createElement('div');
        node.className = 'bp-node';
        if (i <= accLevel) node.classList.add('unlocked');
        if (i === Math.min(20, accLevel)) node.classList.add('current');
        if (i === nextRank && i > accLevel) node.classList.add('next');

        const reward = BP_REWARDS[i];
        const rewardInfo = battlePassRewardPresentation(reward, i);

        node.innerHTML = `
            <div class="lvl">Lvl ${i}</div>
            <div class="reward-icon">${rewardInfo.icon}</div>
            <div class="reward-name">${rewardInfo.name}</div>
        `;
        track.appendChild(node);
    }

    const currentNode = track.querySelector('.bp-node.current') || track.querySelector('.bp-node.next');
    if (currentNode && typeof currentNode.scrollIntoView === 'function') {
        currentNode.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
    
    document.getElementById('battle-pass-modal').classList.remove('hidden');
    sfx.playClick();
}

function openCharacterPreview(charId) {
    if (!playerProfileData) return;
    currentPreviewCharId = charId;
    const char = CHARACTER_CLASSES.find(c => c.id === charId);
    const pClass = playerProfileData.classes[charId] || { level: 1, xp: 0 };
    
    document.getElementById('preview-char-name').innerText = char.name;
    document.getElementById('preview-char-level').innerText = `Level ${pClass.level}`;
    
    // Calculate Upgraded Stats
    const currentHP = char.hp + (pClass.level - 1) * 10;
    const currentATK = char.atk + (pClass.level - 1) * 2;
    
    document.getElementById('preview-hp-val').innerText = currentHP;
    document.getElementById('preview-atk-val').innerText = currentATK;
    
    // Update Stat Bars (relative to some max, say 300 HP and 50 ATK)
    document.getElementById('preview-hp-bar').style.width = Math.min(100, (currentHP / 300) * 100) + '%';
    document.getElementById('preview-atk-bar').style.width = Math.min(100, (currentATK / 50) * 100) + '%';
    
    // Skin Selector Logic
    updateSkinPreview();

    document.getElementById('character-preview-modal').classList.remove('hidden');
    sfx.playClick();
}

function updateSkinPreview() {
    const skins = getAllSkinsForChar(currentPreviewCharId);
    const equipped = (playerProfileData && playerProfileData.equippedSkins && playerProfileData.equippedSkins[currentPreviewCharId]) || 'Default';
    
    currentSkinIndex = skins.findIndex(s => s.name === equipped);
    if (currentSkinIndex === -1) currentSkinIndex = 0;

    applySkinPreviewState();
}

function applySkinPreviewState() {
    const skins = getAllSkinsForChar(currentPreviewCharId);
    if (skins.length === 0) return;
    const skin = skins[currentSkinIndex];
    document.getElementById('current-skin-name').innerText = skin.name;
    refreshCharacterPreviewImg();

    const r = playerProfileData ? Math.max(1, Number(playerProfileData.level) || 1) : 1;
    let unlocked = true;
    let lockReason = '';
    
    if (skin.reqLevel && r < skin.reqLevel) {
        unlocked = false;
        lockReason = `Requires Lv. ${skin.reqLevel}`;
    } else if (skin.reqItem) {
        if (!(playerProfileData && playerProfileData.unlockedCosmetics && playerProfileData.unlockedCosmetics.includes(skin.reqItem))) {
            unlocked = false;
            lockReason = `Shop Item`;
        }
    }

    const btn = document.getElementById('btn-save-customization');
    if (!unlocked) {
        btn.disabled = true;
        btn.innerHTML = `${lockReason}`;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
    } else {
        btn.disabled = false;
        btn.innerHTML = 'Save Selection';
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
    }
}

function nextSkin() {
    const skins = getAllSkinsForChar(currentPreviewCharId);
    currentSkinIndex = (currentSkinIndex + 1) % skins.length;
    applySkinPreviewState();
}

function prevSkin() {
    const skins = getAllSkinsForChar(currentPreviewCharId);
    currentSkinIndex = (currentSkinIndex - 1 + skins.length) % skins.length;
    applySkinPreviewState();
}

async function saveCustomization() {
    const skinName = document.getElementById('current-skin-name').innerText;
    const titlePreserve =
        playerProfileData && playerProfileData.equippedTitle !== undefined
            ? playerProfileData.equippedTitle
            : '';

    try {
        const res = await fetch('/save-customization', {
            method: 'POST',
            body: JSON.stringify({
                uid: localUid,
                equippedTitle: titlePreserve,
                charId: currentPreviewCharId,
                skin: skinName
            })
        });
        if (res.ok) {
            closeModal('character-preview-modal');
            const idx = CHARACTER_CLASSES.findIndex(c => c.id === currentPreviewCharId);
            if (idx >= 0) selectedCharacterIndex = idx;
            persistLastSelectedCharacterId(currentPreviewCharId);
            syncRosterCardSelectionClasses();
            updateMenuCharacterDisplay();
            fetchPlayerProfile(); // Refresh
        }
    } catch(e) { console.error("Save failed", e); }
}

async function saveProfileTitle() {
    const titleSelect = document.getElementById('profile-select-title');
    const statusEl = document.getElementById('profile-title-status');
    if (!titleSelect || !playerProfileData) return;

    const title = titleSelect.value;
    const charId = CHARACTER_CLASSES[selectedCharacterIndex]?.id || 'aegisKnight';
    const skin =
        (playerProfileData.equippedSkins && playerProfileData.equippedSkins[charId]) || 'Default';

    if (statusEl) {
        statusEl.classList.remove('hidden', 'profile-title-status--error');
        statusEl.textContent = 'Saving…';
    }

    try {
        const res = await fetch('/save-customization', {
            method: 'POST',
            body: JSON.stringify({
                uid: localUid,
                equippedTitle: title,
                charId,
                skin
            })
        });
        if (res.ok) {
            if (playerProfileData) playerProfileData.equippedTitle = title;
            syncMainMenuHeaderProfile(playerProfileData);
            if (statusEl) {
                statusEl.textContent = 'Title updated.';
                statusEl.classList.remove('profile-title-status--error');
            }
            sfx.playClick();
            await fetchPlayerProfile(true);
        } else {
            if (statusEl) {
                statusEl.textContent = 'Could not save title. Try again.';
                statusEl.classList.add('profile-title-status--error');
            }
        }
    } catch (e) {
        console.error('Save title failed', e);
        if (statusEl) {
            statusEl.textContent = 'Could not save title.';
            statusEl.classList.add('profile-title-status--error');
        }
    }
}

// Fail-safe global handlers for Splash Screen
window.handleSplashExit = function() {
    clearReconnectTimer();
    reconnectAttempts = 0;
    console.log("[Splash] Exit clicked");
    const splash = document.getElementById('xp-splash-overlay');
    if (splash) {
        splash.classList.add('hidden');
        // Keep .active-showing while gameState may still be GAME_OVER, or updateUI() will show the splash again.
    }
    if (socket) {
        manualSocketClose = true;
        socket.close();
    }

    document.getElementById('ui-container').classList.add('hidden');
    document.getElementById('matchmaking-overlay').classList.add('hidden');
    const hso = document.getElementById('hero-select-overlay');
    if (hso) hso.classList.add('hidden');
    document.getElementById('main-menu-container').classList.remove('hidden');
    closeMenuActivityPopover();
    reportPresenceIfChanged(true);

    const rpm = document.getElementById('report-player-modal');
    if (rpm) rpm.classList.add('hidden');

    if (!game) initGame();
    const layoutWhenReady = () => {
        if (playerLeftShape && playerLeftShape.scene) {
            updateMenuCharacterDisplay();
            refreshPhaserCharacterLayout();
            syncGameContainerPointerEvents();
        } else {
            requestAnimationFrame(layoutWhenReady);
        }
    };
    requestAnimationFrame(layoutWhenReady);

    updateUI();
};

window.handleSplashRematch = function() {
    clearReconnectTimer();
    reconnectAttempts = 0;
    console.log("[Splash] Rematch clicked");
    if (socket && socket.readyState === WebSocket.OPEN) {
        const ser = gameState && gameState.series;
        const seriesKind = ser && !ser.complete ? 'continue' : 'single';
        socket.send(JSON.stringify({ action: 'rematch', series: seriesKind }));
        const btn = document.getElementById('btn-rematch');
        const bo3 = document.getElementById('btn-rematch-bo3');
        const label = document.getElementById('btn-rematch-label');
        if (label) label.textContent = 'Waiting for Opponent...';
        if (btn) btn.disabled = true;
        if (bo3) bo3.disabled = true;
        if (typeof sfx.playClick === 'function') sfx.playClick();
        initGame();
        return;
    }
    console.warn('[Splash] Rematch: no active socket — return to menu');
    const st = document.getElementById('rematch-status');
    if (st) st.textContent = 'Connection lost — use Play from the menu.';
    window.handleSplashExit();
};

window.handleSplashRematchBo3 = function() {
    clearReconnectTimer();
    reconnectAttempts = 0;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'rematch', series: 'bo3' }));
        const btn = document.getElementById('btn-rematch');
        const bo3 = document.getElementById('btn-rematch-bo3');
        const label = document.getElementById('btn-rematch-label');
        if (label) label.textContent = 'Waiting for Opponent...';
        if (btn) btn.disabled = true;
        if (bo3) bo3.disabled = true;
        if (typeof sfx.playClick === 'function') sfx.playClick();
        initGame();
        return;
    }
    window.handleSplashRematch();
};

async function showXPSplash(won, pg) {
    console.group("[Splash] Initialization");
    console.log("Won:", won);
    console.log("PostGame Data:", pg);

    if (!pg) {
        console.warn("[Splash] Proceeding with minimal data (no postGame stats)");
    }
    
    const splash = document.getElementById('xp-splash-overlay');
    const title = document.getElementById('splash-title');
    const subtitle = document.getElementById('splash-subtitle');
    const levelEl = document.getElementById('splash-level');
    const xpGainedEl = document.getElementById('splash-xp-gained');
    const xpFill = document.getElementById('splash-xp-fill');
    const xpDetails = document.getElementById('splash-xp-details');
    const lvlBurst = document.getElementById('level-up-burst');
    const outcomeCopyEl = document.getElementById('splash-outcome-copy');
    const heroCopyEl = document.getElementById('splash-hero-copy');
    const progressCopyEl = document.getElementById('splash-progress-copy');
    
    const bpRankEl = document.getElementById('bp-splash-rank');
    const bpFill = document.getElementById('bp-splash-fill');
    const bpDetails = document.getElementById('bp-splash-details');
    const bpXpGained = document.getElementById('bp-splash-xp-gained');
    const statDealt = document.getElementById('splash-stat-dmg-dealt');
    const statTaken = document.getElementById('splash-stat-dmg-taken');
    const statAbilities = document.getElementById('splash-stat-abilities');
    const statTurns = document.getElementById('splash-stat-turns');

    const rankedMod = document.getElementById('ranked-splash-module');
    const rankedTierEl = document.getElementById('ranked-splash-tier');
    const rankedDeltaEl = document.getElementById('ranked-splash-delta');

    if (!splash) {
        console.error("[Splash] FATAL: Overlay element not found");
        console.groupEnd();
        return;
    }

    // Hide other likely obstructions (including the HUD)
    ['ui-container', 'matchmaking-overlay', 'profile-container', 'settings-container', 'character-menu-container', 'disconnect-modal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    // Reset UI and FORCE pointer events/z-index
    splash.style.zIndex = "99999"; 
    splash.style.pointerEvents = "auto";
    splash.style.display = "flex"; // Ensure visible
    const ser = typeof gameState !== 'undefined' && gameState && gameState.series;
    if (ser && ser.complete) {
        const myW = myPlayerId === 'p1' ? ser.p1Wins : ser.p2Wins;
        const iWonSeries = myW >= ser.needed;
        title.innerText = iWonSeries ? 'SERIES WON' : 'SERIES LOST';
        title.style.color = iWonSeries ? '#00d2ff' : '#ff0055';
        if (subtitle) subtitle.innerText = 'MATCH SET COMPLETE';
    } else {
        title.innerText = won ? 'VICTORY' : 'DEFEAT';
        title.style.color = won ? '#00d2ff' : '#ff0055';
        if (subtitle) subtitle.innerText = pg && pg.isRanked ? 'RANKED MATCH COMPLETE' : 'MATCH COMPLETE';
    }
    xpFill.style.transition = 'none';
    xpFill.style.width = '0%';
    bpFill.style.transition = 'none';
    bpFill.style.width = '0%';
    lvlBurst.classList.add('hidden');
    splash.classList.remove('hidden');

    // Enable buttons
    const btnRematch = document.getElementById('btn-rematch');
    const btnBo3 = document.getElementById('btn-rematch-bo3');
    const btnExit = document.getElementById('btn-splash-exit');
    const rematchLbl = document.getElementById('btn-rematch-label');
    const seriesLine = document.getElementById('splash-series-line');
    const serState = typeof gameState !== 'undefined' && gameState && gameState.series;
    if (rematchLbl) rematchLbl.textContent = serState && !serState.complete ? 'Next round' : 'Challenge Again';
    if (seriesLine) {
        if (serState) {
            seriesLine.classList.remove('hidden');
            const myW = myPlayerId === 'p1' ? serState.p1Wins : serState.p2Wins;
            const opW = myPlayerId === 'p1' ? serState.p2Wins : serState.p1Wins;
            seriesLine.classList.toggle('series-complete', !!serState.complete);
            if (serState.complete) {
                seriesLine.innerText = `Series final — You ${myW} · Opponent ${opW} · First to ${serState.needed}`;
            } else {
                seriesLine.innerText = `Series — You ${myW} · Opponent ${opW} · First to ${serState.needed}`;
            }
        } else {
            seriesLine.classList.add('hidden');
            seriesLine.innerText = '';
            seriesLine.classList.remove('series-complete');
        }
    }
    if (btnBo3) {
        const hideBo3 = !!(serState && !serState.complete);
        btnBo3.classList.toggle('hidden', hideBo3);
        btnBo3.disabled = false;
        btnBo3.style.pointerEvents = 'auto';
        btnBo3.style.cursor = 'pointer';
    }
    if (btnRematch) {
        btnRematch.disabled = false;
        btnRematch.style.pointerEvents = "auto";
        btnRematch.style.cursor = "pointer";
    }
    if (btnExit) {
        btnExit.style.pointerEvents = "auto";
        btnExit.style.cursor = "pointer";
    }
    const rmStatus = document.getElementById('rematch-status');
    if (rmStatus) rmStatus.innerText = '';

    lastReportContext = { roomId: lastRoomId || null, reportedUid: null };
    if (typeof gameState !== 'undefined' && gameState && gameState.players && myPlayerId) {
        const oid = myPlayerId === 'p1' ? 'p2' : 'p1';
        const opp = gameState.players[oid];
        if (opp && opp.uid) lastReportContext.reportedUid = opp.uid;
    }
    const qLine = document.getElementById('splash-quest-line');
    if (qLine) {
        if (pg && pg.questCompleted && pg.questCompleted.length) {
            qLine.textContent = `Quests completed: ${pg.questCompleted.map((q) => q.label).join(' · ')}`;
            qLine.classList.remove('hidden');
        } else {
            qLine.classList.add('hidden');
            qLine.textContent = '';
        }
    }

    if (statDealt) {
        const val = (pg && pg.matchStats && pg.matchStats.damageDealt !== undefined) ? pg.matchStats.damageDealt : matchStats.damageDealt;
        statDealt.innerText = String(Math.max(0, Math.round(val || 0)));
    }
    if (statTaken) {
        const val = (pg && pg.matchStats && pg.matchStats.damageTaken !== undefined) ? pg.matchStats.damageTaken : matchStats.damageTaken;
        statTaken.innerText = String(Math.max(0, Math.round(val || 0)));
    }
    if (statAbilities) {
        const val = (pg && pg.matchStats && pg.matchStats.abilitiesUsed !== undefined) ? pg.matchStats.abilitiesUsed : matchStats.abilitiesUsed;
        statAbilities.innerText = String(Math.max(0, Math.round(val || 0)));
    }
    if (statTurns) {
        const val = (pg && pg.matchStats && pg.matchStats.turnSwaps !== undefined) ? pg.matchStats.turnSwaps : matchStats.turnSwaps;
        statTurns.innerText = String(Math.max(0, Math.round(val || 0)));
    }

    // Data handling with defensive aliases
    try {
        const classId = pg ? (pg.lastMatchClassId || pg.classId || 'voidWeaver') : 'voidWeaver';
        console.log("Target ClassId:", classId);
        
        const charData = (pg && pg.classes && pg.classes[classId]) || 
                         (pg && pg.classes && pg.classes['aegisKnight']) || 
                         { level: 1, xp: 0 };
        
        console.log("Target CharData:", charData);
        
        const charLevel = charData.level || 1;
        const charXp = (charData.xp !== undefined) ? charData.xp : 0;
        const xpGained = pg ? (pg.xpGained || (won ? 50 : 10)) : (won ? 30 : 10);
        const charNeed = Math.max(100, charLevel * 100);
        const endCharPct = classLevelProgress(charData).pct;
        const preClassXp = Math.max(0, charXp - xpGained);
        const startCharPct = charNeed > 0 ? Math.min(100, Math.max(0, (preClassXp / charNeed) * 100)) : 0;
        const charName = CHARACTER_CLASSES.find((x) => x.id === classId)?.name || 'Class';
        const questCount = pg && pg.questCompleted ? pg.questCompleted.length : 0;
        const progressCopy = pg && pg.leveledUp
            ? 'Level up secured'
            : questCount > 0
                ? `${questCount} quest${questCount === 1 ? '' : 's'} progressed`
                : pg && pg.isRanked
                    ? 'Rank adjusted'
                    : 'Roster XP banked';

        console.log("Calculated: Level", charLevel, "XP", charXp, "Gained", xpGained);

        xpGainedEl.innerText = xpGained;
        levelEl.innerText = (pg && pg.leveledUp) ? Math.max(1, charLevel - 1) : charLevel;
        if (outcomeCopyEl) outcomeCopyEl.innerText = won ? 'Strong finish' : 'Regroup and queue again';
        if (heroCopyEl) heroCopyEl.innerText = charName;
        if (progressCopyEl) progressCopyEl.innerText = progressCopy;

        bpRankEl.innerText = (pg && pg.level) || 1;
        bpXpGained.innerText = `+${xpGained} XP (${charName})`;

        const rosterEnd = sumRosterXpProgress(pg ? pg.classes : null);
        const rosterStartPct = rosterPctAfterSubtractingClassXp(pg, classId, xpGained);

        if (pg.isRanked) {
            rankedMod.classList.remove('hidden');
            const sign = pg.rankedDelta >= 0 ? '+' : '';
            rankedDeltaEl.innerText = `${sign}${pg.rankedDelta} MMR`;
            rankedDeltaEl.style.color = pg.rankedDelta >= 0 ? '#00ff88' : '#ff4444';
            
            const rPlacements = pg.rankedRecord ? pg.rankedRecord.placements : 0;
            const rMmr = pg.rankedRecord ? pg.rankedRecord.mmr : 1000;
            let rTier = `Unranked (${rPlacements}/5)`;
            if (rPlacements >= 5) {
                if (rMmr < 1150) rTier = `Bronze (${rMmr})`;
                else if (rMmr < 1300) rTier = `Silver (${rMmr})`;
                else if (rMmr < 1500) rTier = `Gold (${rMmr})`;
                else if (rMmr < 1850) rTier = `Platinum (${rMmr})`;
                else rTier = `Diamond (${rMmr})`;
            }
            rankedTierEl.innerText = rTier;
        } else {
            rankedMod.classList.add('hidden');
        }

        console.groupEnd();
        // Wait for pop-in animation
        await new Promise(r => setTimeout(r, 600));

        // Animation: Character Level (bar = % toward this class's next level)
        if (pg.leveledUp) {
            xpFill.style.transition = 'width 0.8s ease-in';
            xpFill.style.width = '100%';
            await new Promise(r => setTimeout(r, 900));
            lvlBurst.classList.remove('hidden');
            levelEl.innerText = charLevel;
            if (typeof sfx.playLevelUp === 'function') sfx.playLevelUp();
            xpFill.style.transition = 'none';
            xpFill.style.width = '0%';
            await new Promise(r => setTimeout(r, 50));
            xpFill.style.transition = 'width 1.2s cubic-bezier(0.1, 0.5, 0.2, 1)';
            xpFill.style.width = `${endCharPct}%`;
        } else {
            xpFill.style.width = `${startCharPct}%`;
            await new Promise(r => setTimeout(r, 50));
            xpFill.style.transition = 'width 1.5s cubic-bezier(0.1, 0.5, 0.2, 1)';
            xpFill.style.width = `${endCharPct}%`;
        }
        xpDetails.innerText = `${charXp} / ${charNeed} XP (${charName})`;

        bpFill.style.width = `${rosterStartPct}%`;
        await new Promise(r => setTimeout(r, 50));
        bpFill.style.transition = 'width 1.5s cubic-bezier(0.1, 0.5, 0.2, 1)';
        bpFill.style.width = `${rosterEnd.pct}%`;
        bpDetails.innerText = `Roster ${rosterEnd.sumXp} / ${rosterEnd.sumNeed} XP · Rank ${pg.level || 1}`;
    } catch (e) {
        console.error("[Splash] Critical Logic Error", e);
        console.groupEnd();
    }
}

const btnRematchEl = document.getElementById('btn-rematch');
const btnExitEl = document.getElementById('btn-splash-exit');

function bindSplashButton(el, handler) {
    if (!el) return;
    el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
    });
}
bindSplashButton(btnRematchEl, () => window.handleSplashRematch());
const btnRematchBo3El = document.getElementById('btn-rematch-bo3');
bindSplashButton(btnRematchBo3El, () => window.handleSplashRematchBo3());
bindSplashButton(btnExitEl, () => window.handleSplashExit());

const btnDuelToastSocial = document.getElementById('btn-duel-toast-social');
if (btnDuelToastSocial) {
    btnDuelToastSocial.addEventListener('click', () => {
        openSocialHub('friends');
    });
}

(function initMenuActivityHub() {
    const popBody = document.getElementById('menu-activity-popover-body');
    if (popBody) {
        popBody.addEventListener('click', (e) => {
            const t = e.target.closest('.menu-activity-item');
            if (!t) return;
            closeMenuActivityPopover();
            openSocialHub('friends');
            if (typeof sfx !== 'undefined' && typeof sfx.playClick === 'function') sfx.playClick();
        });
    }
    const btn = document.getElementById('btn-menu-activity');
    const closeBtn = document.getElementById('btn-menu-activity-close');
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (menuActivityPopoverOpen) closeMenuActivityPopover();
            else openMenuActivityPopover();
        });
    }
    if (closeBtn) closeBtn.addEventListener('click', () => closeMenuActivityPopover());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menuActivityPopoverOpen) closeMenuActivityPopover();
    });
    document.addEventListener('click', (e) => {
        if (!menuActivityPopoverOpen) return;
        const t = e.target;
        if (t.closest('#menu-activity-popover') || t.closest('#btn-menu-activity')) return;
        closeMenuActivityPopover();
    });
})();

// ============================================================
// IN-GAME EMOTE BAR
// ============================================================
function renderEmoteBar() {
    const bar = document.getElementById('emote-bar');
    if (!bar) return;
    bar.innerHTML = '';
    activeEmotes.forEach(emote => {
        const btn = document.createElement('button');
        btn.className = 'emote-btn';
        btn.innerText = emote;
        btn.title = `Send ${emote}`;
        btn.addEventListener('click', () => {
            if (emoteCooldown) return;
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ action: 'emote', emote }));
                sfx.playClick();
                emoteCooldown = true;
                bar.querySelectorAll('.emote-btn').forEach(b => b.classList.add('on-cooldown'));
                setTimeout(() => {
                    emoteCooldown = false;
                    bar.querySelectorAll('.emote-btn').forEach(b => b.classList.remove('on-cooldown'));
                }, 3000); // 3s cooldown between emotes
            }
        });
        bar.appendChild(btn);
    });
}

// ============================================================
// SOUND SETTINGS TOGGLE
// ============================================================
function updateSoundBtn() {
    const btn = document.getElementById('btn-sound-settings');
    if (btn) btn.innerText = sfx.enabled ? '\ud83d\udd0a Sound: ON' : '\ud83d\udd07 Sound: OFF';
}
updateSoundBtn();

const btnSoundSettings = document.getElementById('btn-sound-settings');
if (btnSoundSettings) {
    btnSoundSettings.addEventListener('click', () => {
        sfx.toggle();
        updateSoundBtn();
        sfx.playClick();
    });
}

const btnPerfOverlay = document.getElementById('btn-perf-overlay');
if (btnPerfOverlay) {
    btnPerfOverlay.addEventListener('click', () => {
        setPerfOverlayPref(!prefOn(PREF_KEYS.perfOverlay));
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnA11yLarge = document.getElementById('btn-a11y-large-text');
if (btnA11yLarge) {
    btnA11yLarge.addEventListener('click', () => {
        toggleStoredPref(PREF_KEYS.a11yLarge);
        applyPreferenceClasses();
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnA11yContrast = document.getElementById('btn-a11y-high-contrast');
if (btnA11yContrast) {
    btnA11yContrast.addEventListener('click', () => {
        toggleStoredPref(PREF_KEYS.a11yContrast);
        applyPreferenceClasses();
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnA11yHp = document.getElementById('btn-a11y-hp-bars');
if (btnA11yHp) {
    btnA11yHp.addEventListener('click', () => {
        toggleStoredPref(PREF_KEYS.a11yHpAlt);
        applyPreferenceClasses();
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnReduceMotion = document.getElementById('btn-reduce-motion');
if (btnReduceMotion) {
    btnReduceMotion.addEventListener('click', () => {
        toggleStoredPref(PREF_KEYS.reduceMotion);
        applyPreferenceClasses();
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnMenuVfx = document.getElementById('btn-menu-vfx');
if (btnMenuVfx) {
    btnMenuVfx.addEventListener('click', () => {
        toggleStoredPref(PREF_KEYS.menuVfxOff);
        applyPreferenceClasses();
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnCameraShake = document.getElementById('btn-camera-shake');
if (btnCameraShake) {
    btnCameraShake.addEventListener('click', () => {
        cycleLevelPref(PREF_KEYS.cameraShake);
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

const btnHitStop = document.getElementById('btn-hit-stop');
if (btnHitStop) {
    btnHitStop.addEventListener('click', () => {
        cycleLevelPref(PREF_KEYS.hitStop);
        refreshPreferenceSettingsLabels();
        sfx.playClick();
    });
}

// ============================================================
// EMOTE PRESETS MODAL
// ============================================================
let editingSlot = 0; // which slot is currently selected for replacement

function renderEmotePresetsModal() {
    // Render slots
    const slotsEl = document.getElementById('emote-slots');
    slotsEl.innerHTML = '';
    activeEmotes.forEach((emote, i) => {
        const slot = document.createElement('div');
        slot.className = 'emote-slot' + (i === editingSlot ? ' active-slot' : '');
        slot.innerText = emote;
        slot.addEventListener('click', () => {
            editingSlot = i;
            sfx.playClick();
            renderEmotePresetsModal();
        });
        slotsEl.appendChild(slot);
    });

    // Render pool
    const poolEl = document.getElementById('emote-pool');
    poolEl.innerHTML = '';
    
    // First 8 emotes are free, the rest must be unlocked
    const freeEmotes = ALL_EMOTES.slice(0, 8);
    
    ALL_EMOTES.forEach(emote => {
        const btn = document.createElement('button');
        const inUse = activeEmotes.includes(emote);
        
        const unlocked = freeEmotes.includes(emote) || (playerProfileData && playerProfileData.unlockedCosmetics && playerProfileData.unlockedCosmetics.includes(emote));
        
        if (!unlocked) {
            btn.className = 'emote-pool-btn locked-emote';
            btn.innerHTML = `${emote}<br><span style="font-size:0.5rem; color:#ff00cc;">LOCKED</span>`;
            btn.disabled = true;
            btn.style.opacity = '0.4';
            btn.style.cursor = 'not-allowed';
        } else {
            btn.className = 'emote-pool-btn' + (inUse ? ' in-use' : '');
            btn.innerText = emote;
            btn.addEventListener('click', () => {
                // Replace the active slot with this emote (swap if already in use)
                const existingIdx = activeEmotes.indexOf(emote);
                if (existingIdx !== -1) {
                    // Swap
                    activeEmotes[existingIdx] = activeEmotes[editingSlot];
                }
                activeEmotes[editingSlot] = emote;
                saveEmotePresets(activeEmotes);
                if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
                // Advance to next slot
                editingSlot = (editingSlot + 1) % 4;
                renderEmotePresetsModal();
            });
        }
        poolEl.appendChild(btn);
    });
}

const btnEmotePresets = document.getElementById('btn-emote-presets');
if (btnEmotePresets) {
    btnEmotePresets.addEventListener('click', () => {
        editingSlot = 0;
        renderEmotePresetsModal();
        const modal = document.getElementById('emote-presets-modal');
        if (modal) modal.classList.remove('hidden');
        sfx.playClick();
    });
}

const btnCloseEmotePresets = document.getElementById('btn-close-emote-presets');
if (btnCloseEmotePresets) {
    btnCloseEmotePresets.addEventListener('click', () => {
        const modal = document.getElementById('emote-presets-modal');
        if (modal) modal.classList.add('hidden');
        saveEmotePresets(activeEmotes);
        sfx.playClick();
    });
}

// Add click sound to all major menu buttons
 ['btn-play-game','btn-character','btn-leaderboard','btn-profile','btn-friends','btn-guild','btn-settings',
  'btn-close-char-menu','btn-close-profile','btn-close-settings','btn-close-leaderboard',
  'btn-close-changelog','btn-view-changelog','btn-return','btn-disconnect-ok',
  'btn-quick-match','btn-private-choice','btn-close-play-mode','btn-close-private',
  'btn-host-choice','btn-join-choice','btn-submit-join','btn-rematch','btn-rematch-bo3','btn-splash-exit',
  'btn-duel-toast-social',
  'btn-menu-activity', 'btn-menu-activity-close',
  'btn-battle-pass', 'btn-emote-presets', 'btn-save-customization', 'btn-save-profile-title', 'btn-hero-ready',
  'btn-perf-overlay', 'btn-a11y-large-text', 'btn-a11y-high-contrast', 'btn-a11y-hp-bars', 'btn-reduce-motion',
  'btn-menu-vfx', 'btn-camera-shake', 'btn-hit-stop'].forEach(id => {
     const el = document.getElementById(id);
     if (el) el.addEventListener('click', () => sfx.playClick(), true);
 });

function submitLumenReport(payload) {
    return fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, reporterUid: localUid, clientVersion: '1.6.1' })
    }).then((r) => r.json());
}

function closeReportPlayerModal() {
    const m = document.getElementById('report-player-modal');
    if (m) m.classList.add('hidden');
    const err = document.getElementById('report-error');
    const ok = document.getElementById('report-success');
    if (err) {
        err.classList.add('hidden');
        err.textContent = '';
    }
    if (ok) {
        ok.classList.add('hidden');
        ok.textContent = '';
    }
}

function openReportPlayerModal() {
    const m = document.getElementById('report-player-modal');
    if (!m) return;
    const err = document.getElementById('report-error');
    const ok = document.getElementById('report-success');
    const det = document.getElementById('report-details');
    if (err) {
        err.classList.add('hidden');
        err.textContent = '';
    }
    if (ok) {
        ok.classList.add('hidden');
        ok.textContent = '';
    }
    if (det) det.value = '';
    m.classList.remove('hidden');
}

document.getElementById('btn-splash-report')?.addEventListener('click', () => {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    if (typeof lastReportContext !== 'undefined' && !lastReportContext.reportedUid && gameState && myPlayerId) {
        // Fallback for splash: try to guess opponent if not set
        const oid = myPlayerId === 'p1' ? 'p2' : 'p1';
        const opp = gameState.players[oid];
        if (opp) lastReportContext.reportedUid = opp.uid;
    }
    openReportPlayerModal();
});

// HUD Report Buttons
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-report-hud');
    if (btn) {
        e.stopPropagation();
        if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
        const pId = btn.getAttribute('data-player-id');
        if (gameState && gameState.players && gameState.players[pId]) {
            const p = gameState.players[pId];
            lastReportContext.reportedUid = p.uid;
            lastReportContext.roomId = lastRoomId;
            openReportPlayerModal();
        }
    }
});

document.getElementById('btn-report-cancel')?.addEventListener('click', () => {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    closeReportPlayerModal();
});

document.getElementById('btn-report-submit')?.addEventListener('click', async () => {
    if (typeof sfx !== 'undefined' && sfx.playClick) sfx.playClick();
    const cat = document.getElementById('report-category')?.value || 'other';
    const details = (document.getElementById('report-details')?.value || '').trim();
    const errEl = document.getElementById('report-error');
    const okEl = document.getElementById('report-success');
    if (okEl) {
        okEl.classList.add('hidden');
        okEl.textContent = '';
    }
    if (!lastReportContext.reportedUid) {
        if (errEl) {
            errEl.textContent = 'Could not identify the opponent for this match.';
            errEl.classList.remove('hidden');
        }
        return;
    }
    if (errEl) errEl.classList.add('hidden');
    try {
        const res = await submitLumenReport({
            reportedUid: lastReportContext.reportedUid,
            category: cat,
            roomId: lastReportContext.roomId,
            details: details || undefined
        });
        if (res && res.ok) {
            if (okEl) {
                okEl.textContent = 'Report sent. Thank you.';
                okEl.classList.remove('hidden');
            }
            setTimeout(() => closeReportPlayerModal(), 1200);
        } else if (errEl) {
            errEl.textContent = (res && res.error) || 'Could not send report. Try again later.';
            errEl.classList.remove('hidden');
        }
    } catch (e) {
        if (errEl) {
            errEl.textContent = 'Network error. Is the Worker running?';
            errEl.classList.remove('hidden');
        }
    }
});
function syncSpritesToLatestPlayers() {
    if (!gameState || !gameState.players || !myPlayerId) return;
    const myP = gameState.players[myPlayerId];
    const oppId = myPlayerId === 'p1' ? 'p2' : 'p1';
    const oppP = gameState.players[oppId];

    if (myP && myP.classId && playerLeftShape) {
        let tex = textureKeyForClassAndSkin(myP.classId, myP.equippedSkin || 'Default');
        if (playerLeftShape.active) {
            playerLeftShape.setTexture(tex);
            applyPhaserCharacterScales(playerLeftShape.scene);
        }
    }
    if (oppP && oppP.classId && playerRightShape) {
        let tex = textureKeyForClassAndSkin(oppP.classId, oppP.equippedSkin || 'Default');
        if (playerRightShape.active) {
            playerRightShape.setTexture(tex);
            applyPhaserCharacterScales(playerRightShape.scene);
        }
    }
}

// ============================================================
// BANNED NOTIFICATION SYSTEM
// ============================================================
let bannedTimer = null;

function showBannedModal(until) {
    const modal = document.getElementById('banned-modal');
    if (!modal) return;

    modal.classList.remove('hidden');
    
    // Hide other overlays that might conflict
    document.getElementById('matchmaking-overlay')?.classList.add('hidden');
    document.getElementById('play-mode-modal')?.classList.add('hidden');

    const timer = document.getElementById('banned-countdown-timer');
    const container = document.getElementById('banned-countdown-container');
    const permText = document.getElementById('banned-perm-text');

    if (bannedTimer) clearInterval(bannedTimer);

    if (!until) {
        // Permanent ban
        if (container) container.classList.add('hidden');
        if (permText) permText.classList.remove('hidden');
        if (timer) timer.innerText = '-- : -- : --';
    } else {
        // Temporary ban
        if (container) container.classList.remove('hidden');
        if (permText) permText.classList.add('hidden');

        const updateTimer = () => {
            const now = Date.now();
            const diff = until - now;
            if (diff <= 0) {
                if (timer) timer.innerText = '00 : 00 : 00';
                clearInterval(bannedTimer);
                // Optionally auto-refresh profile to clear ban UI
                fetchPlayerProfile(true);
                return;
            }
            const hours = Math.floor(diff / 3600000);
            const mins = Math.floor((diff % 3600000) / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            if (timer) {
                timer.innerText = `${String(hours).padStart(2, '0')} : ${String(mins).padStart(2, '0')} : ${String(secs).padStart(2, '0')}`;
            }
        };
        updateTimer();
        bannedTimer = setInterval(updateTimer, 1000);
    }
}

// Exit button for banned modal
document.getElementById('btn-banned-exit')?.addEventListener('click', () => {
    // For a web app, we can just clear UIDs or just refresh to a safe state
    // But since the ban is server-side, a simple reload is cleanest
    window.location.reload();
});

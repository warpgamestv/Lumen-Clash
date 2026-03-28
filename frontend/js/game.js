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

function getGameContainer() {
    return document.getElementById('game-container');
}

/** Canvas is decorative on the main menu; during matches nothing on the canvas is clicked (abilities are HTML). */
function syncGameContainerPointerEvents() {
    const gc = getGameContainer();
    if (!gc) return;
    const mainHidden = document.getElementById('main-menu-container').classList.contains('hidden');
    gc.style.pointerEvents = mainHidden ? 'auto' : 'none';
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
let gameState = null;
let prevMyHealth = -1;
let prevOpponentHealth = -1;
let reconnectAttempts = 0;
let reconnectTimer = null;
let manualSocketClose = false;
let lastRoomId = null;
let lastTurnSnapshot = null;
let heroSelectPick = { charId: 'aegisKnight', skin: 'Default' };
let heroSelectLocked = false;
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

async function reportPresenceIfChanged(force = false) {
    const state = computeDesiredPresence();
    if (!force && state === lastReportedPresence) return;
    lastReportedPresence = state;
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

console.log("Auto-update heartbeat active (10s separate)");

// Fetch Profile Initialization
let myUsername = 'Player';
let lastSocialSnapshot = null;
let menuActivityPopoverOpen = false;

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

function renderMenuActivityPopoverBody() {
    const body = document.getElementById('menu-activity-popover-body');
    if (!body) return;
    const data = lastSocialSnapshot;
    if (!data) {
        body.innerHTML = '<p class="menu-activity-empty">Loading activity…</p>';
        return;
    }
    const reqs = data.requests || [];
    const duels = data.duelInvites || [];
    if (reqs.length === 0 && duels.length === 0) {
        body.innerHTML = '<p class="menu-activity-empty">No friend requests or duel invites right now.</p>';
        return;
    }
    let html = '';
    const bits = [];
    if (reqs.length > 0) {
        bits.push(`${reqs.length} friend request${reqs.length > 1 ? 's' : ''}`);
    }
    if (duels.length > 0) {
        bits.push(`${duels.length} duel invite${duels.length > 1 ? 's' : ''}`);
    }
    body.innerHTML = `<button type="button" class="menu-activity-item">${bits.join(' · ')} — Open Social</button>`;
}

function closeMenuActivityPopover() {
    menuActivityPopoverOpen = false;
    const pop = document.getElementById('menu-activity-popover');
    if (pop) pop.classList.add('hidden');
    const b = document.getElementById('btn-menu-activity');
    if (b) b.setAttribute('aria-expanded', 'false');
}

function openMenuActivityPopover() {
    menuActivityPopoverOpen = true;
    const pop = document.getElementById('menu-activity-popover');
    if (pop) pop.classList.remove('hidden');
    const b = document.getElementById('btn-menu-activity');
    if (b) b.setAttribute('aria-expanded', 'true');
    renderMenuActivityPopoverBody();
    fetchFriends(true);
}

async function fetchPlayerProfile(silent = false) {
    try {
        const res = await fetch(`/profile?uid=${localUid}`);
        const data = await res.json();
        playerProfileData = data;
        myUsername = data.username || 'Player';
        
        document.getElementById('profile-username').innerText = myUsername;
        document.getElementById('profile-level').innerText = data.level; // Account rank (from class levels)
        document.getElementById('profile-wins').innerText = data.wins;
        document.getElementById('profile-losses').innerText = data.losses;

        const roster = sumRosterXpProgress(data.classes);
        document.getElementById('profile-xp-fill').style.width = `${roster.pct}%`;
        document.getElementById('profile-xp-text').innerText = `${roster.sumXp} / ${roster.sumNeed}`;

        // Update BP badge on main menu if exists
        const bpBadge = document.getElementById('bp-account-level-button');
        if (bpBadge) bpBadge.innerText = `Rank ${data.level}`;

        syncMainMenuHeaderProfile(data);

        // Render match history
        updateMatchHistoryUI(data.matchHistory);
    } catch (e) { console.error('Profile fetch failed', e); }
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
    document.getElementById('profile-wins').innerText = data.wins;
    document.getElementById('profile-losses').innerText = data.losses;

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
let selectedCharacterIndex = 0;
let playerProfileData = null; // Full data from backend
fetchPlayerProfile();
syncMainMenuHeaderProfile({ username: myUsername, level: 1 });

let currentPreviewCharId = 'aegisKnight';
let currentSkinIndex = 0;

const BP_REWARDS = {
    2: { type: 'emote', id: 'hype', name: '🎈 Hype' },
    3: { type: 'skin', id: 'verdant', name: 'Verdant' },
    5: { type: 'title', id: 'warrior', name: 'Warrior' },
    10: { type: 'skin', id: 'abyssal', name: 'Abyssal' },
    15: { type: 'title', id: 'grandmaster', name: 'Grandmaster' },
    20: { type: 'skin', id: 'legend', name: 'Lumen Legend' }
};

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
const CHARACTER_TEXTURE_KEYS_FOR_KNOCKOUT = ['voidWeaver', 'voidWeaver_green', 'aegisKnight', 'lumenSage'];

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

/** void_weaver_green.png is often exported at a different resolution than void_weaver.png */
function voidWeaverTextureScaleFactor(scene, textureKey) {
    if (textureKey !== 'voidWeaver_green') return 1;
    if (!scene || !scene.textures.exists('voidWeaver') || !scene.textures.exists('voidWeaver_green')) return 1;
    const base = getTextureSourceImage(scene.textures.get('voidWeaver'));
    const grn = getTextureSourceImage(scene.textures.get('voidWeaver_green'));
    if (!base || !grn) return 1;
    const bw = base.naturalWidth || base.width;
    const bh = base.naturalHeight || base.height;
    const gw = grn.naturalWidth || grn.width;
    const gh = grn.naturalHeight || grn.height;
    if (!bw || !bh || !gw || !gh) return 1;
    return Math.min(bw / gw, bh / gh);
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
        playerLeftShape.setScale(cfg.leftBase * voidWeaverTextureScaleFactor(scene, playerLeftShape.texture.key)).setFlipX(false);
        playerRightShape.setScale(cfg.rightBase * voidWeaverTextureScaleFactor(scene, playerRightShape.texture.key)).setFlipX(true);
    } else {
        playerLeftShape.setScale(cfg.leftBase * voidWeaverTextureScaleFactor(scene, playerLeftShape.texture.key)).setFlipX(false);
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
    this.load.image('aegisKnight', 'assets/aegis_knight.png?v=2');
    this.load.image('lumenSage', 'assets/lumen_sage.png?v=2');
}

let playerLeftShape;
let playerRightShape;
let phaserLayoutBattleMode = false;

function menuHeroTextureKey(charId) {
    let key = charId;
    const skin = playerProfileData && playerProfileData.equippedSkins && playerProfileData.equippedSkins[charId];
    if (skin === 'Verdant' && charId === 'voidWeaver') key = 'voidWeaver_green';
    return key;
}

function availableSkinsForChar(charId) {
    const skins = ['Default'];
    const lvl = playerProfileData ? playerProfileData.level : 1;
    if (charId === 'voidWeaver' && lvl >= 3) skins.push('Verdant');
    if (charId === 'voidWeaver' && lvl >= 10) skins.push('Abyssal');
    if (charId === 'voidWeaver' && lvl >= 20) skins.push('Lumen Legend');
    return skins;
}

function setHeroSelectSkinOptions(charId, preferredSkin) {
    const sel = document.getElementById('hero-select-skin');
    if (!sel) return;
    const skins = availableSkinsForChar(charId);
    sel.innerHTML = '';
    skins.forEach((skin) => {
        const opt = document.createElement('option');
        opt.value = skin;
        opt.innerText = skin;
        sel.appendChild(opt);
    });
    sel.value = skins.includes(preferredSkin) ? preferredSkin : skins[0];
    heroSelectPick.skin = sel.value;
}

function sendHeroSelectPick() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
        action: 'hero_select_pick',
        charId: heroSelectPick.charId,
        skin: heroSelectPick.skin
    }));
}

function sendHeroSelectReady() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
        action: 'hero_select_ready',
        charId: heroSelectPick.charId,
        skin: heroSelectPick.skin
    }));
}

function updateHeroSelectCardClasses() {
    document.querySelectorAll('.hero-select-card').forEach((card) => {
        card.classList.toggle('is-selected', card.getAttribute('data-hero-char') === heroSelectPick.charId);
        card.disabled = heroSelectLocked;
    });
}

function syncHeroSelectUIFromState() {
    const overlay = document.getElementById('hero-select-overlay');
    if (!overlay) return;
    const active = gameState && gameState.status === 'HERO_SELECT';
    overlay.classList.toggle('hidden', !active);
    if (!active || !myPlayerId || !gameState.heroSelect) return;

    const myEntry = gameState.heroSelect.players ? gameState.heroSelect.players[myPlayerId] : null;
    const oppId = myPlayerId === 'p1' ? 'p2' : 'p1';
    const oppEntry = gameState.heroSelect.players ? gameState.heroSelect.players[oppId] : null;
    if (myEntry) {
        heroSelectPick.charId = myEntry.charId || heroSelectPick.charId;
        heroSelectPick.skin = myEntry.skin || heroSelectPick.skin;
        heroSelectLocked = !!myEntry.ready;
    }
    setHeroSelectSkinOptions(heroSelectPick.charId, heroSelectPick.skin);
    updateHeroSelectCardClasses();
    document.getElementById('hero-select-skin').disabled = heroSelectLocked;
    document.getElementById('btn-hero-select-ready').disabled = heroSelectLocked;
    document.getElementById('hero-ready-status').innerText =
        `You: ${myEntry && myEntry.ready ? 'Locked' : 'Picking'} | Opponent: ${oppEntry && oppEntry.ready ? 'Locked' : 'Picking'}`;

    heroSelectCountdownUntil = gameState.heroSelect.deadline || 0;
    if (heroSelectCountdownTimer) clearInterval(heroSelectCountdownTimer);
    heroSelectCountdownTimer = setInterval(() => {
        if (!gameState || gameState.status !== 'HERO_SELECT') {
            clearInterval(heroSelectCountdownTimer);
            heroSelectCountdownTimer = null;
            return;
        }
        const ms = Math.max(0, heroSelectCountdownUntil - Date.now());
        document.getElementById('hero-select-timer').innerText = `${Math.ceil(ms / 1000)}s`;
    }, 200);
    reportPresenceIfChanged(true);
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
        playerLeftShape.setPosition(cw * 0.25, spriteY);
        playerRightShape.setPosition(cw * 0.75, spriteY);
    } else {
        playerRightShape.setVisible(false);
        const narrowPortrait = document.documentElement.classList.contains('layout-portrait') && cw < 900;
        const spriteX = narrowPortrait ? cw * 0.5 : cw * 0.4;
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

    refreshPhaserCharacterLayout();

    // Tweens for idle breathing effect
    this.tweens.add({
        targets: [playerLeftShape, playerRightShape],
        y: '-=15',
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
    });

    // Connection is now triggered by the "Play" button, not on create()
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
        connectWebSocket(lastRoomId);
    }, delayMs);
}

function connectWebSocket(specificRoomId = null) {
    if (socket) {
        manualSocketClose = true;
        try {
            socket.onclose = null;
            socket.close();
        } catch(e) {}
    }
    manualSocketClose = false;
    if (specificRoomId) lastRoomId = specificRoomId;
    // Append chosen character class
    const charId = CHARACTER_CLASSES[selectedCharacterIndex].id;
    persistLastSelectedCharacterId(charId);
    // Connect to Node.js proxy to bypass Firewall issues on Windows
    let wsUrl = `ws://${window.location.hostname}:8083/play?char=${charId}&uid=${localUid}`;
    if (specificRoomId) {
        wsUrl += `&roomId=${specificRoomId}`;
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
            updateUI();
        }
        if (msg.type === 'HERO_SELECT_UPDATE' && gameState) {
            gameState.heroSelect = msg.heroSelect;
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
            connectWebSocket();
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
    if (gameState && gameState.status !== 'GAME_OVER') {
        hideVictorySplashForActiveMatch();
    }

    // Hide Main Menu and ALL modals if game started
    if (gameState.status === 'IN_PROGRESS') {
        document.getElementById('matchmaking-overlay').classList.add('hidden');
        document.getElementById('hero-select-overlay').classList.add('hidden');
        document.getElementById('main-menu-container').classList.add('hidden');
        
        // Hide every modal just in case
        ['play-mode-modal', 'private-match-container', 'social-container', 'profile-container', 'character-menu-container', 'leaderboard-container', 'changelog-modal', 'settings-container'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });

        document.getElementById('ui-container').classList.remove('hidden');
        document.getElementById('emote-bar').classList.remove('hidden');
        renderEmoteBar();
    } else if (gameState.status === 'HERO_SELECT' && myPlayerId) {
        document.getElementById('matchmaking-overlay').classList.add('hidden');
        document.getElementById('main-menu-container').classList.add('hidden');
        document.getElementById('ui-container').classList.add('hidden');
        document.getElementById('ability-bar').classList.add('hidden');
        document.getElementById('emote-bar').classList.add('hidden');
        syncHeroSelectUIFromState();
    } else if (gameState.status === 'WAITING_FOR_PLAYERS' && myPlayerId) {
        // We connected but are waiting
        document.getElementById('hero-select-overlay').classList.add('hidden');
        document.getElementById('matchmaking-text').innerText = "Waiting for Opponent...";
        document.getElementById('ui-container').classList.add('hidden');
    }

    // Update Health Bars & Animations
    if (gameState.status === 'IN_PROGRESS' && myPlayerId) {
        if (!matchStats.active) resetMatchStats();
        const opponentId = myPlayerId === 'p1' ? 'p2' : 'p1';

        const myPlayer = gameState.players[myPlayerId];
        const oppPlayer = gameState.players[opponentId];

        // Self (Left)
        const myHpPct = (myPlayer.health / myPlayer.maxHealth) * 100;
        document.getElementById('hp-left').style.width = `${Math.max(0, myHpPct)}%`;

        document.getElementById('name-left').innerText = `${myUsername} (${myPlayer.class})`;
        if (playerLeftShape && myPlayer.classId) {
            let textureKey = myPlayer.classId;
            if (myPlayer.equippedSkin === 'Verdant' && myPlayer.classId === 'voidWeaver') textureKey = 'voidWeaver_green';
            if (playerLeftShape.active && playerLeftShape.texture.key !== textureKey) {
                playerLeftShape.setTexture(textureKey);
                applyPhaserCharacterScales(playerLeftShape.scene);
            }
        }

        if (prevMyHealth !== -1 && myPlayer.health < prevMyHealth && playerLeftShape && playerLeftShape.active && game && game.scene) {
            matchStats.damageTaken += (prevMyHealth - myPlayer.health);
            const scene = game.scene.scenes[0];
            if (scene) {
                triggerDamageFeedback(scene, playerLeftShape, playerRightShape, '+=10', '-=50');
            }
            sfx.playHit();
        }
        prevMyHealth = myPlayer.health;

        // Opponent (Right)
        const oppHpPct = (oppPlayer.health / oppPlayer.maxHealth) * 100;
        document.getElementById('hp-right').style.width = `${Math.max(0, oppHpPct)}%`;

        document.getElementById('name-right').innerText = `${oppPlayer.username || 'Opponent'} (${oppPlayer.class})`;
        if (playerRightShape && oppPlayer.classId) {
            let textureKey = oppPlayer.classId;
            if (oppPlayer.equippedSkin === 'Verdant' && oppPlayer.classId === 'voidWeaver') textureKey = 'voidWeaver_green';
            if (playerRightShape.active && playerRightShape.texture.key !== textureKey) {
                playerRightShape.setTexture(textureKey);
                applyPhaserCharacterScales(playerRightShape.scene);
            }
        }

        if (prevOpponentHealth !== -1 && oppPlayer.health < prevOpponentHealth && playerRightShape && playerRightShape.active && game && game.scene) {
            matchStats.damageDealt += (prevOpponentHealth - oppPlayer.health);
            const scene = game.scene.scenes[0];
            if (scene) {
                triggerDamageFeedback(scene, playerRightShape, playerLeftShape, '-=10', '+=50');
            }
            sfx.playHit();
        }
        prevOpponentHealth = oppPlayer.health;

        if (lastTurnSnapshot !== null && lastTurnSnapshot !== gameState.turn) {
            matchStats.turnSwaps += 1;
        }
        lastTurnSnapshot = gameState.turn;
    }

    if (gameState.status === 'WAITING_FOR_PLAYERS') {
        document.getElementById('status-message').innerText = "Waiting for opponent...";
        document.getElementById('turn-timer').classList.add('hidden');
        document.querySelectorAll('.ability-btn').forEach(b => b.disabled = true);
    } else if (gameState.status === 'HERO_SELECT') {
        document.getElementById('status-message').innerText = "Hero Select";
        document.getElementById('turn-timer').classList.add('hidden');
        document.getElementById('ability-bar').classList.add('hidden');
        document.querySelectorAll('.ability-btn').forEach(b => b.disabled = true);
    } else if (gameState.status === 'IN_PROGRESS') {
        const isMyTurn = (myPlayerId === 'p1' && gameState.turn === 0) || (myPlayerId === 'p2' && gameState.turn === 1);
        
        document.getElementById('status-message').innerText = isMyTurn ? "Your Turn!" : "Opponent's Turn...";
        
        document.getElementById('ability-bar').classList.remove('hidden');
        document.getElementById('btn-return').classList.add('hidden');

        // Update ability buttons
        const myPlayer = gameState.players[myPlayerId];
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

        // Update status indicators (shield/dodge badges)
        const oppId = myPlayerId === 'p1' ? 'p2' : 'p1';
        function renderStatusBadges(player, elId) {
            const el = document.getElementById(elId);
            el.innerHTML = '';
            if (player.shield && player.shield.active) {
                el.innerHTML += `<span class="status-badge shield">🛡 ${player.shield.percent}%</span>`;
            }
            if (player.dodge) {
                el.innerHTML += `<span class="status-badge dodge">⚡ Dodge</span>`;
            }
        }
        if (myPlayer) renderStatusBadges(myPlayer, 'status-left');
        if (gameState.players[oppId]) renderStatusBadges(gameState.players[oppId], 'status-right');

        // Turn timer
        if (gameState.turnDeadline) {
            document.getElementById('turn-timer').classList.remove('hidden');
            updateTurnTimer();
        }

        // Highlight active player HUD
        document.getElementById('hud-left').classList.toggle('active-turn', isMyTurn);
        document.getElementById('hud-right').classList.toggle('active-turn', !isMyTurn);
    } else if (gameState.status === 'GAME_OVER') {
        let winnerMsg = "Game Over - Draw";
        const me = gameState.players[myPlayerId];
        const opp = gameState.players[myPlayerId === 'p1' ? 'p2' : 'p1'];
        if (me && opp) {
            if (me.health > 0 && opp.health <= 0) winnerMsg = "You Win!";
            if (opp.health > 0 && me.health <= 0) winnerMsg = "You Lose!";
        }

        document.getElementById('status-message').innerText = winnerMsg;
        document.getElementById('ability-bar').classList.add('hidden');
        document.getElementById('emote-bar').classList.add('hidden');
        document.getElementById('turn-timer').classList.add('hidden');

        // Trigger XP Splash once
        if (me && me.postGame && !document.getElementById('xp-splash-overlay').classList.contains('active-showing')) {
            const won = me.health > 0;
            // The active-showing class ensures we only trigger this ONCE per game completion
            document.getElementById('xp-splash-overlay').classList.add('active-showing');
            
            // GO NUCLEAR: Clear game to prevent click interception
            destroyGame();
            
            showXPSplash(won, me.postGame);
        }

        // Play game-over sound once
        if (me && opp && !document.getElementById('xp-splash-overlay').classList.contains('active-showing')) {
            const iWon = me.health > 0 && opp.health <= 0;
            sfx.playGameOver(iWon);
        }
    } else {
        // If not game over, ensure splash is hidden (rematch started or quit)
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

document.getElementById('btn-quick-match').addEventListener('click', () => {
    document.getElementById('play-mode-modal').classList.add('hidden');
    document.getElementById('matchmaking-overlay').classList.remove('hidden');
    document.getElementById('matchmaking-text').innerText = "Connecting to Server...";
    reportPresenceIfChanged(true);
    connectWebSocket();
});

document.getElementById('btn-private-choice').addEventListener('click', () => {
    document.getElementById('play-mode-modal').classList.add('hidden');
    document.getElementById('private-match-container').classList.remove('hidden');
    reportPresenceIfChanged(true);
});

document.querySelectorAll('.hero-select-card').forEach((card) => {
    card.addEventListener('click', () => {
        if (heroSelectLocked) return;
        heroSelectPick.charId = card.getAttribute('data-hero-char') || 'voidWeaver';
        setHeroSelectSkinOptions(heroSelectPick.charId, 'Default');
        updateHeroSelectCardClasses();
        sendHeroSelectPick();
    });
});

document.getElementById('hero-select-skin').addEventListener('change', (e) => {
    if (heroSelectLocked) return;
    heroSelectPick.skin = e.target.value || 'Default';
    sendHeroSelectPick();
});

document.getElementById('btn-hero-select-ready').addEventListener('click', () => {
    if (heroSelectLocked) return;
    heroSelectLocked = true;
    updateHeroSelectCardClasses();
    sendHeroSelectReady();
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

document.getElementById('btn-save-customization').addEventListener('click', () => {
    saveCustomization();
});

function updateMenuCharacterDisplay() {
    const char = CHARACTER_CLASSES[selectedCharacterIndex];
    if (!char) return;
    document.getElementById('menu-char-name').innerText = char.name;
    document.getElementById('menu-char-stats').innerHTML = char.stats;

    if (playerProfileData && playerProfileData.classes[char.id]) {
        const pClass = playerProfileData.classes[char.id];
        document.getElementById('menu-char-name').innerText = `${char.name} (Lv. ${pClass.level})`;
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

// Social Button
document.getElementById('btn-social').addEventListener('click', () => {
    document.getElementById('social-container').classList.remove('hidden');
    fetchFriends();
});

document.getElementById('btn-close-social').addEventListener('click', () => {
    document.getElementById('social-container').classList.add('hidden');
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
    try {
        const res = await fetch(`/friends-status?uid=${localUid}`);
        const data = await res.json();
        updateSocialUI(data);
    } catch (e) {}
}

function updateSocialUI(data) {
    if (!data) return;
    lastSocialSnapshot = data;
    const friends = data.friends || [];
    const requests = data.requests || [];
    const duelInvites = data.duelInvites || [];
    
    document.getElementById('friends-count').innerText = `${friends.length}/100`;

    // Update notification dot (friend requests + duel invites)
    const dot = document.getElementById('social-dot');
    if (requests.length > 0 || duelInvites.length > 0) dot.classList.remove('hidden');
    else dot.classList.add('hidden');

    refreshMenuActivityBadge(data);

    const duelToast = document.getElementById('menu-duel-invite-toast');
    if (duelToast) {
        if (duelInvites.length > 0) {
            duelToast.classList.remove('hidden');
            const t = duelToast.querySelector('.menu-duel-invite-toast-text');
            if (t) t.textContent = duelInvites.length === 1 ? 'You have a duel invite from a friend.' : `You have ${duelInvites.length} duel invites.`;
        } else {
            duelToast.classList.add('hidden');
        }
    }

    if (menuActivityPopoverOpen) renderMenuActivityPopoverBody();

    // Only update the list if the container is open
    const isSocialOpen = !document.getElementById('social-container').classList.contains('hidden');
    if (!isSocialOpen) return;

    const list = document.getElementById('friends-list');
    let html = '';

    if (duelInvites.length > 0) {
        html += `<div style="background: rgba(255, 200, 120, 0.08); padding: 10px; font-weight: bold; font-size: 0.9rem; color: #ffcc80; margin-bottom: 5px;">Duel invites (${duelInvites.length})</div>`;
        duelInvites.forEach((d) => {
            html += `
                <div style="padding: 10px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: space-between; background: rgba(255, 180, 80, 0.06);">
                    <div>
                        <div style="font-weight: bold; color: #eee;">${d.fromUsername}</div>
                        <div style="font-size: 0.75rem; color: #888;">Private match · code ${d.code}</div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button onclick="acceptDuelInvite('${d.fromUid}')" style="background: #00ffcc; border: none; color: #000; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer; font-weight: bold;">Accept</button>
                        <button onclick="declineDuelInvite('${d.fromUid}')" style="background: #444; border: none; color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer;">Decline</button>
                    </div>
                </div>
            `;
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
    if (friends.length === 0 && requests.length === 0 && duelInvites.length === 0) {
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
                        <button type="button" onclick="challengeFriend('${f.uid}')" style="background: rgba(0, 210, 255, 0.2); border: 1px solid rgba(0, 210, 255, 0.45); color: #9ef0ff; border-radius: 4px; padding: 4px 10px; font-size: 0.75rem; cursor: pointer; font-weight: bold;">Challenge</button>
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

window.challengeFriend = async (targetUid) => {
    try {
        const res = await fetch('/friend-duel-invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, targetUid })
        });
        const data = await parseJsonResponse(res);
        if (data.ok && data.roomId) {
            document.getElementById('social-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
            document.getElementById('matchmaking-text').innerText = 'Waiting for friend to join...';
            reportPresenceIfChanged(true);
            connectWebSocket(data.roomId);
            fetchFriends(true);
        } else {
            alert(data.error || 'Could not send challenge');
        }
    } catch (e) {
        alert(e.message || 'Connection error');
    }
};

window.acceptDuelInvite = async (fromUid) => {
    try {
        const res = await fetch('/friend-duel-accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, fromUid })
        });
        const data = await parseJsonResponse(res);
        if (data.ok && data.roomId) {
            document.getElementById('social-container').classList.add('hidden');
            document.getElementById('matchmaking-overlay').classList.remove('hidden');
            document.getElementById('matchmaking-text').innerText = 'Joining private match...';
            reportPresenceIfChanged(true);
            connectWebSocket(data.roomId);
            fetchFriends(true);
        } else {
            alert(data.error || 'Invite is no longer valid');
            fetchFriends();
        }
    } catch (e) {
        alert(e.message || 'Could not accept invite');
        fetchFriends();
    }
};

window.declineDuelInvite = async (fromUid) => {
    try {
        await fetch('/friend-duel-decline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: localUid, fromUid })
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

// Ability bar click handler
document.querySelectorAll('.ability-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            const idx = parseInt(btn.dataset.index);
            socket.send(JSON.stringify({ action: 'ability', abilityIndex: idx }));
            if (matchStats.active) matchStats.abilitiesUsed += 1;
            sfx.playAttack();
            // Quick attack animation
            if (playerLeftShape && idx <= 1) {
                game.scene.scenes[0].tweens.add({
                    targets: playerLeftShape,
                    x: playerLeftShape.x + 50,
                    duration: 100,
                    yoyo: true
                });
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
            const res = await fetch(`http://${window.location.hostname}:8083/changelog`);
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
    rankEl.innerText = playerProfileData.level;
    
    track.innerHTML = '';
    // Generate nodes for levels 1-20
    const accLevel = Math.max(1, Number(playerProfileData.level) || 1);
    for (let i = 1; i <= 20; i++) {
        const node = document.createElement('div');
        node.className = 'bp-node';
        if (i <= accLevel) node.classList.add('unlocked');
        if (i === Math.min(20, accLevel)) node.classList.add('current');
        
        const reward = BP_REWARDS[i];
        let icon = '🔒';
        let name = 'Empty';
        
        if (reward) {
            icon = reward.type === 'emote' ? reward.id : (reward.type === 'title' ? '📜' : '🎨');
            if (reward.id === 'hype') icon = '🎈';
            name = reward.name;
        } else if (i === 1) {
            icon = '🌱';
            name = 'Start';
        }

        node.innerHTML = `
            <div class="lvl">Lvl ${i}</div>
            <div class="reward-icon">${icon}</div>
            <div class="reward-name">${name}</div>
        `;
        track.appendChild(node);
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
    
    // Fill Titles Select
    const titleSelect = document.getElementById('select-title');
    titleSelect.innerHTML = '<option value="">No Title</option>';
    (playerProfileData.unlockedTitles || []).forEach(title => {
        const opt = document.createElement('option');
        opt.value = title;
        opt.innerText = title;
        if (playerProfileData.equippedTitle === title) opt.selected = true;
        titleSelect.appendChild(opt);
    });

    // Skin Selector Logic
    updateSkinPreview();

    document.getElementById('character-preview-modal').classList.remove('hidden');
    sfx.playClick();
}

function updateSkinPreview() {
    const skins = availableSkinsForChar(currentPreviewCharId);
    
    const equipped = playerProfileData.equippedSkins[currentPreviewCharId] || 'Default';
    currentSkinIndex = skins.indexOf(equipped);
    if (currentSkinIndex === -1) currentSkinIndex = 0;

    document.getElementById('current-skin-name').innerText = skins[currentSkinIndex];
    refreshCharacterPreviewImg();
}

function nextSkin() {
    const skins = availableSkinsForChar(currentPreviewCharId);
    currentSkinIndex = (currentSkinIndex + 1) % skins.length;
    document.getElementById('current-skin-name').innerText = skins[currentSkinIndex];
    refreshCharacterPreviewImg();
}

function prevSkin() {
    const skins = availableSkinsForChar(currentPreviewCharId);
    currentSkinIndex = (currentSkinIndex - 1 + skins.length) % skins.length;
    document.getElementById('current-skin-name').innerText = skins[currentSkinIndex];
    refreshCharacterPreviewImg();
}

async function saveCustomization() {
    const title = document.getElementById('select-title').value;
    const skinName = document.getElementById('current-skin-name').innerText;
    
    try {
        const res = await fetch('/save-customization', {
            method: 'POST',
            body: JSON.stringify({
                uid: localUid,
                equippedTitle: title,
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
    
    const splash = document.getElementById('xp-splash-overlay');
    const title = document.getElementById('splash-title');
    const levelEl = document.getElementById('splash-level');
    const xpGainedEl = document.getElementById('splash-xp-gained');
    const xpFill = document.getElementById('splash-xp-fill');
    const xpDetails = document.getElementById('splash-xp-details');
    const lvlBurst = document.getElementById('level-up-burst');
    
    const bpRankEl = document.getElementById('bp-splash-rank');
    const bpFill = document.getElementById('bp-splash-fill');
    const bpDetails = document.getElementById('bp-splash-details');
    const bpXpGained = document.getElementById('bp-splash-xp-gained');
    const statDealt = document.getElementById('splash-stat-dmg-dealt');
    const statTaken = document.getElementById('splash-stat-dmg-taken');
    const statAbilities = document.getElementById('splash-stat-abilities');
    const statTurns = document.getElementById('splash-stat-turns');

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
    } else {
        title.innerText = won ? 'VICTORY' : 'DEFEAT';
        title.style.color = won ? '#00d2ff' : '#ff0055';
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

    if (statDealt) statDealt.innerText = String(Math.max(0, Math.round(matchStats.damageDealt || 0)));
    if (statTaken) statTaken.innerText = String(Math.max(0, Math.round(matchStats.damageTaken || 0)));
    if (statAbilities) statAbilities.innerText = String(Math.max(0, Math.round(matchStats.abilitiesUsed || 0)));
    if (statTurns) statTurns.innerText = String(Math.max(0, Math.round(matchStats.turnSwaps || 0)));

    // Data handling with defensive aliases
    try {
        const classId = pg.lastMatchClassId || pg.classId || 'voidWeaver';
        console.log("Target ClassId:", classId);
        
        const charData = (pg.classes && pg.classes[classId]) || 
                         (pg.classes && pg.classes['aegisKnight']) || 
                         { level: 1, xp: 0 };
        
        console.log("Target CharData:", charData);
        
        const charLevel = charData.level || 1;
        const charXp = (charData.xp !== undefined) ? charData.xp : 0;
        const xpGained = pg.xpGained || (won ? 50 : 10);
        const charNeed = Math.max(100, charLevel * 100);
        const endCharPct = classLevelProgress(charData).pct;
        const preClassXp = Math.max(0, charXp - xpGained);
        const startCharPct = charNeed > 0 ? Math.min(100, Math.max(0, (preClassXp / charNeed) * 100)) : 0;
        const charName = CHARACTER_CLASSES.find((x) => x.id === classId)?.name || 'Class';

        console.log("Calculated: Level", charLevel, "XP", charXp, "Gained", xpGained);

        xpGainedEl.innerText = xpGained;
        levelEl.innerText = pg.leveledUp ? Math.max(1, charLevel - 1) : charLevel;

        bpRankEl.innerText = pg.level || 1;
        bpXpGained.innerText = `+${xpGained} XP (${charName})`;

        const rosterEnd = sumRosterXpProgress(pg.classes);
        const rosterStartPct = rosterPctAfterSubtractingClassXp(pg, classId, xpGained);

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
        document.getElementById('social-container').classList.remove('hidden');
        fetchFriends();
    });
}

(function initMenuActivityHub() {
    const popBody = document.getElementById('menu-activity-popover-body');
    if (popBody) {
        popBody.addEventListener('click', (e) => {
            const t = e.target.closest('.menu-activity-item');
            if (!t) return;
            closeMenuActivityPopover();
            document.getElementById('social-container').classList.remove('hidden');
            fetchFriends();
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
    ALL_EMOTES.forEach(emote => {
        const btn = document.createElement('button');
        btn.className = 'emote-pool-btn' + (activeEmotes.includes(emote) ? ' in-use' : '');
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
            sfx.playClick();
            // Advance to next slot
            editingSlot = (editingSlot + 1) % 4;
            renderEmotePresetsModal();
        });
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
 ['btn-play-game','btn-character','btn-leaderboard','btn-profile','btn-social','btn-settings',
  'btn-close-char-menu','btn-close-profile','btn-close-settings','btn-close-leaderboard',
  'btn-close-changelog','btn-view-changelog','btn-return','btn-disconnect-ok',
  'btn-quick-match','btn-private-choice','btn-close-play-mode','btn-close-private',
  'btn-host-choice','btn-join-choice','btn-submit-join','btn-rematch','btn-rematch-bo3','btn-splash-exit',
  'btn-duel-toast-social',
  'btn-menu-activity', 'btn-menu-activity-close',
  'btn-battle-pass', 'btn-emote-presets', 'btn-save-customization',
  'btn-perf-overlay', 'btn-a11y-large-text', 'btn-a11y-high-contrast', 'btn-a11y-hp-bars', 'btn-reduce-motion',
  'btn-menu-vfx', 'btn-camera-shake', 'btn-hit-stop'].forEach(id => {
     const el = document.getElementById(id);
     if (el) el.addEventListener('click', () => sfx.playClick(), true);
 });

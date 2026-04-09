const ALLOWED_ORIGINS = new Set([
	'https://warpgamestv.com',
	'https://www.warpgamestv.com'
]);

const rateLimitBuckets = new Map();

function corsHeaders(request, extra = {}) {
	const origin = request.headers.get('Origin');
	let allowedOrigin = 'https://warpgamestv.com';
	if (
		origin &&
		(ALLOWED_ORIGINS.has(origin) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
	) {
		allowedOrigin = origin;
	}
	return {
		...extra,
		'Access-Control-Allow-Origin': allowedOrigin,
		'Vary': 'Origin'
	};
}

function isRateLimited(key, limit, windowMs) {
	const now = Date.now();
	const bucket = rateLimitBuckets.get(key);
	if (!bucket || now > bucket.resetAt) {
		rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
		return false;
	}
	if (bucket.count >= limit) return true;
	bucket.count += 1;
	return false;
}

function normalizePlayCharId(raw) {
	if (raw == null || typeof raw !== 'string') return null;
	const key = raw.trim().toLowerCase().replace(/_/g, '');
	if (!key) return null;
	if (key === 'aegisknight' || key === 'knight') return 'aegisKnight';
	if (key === 'lumensage' || key === 'sage') return 'lumenSage';
	if (key === 'voidweaver') return 'voidWeaver';
	return null;
}

function normalizeGuildName(raw) {
	return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 32);
}

function normalizeGuildTag(raw) {
	return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

function sanitizeGuildSearchCode(raw) {
	return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

async function getGuildRegistry(env) {
	return env.GUILD_REGISTRY.get(env.GUILD_REGISTRY.idFromName('global-guilds'));
}

async function getGuildForUid(env, uid) {
	if (!uid) return null;
	const guilds = await getGuildRegistry(env);
	const res = await guilds.fetch(new Request(`http://internal/get-by-player?uid=${encodeURIComponent(uid)}`));
	if (!res.ok) return null;
	const data = await res.json();
	return data.guild || null;
}

function getAdminReportsSecret(env) {
	const s = env.ADMIN_REPORTS_SECRET;
	return typeof s === 'string' && s.length >= 16 ? s : null;
}

function adminSecretFromRequest(request) {
	const h = request.headers.get('X-Admin-Secret');
	if (h && h.trim()) return h.trim();
	const auth = request.headers.get('Authorization') || '';
	const m = auth.match(/^Bearer\s+(.+)$/i);
	if (m) return m[1].trim();
	return null;
}


/** Admin HTML is not static assets; avoid stale UI after deploys. */
const ADMIN_HTML_HEADERS = {
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store, no-cache, must-revalidate'
};
function escapeHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function escapeAttr(str) {
	return escapeHtml(str).replace(/'/g, '&#39;');
}

async function parseAdminSecretBody(request, configured) {
	let secretInput = adminSecretFromRequest(request);
	if (secretInput && secretInput === configured) return secretInput;
	try {
		const ct = (request.headers.get('Content-Type') || '').toLowerCase();
		if (ct.includes('application/json')) {
			const j = await request.json();
			secretInput = (j && j.secret) || '';
		} else {
			const form = await request.formData();
			secretInput = (form.get('secret') && String(form.get('secret'))) || '';
		}
	} catch (e) {
		secretInput = '';
	}
	return secretInput === configured ? secretInput : null;
}

async function lookupUsernameForUid(env, uid) {
	if (!uid) return null;
	const reg = env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global'));
	const res = await reg.fetch(new Request(`http://internal/lookup-name?uid=${encodeURIComponent(uid)}`));
	if (!res.ok) return null;
	const data = await res.json();
	return data.username || null;
}

async function resolveReportPlayerNames(env, reports) {
	const uids = new Set();
	for (const r of reports || []) {
		if (r.reporterUid) uids.add(r.reporterUid);
		if (r.reportedUid) uids.add(r.reportedUid);
	}
	const entries = await Promise.all(
		[...uids].map(async (uid) => {
			const name = await lookupUsernameForUid(env, uid);
			const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			const res = await p.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
			const data = await res.json();
			return [uid, { name, banned: !!data.banned, bannedUntil: data.bannedUntil || null }];
		})
	);
	return Object.fromEntries(entries);
}

async function removePlayerFromLeaderboard(env, uid) {
	const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName('global'));
	await lb.fetch(
		new Request('http://internal/remove-uid', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ uid })
		})
	);
}

async function performResetPlayer(env, uid) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	const pRes = await p.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
	const pData = await pRes.json();

	if (pData.username) {
		const reg = env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global'));
		await reg.fetch(new Request(`http://internal/release?uid=${encodeURIComponent(uid)}&name=${encodeURIComponent(pData.username)}`));
	}

	await p.fetch(new Request('http://internal/wipe'));
	await removePlayerFromLeaderboard(env, uid);
}

async function performBanPlayer(env, uid, hours = null) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	const until = hours ? Date.now() + (hours * 3600000) : '';
	await p.fetch(new Request(`http://internal/ban?until=${until}`, { method: 'POST' }));
}

async function performUnbanPlayer(env, uid) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	await p.fetch(new Request('http://internal/unban', { method: 'POST' }));
}

async function performAdjustStats(env, uid, adjustments) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	await p.fetch(new Request('http://internal/adjust-stats', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(adjustments)
	}));
}

async function runForKnownPlayers(env, players, handler, batchSize = 24) {
	const safePlayers = Array.isArray(players) ? players : [];
	let processed = 0;
	for (let i = 0; i < safePlayers.length; i += batchSize) {
		const batch = safePlayers.slice(i, i + batchSize);
		await Promise.all(
			batch.map(async (player) => {
				const uid = typeof player === 'string' ? player : String(player.uid || '').trim();
				if (!uid) return;
				await handler(uid);
				processed += 1;
			})
		);
	}
	return processed;
}

async function performResetUsername(env, uid) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	await p.fetch(new Request('http://internal/admin-reset-username', { method: 'POST' }));
}

async function performResetLevels(env, uid) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	await p.fetch(new Request('http://internal/admin-reset-levels', { method: 'POST' }));
}

async function performClearGuildMembership(env, uid) {
	if (!uid) return;
	const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
	await p.fetch(new Request('http://internal/admin-clear-guild', { method: 'POST' }));
}

function renderAdminNav(activeTab, embeddedSecret = '') {
	const items = [
		{ id: 'dashboard', href: '/admin', label: 'Dashboard' },
		{ id: 'players', href: '/admin/players', label: 'Players' },
		{ id: 'refresh', href: '/admin/refresh', label: 'Resets' },
		{ id: 'reports', href: '/admin/reports', label: 'Reports' },
		{ id: 'events', href: '/admin/events', label: 'Events' },
		{ id: 'flags', href: '/admin/flags', label: 'Flags' },
		{ id: 'announcements', href: '/admin/announcements', label: 'Announcements' }
	];
	return `<nav class="admin-nav">${items
		.map((item) => {
			const href = embeddedSecret ? `${item.href}?secret=${encodeURIComponent(embeddedSecret)}` : item.href;
			const cls = item.id === activeTab ? 'admin-tab admin-tab-active' : 'admin-tab';
			return `<a class="${cls}" href="${escapeAttr(href)}">${escapeHtml(item.label)}</a>`;
		})
		.join('')}</nav>`;
}

function renderAdminLoginCard(action, title, hint, buttonLabel, embeddedSecret = '') {
	if (embeddedSecret) {
		return `<form method="get" action="${escapeAttr(action)}" class="card card-thin inline row">
			<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
			<button type="submit" class="btn btn-muted">${escapeHtml(buttonLabel)}</button>
		</form>`;
	}
	return `<form method="post" action="${escapeAttr(action)}" class="card login-card">
		<div class="eyebrow">Protected Access</div>
		<h2 class="section-title section-title-lg">${escapeHtml(title)}</h2>
		<p class="hint hint-spaced">${escapeHtml(hint)}</p>
		<label class="field-block">
			<span class="lbl">Admin secret</span>
			<input type="password" name="secret" autocomplete="current-password" required>
		</label>
		<button type="submit" class="btn btn-primary">${escapeHtml(buttonLabel)}</button>
	</form>`;
}

const DEFAULT_FEATURE_FLAGS = {
	questsEnabled: true,
	shopEnabled: true,
	premiumEnabled: true,
	reportsEnabled: true,
	friendInvitesEnabled: true,
	casualQueueEnabled: true,
	rankedQueueEnabled: true,
	queue2v2Enabled: true,
	privateMatchesEnabled: true,
	partyModeEnabled: true
};

function normalizeFeatureFlags(raw) {
	const src = raw && typeof raw === 'object' ? raw : {};
	return {
		questsEnabled: src.questsEnabled !== false,
		shopEnabled: src.shopEnabled !== false,
		premiumEnabled: src.premiumEnabled !== false,
		reportsEnabled: src.reportsEnabled !== false,
		friendInvitesEnabled: src.friendInvitesEnabled !== false,
		casualQueueEnabled: src.casualQueueEnabled !== false,
		rankedQueueEnabled: src.rankedQueueEnabled !== false,
		queue2v2Enabled: src.queue2v2Enabled !== false,
		privateMatchesEnabled: src.privateMatchesEnabled !== false,
		partyModeEnabled: src.partyModeEnabled !== false
	};
}

const ADMIN_SHARED_CSS = `
:root{--bg0:#07101f;--bg1:#10192d;--bg2:#192743;--card:rgba(12,20,39,.78);--card-strong:rgba(18,28,54,.92);--stroke:rgba(146,176,255,.16);--stroke-strong:rgba(146,176,255,.28);--text:#edf4ff;--muted:#99abc9;--muted-strong:#bfd0ec;--accent:#5eead4;--accent-2:#60a5fa;--accent-3:#c084fc;--danger:#fca5a5;--warning:#fde68a;--ok:#86efac;--shadow:0 30px 90px rgba(0,0,0,.4);--radius:20px;--radius-sm:12px;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{color:var(--text);background:radial-gradient(1200px 700px at 10% -10%,rgba(96,165,250,.25),transparent 50%),radial-gradient(900px 600px at 100% 0%,rgba(192,132,252,.16),transparent 42%),radial-gradient(700px 500px at 50% 100%,rgba(94,234,212,.12),transparent 44%),linear-gradient(160deg,var(--bg0),var(--bg1) 44%,var(--bg2));line-height:1.45}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent 22%),repeating-linear-gradient(90deg,transparent 0,transparent 112px,rgba(255,255,255,.016) 112px,rgba(255,255,255,.016) 113px);opacity:.7}
a{color:inherit;text-decoration:none}
.wrap{max-width:1340px;margin:0 auto;padding:32px 22px 56px;position:relative;z-index:1}
.admin-shell{display:flex;flex-direction:column;gap:18px}
.admin-hero{position:relative;overflow:hidden;padding:26px 28px;border-radius:24px;border:1px solid var(--stroke-strong);background:linear-gradient(135deg,rgba(14,26,49,.96),rgba(17,28,53,.84));box-shadow:var(--shadow)}
.admin-hero::after{content:"";position:absolute;inset:auto -10% -30% auto;width:320px;height:320px;border-radius:50%;background:radial-gradient(circle,rgba(94,234,212,.22),transparent 62%);filter:blur(10px)}
.hero-top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;position:relative;z-index:1}
.hero-copy{max-width:760px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.2);color:var(--muted-strong);font-size:.75rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.hero-title{margin:12px 0 8px;font-size:2.1rem;line-height:1.05;letter-spacing:-.03em}
.hero-sub{margin:0;color:var(--muted);font-size:1rem;max-width:62ch}
.hero-meta{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.meta-chip,.pill{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);font-size:.8rem;color:var(--muted-strong)}
.meta-chip strong,.pill strong{color:var(--text)}
.admin-nav{display:flex;gap:10px;flex-wrap:wrap}
.admin-tab{padding:11px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:var(--muted);font-weight:700;letter-spacing:.01em;transition:.18s ease}
.admin-tab:hover{color:var(--text);background:rgba(255,255,255,.08);transform:translateY(-1px)}
.admin-tab-active{color:var(--text);background:linear-gradient(135deg,rgba(96,165,250,.2),rgba(94,234,212,.14));border-color:rgba(94,234,212,.28);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.banner{padding:13px 16px;border-radius:14px;font-size:.95rem;border:1px solid transparent}.banner-err{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.28);color:#fee2e2}.banner-ok{background:rgba(52,211,153,.1);border-color:rgba(52,211,153,.28);color:#dcfce7}
.admin-main{display:flex;flex-direction:column;gap:16px}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius);padding:22px 22px 20px;backdrop-filter:blur(14px);box-shadow:var(--shadow)}
.card-thin{padding:14px 16px}
.hero-card{background:linear-gradient(135deg,rgba(16,30,58,.92),rgba(13,20,36,.92));border-color:rgba(94,234,212,.14)}
.section-title{margin:0 0 12px;font-size:1.08rem;letter-spacing:-.02em}.section-title-lg{font-size:1.34rem}
.section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px}
.section-copy{max-width:60ch}
.hint{color:var(--muted);font-size:.93rem}.hint-spaced{margin:0 0 16px}.mono{font-family:ui-monospace,Consolas,monospace;font-size:.86em}
.lbl{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:6px;font-weight:700}
.field-block,.block,label{display:block}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.inline-form{display:inline-flex}
.grid{display:grid;gap:16px}.grid.cols-2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}.grid.cols-3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.kpi-card{position:relative;overflow:hidden;padding:18px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03))}
.kpi-card::before{content:"";position:absolute;inset:auto -20px -60px auto;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,rgba(96,165,250,.2),transparent 70%)}
.stat-val{display:block;font-size:1.8rem;font-weight:800;letter-spacing:-.03em;color:var(--text);margin-bottom:6px}
.kpi-trend{color:var(--accent);font-size:.82rem;font-weight:700}
.split-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(320px,.7fr);gap:16px}
.stack{display:flex;flex-direction:column;gap:16px}
.list{margin:0;padding-left:18px}.list li{margin:0 0 10px}
.info-list{display:grid;gap:10px}.info-item{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.05)}.info-item .value{color:var(--muted-strong);text-align:right}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 15px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:var(--text);font-weight:700;cursor:pointer;transition:.18s ease}
.btn:hover{background:rgba(255,255,255,.09);transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,rgba(96,165,250,.22),rgba(94,234,212,.16));border-color:rgba(94,234,212,.26)}
.btn-muted{background:rgba(255,255,255,.05)}
.btn-danger{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.28);color:#fee2e2}
.btn-ok{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.28);color:#dcfce7}
.btn-warn{background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.28);color:#fef3c7}
input[type=password],input[type=text],input[type=search],input[type=datetime-local],input[type=number],select,textarea{width:100%;padding:11px 12px;border-radius:12px;border:1px solid rgba(146,176,255,.16);background:rgba(4,10,22,.45);color:var(--text);font-size:.95rem;outline:none}
input:focus,select:focus,textarea:focus{border-color:rgba(94,234,212,.45);box-shadow:0 0 0 3px rgba(94,234,212,.12)}
textarea{resize:vertical;min-height:130px}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.field-span-full{grid-column:1 / -1}
.toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;padding:16px 18px;background:rgba(12,19,35,.78);border:1px solid var(--stroke);border-radius:18px}.toolbar .grow{flex:1;min-width:220px}
.row-count{color:var(--muted);font-size:.85rem;align-self:center}
.table-wrap{overflow:auto;border-radius:18px;border:1px solid var(--stroke);background:rgba(7,12,23,.72)}
table{width:100%;border-collapse:collapse;font-size:.9rem;min-width:900px}
thead th{text-align:left;padding:13px 12px;background:rgba(96,165,250,.14);font-weight:700;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;border-bottom:1px solid var(--stroke);position:sticky;top:0;z-index:1}
tbody td{padding:12px;border-bottom:1px solid rgba(146,176,255,.08);vertical-align:top}
tbody tr:hover{background:rgba(255,255,255,.03)}
.login-card{max-width:440px}
.flags-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.flag-card{display:flex;flex-direction:column;gap:14px;padding:18px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.025))}
.flag-copy{display:flex;flex-direction:column;gap:8px}.flag-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.flag-state{padding:5px 10px;border-radius:999px;font-size:.74rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border:1px solid rgba(255,255,255,.1)}.flag-state--enabled{color:#dcfce7;background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.28)}.flag-state--disabled{color:#fee2e2;background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.28)}
.flag-actions{display:flex;gap:10px;flex-wrap:wrap}
.announcement-preview{padding:18px;border-radius:18px;border:1px solid rgba(94,234,212,.24);background:linear-gradient(135deg,rgba(94,234,212,.12),rgba(96,165,250,.08));font-weight:700;line-height:1.5}
.announcement-preview-empty{border-style:dashed;color:var(--muted)}
.player-cell .un{display:block;font-weight:700;margin-top:4px;color:var(--text)}
.sm{font-size:.78rem;opacity:.85;display:block}.nowrap{white-space:nowrap}.details{max-width:420px;white-space:pre-wrap;word-break:break-word}.actions{min-width:190px}
.pill-ok{background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.28);color:#dcfce7}.pill-danger{background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.28);color:#fee2e2}
.lookup-card{display:none;margin-top:16px;border:1px solid rgba(94,234,212,.22);background:linear-gradient(180deg,rgba(18,31,59,.94),rgba(12,20,39,.92))}
.lookup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:16px}
.stat-box{background:rgba(255,255,255,.04);padding:14px;border-radius:16px;border:1px solid rgba(255,255,255,.06)}
.hidden{display:none}
@media (max-width:900px){.hero-top{flex-direction:column}.hero-meta{justify-content:flex-start}.split-grid{grid-template-columns:1fr}.wrap{padding:24px 16px 44px}}
`;

function renderAdminShell(opts = {}) {
	const title = opts.title || 'Lumen Clash Admin';
	const pageTitle = opts.pageTitle || title;
	const subtitle = opts.subtitle || '';
	const activeTab = opts.activeTab || 'dashboard';
	const embeddedSecret = opts.embeddedSecret || '';
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const bodyHtml = opts.bodyHtml || '';
	const heroMeta = opts.heroMeta || '';
	const errBlock = errorMsg ? `<div class="banner banner-err">${escapeHtml(errorMsg)}</div>` : '';
	const okBlock = successMsg ? `<div class="banner banner-ok">${escapeHtml(successMsg)}</div>` : '';
	const navHtml = embeddedSecret ? renderAdminNav(activeTab, embeddedSecret) : '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>${ADMIN_SHARED_CSS}</style>
</head>
<body>
<div class="wrap">
	<div class="admin-shell">
		<header class="admin-hero">
			<div class="hero-top">
				<div class="hero-copy">
					<div class="eyebrow">Lumen Clash Admin</div>
					<h1 class="hero-title">${escapeHtml(title)}</h1>
					<p class="hero-sub">${escapeHtml(subtitle)}</p>
				</div>
				<div class="hero-meta">${heroMeta}</div>
			</div>
			${navHtml}
		</header>
		<div class="admin-main">
			${errBlock}
			${okBlock}
			${bodyHtml}
		</div>
	</div>
</div>
</body>
</html>`;
}

function renderAdminDashboardPage(summary, opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const reports = summary.reports || [];
	const activeEvents = summary.activeEvents || [];
	const eventsCatalog = summary.eventsCatalog || [];
	const flags = normalizeFeatureFlags(summary.flags);
	const enabledFlags = Object.values(flags).filter(Boolean).length;
	const latestReports = reports
		.slice(0, 5)
		.map((r) => {
			const when = r.ts ? new Date(r.ts).toISOString() : 'Unknown time';
			return `<li><span class="mono">${escapeHtml(when)}</span> <strong>${escapeHtml(String(r.category || 'other'))}</strong> in room <span class="mono">${escapeHtml(
				String(r.roomId || 'n/a')
			)}</span></li>`;
		})
		.join('');
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const errBlock = errorMsg ? `<div class="banner banner-err">${escapeHtml(errorMsg)}</div>` : '';
	const okBlock = successMsg ? `<div class="banner banner-ok">${escapeHtml(successMsg)}</div>` : '';
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin', 'Admin Sign In', 'Enter your admin secret to open the admin dashboard.', 'Open dashboard')
		: `<div class="grid cols-3">
			<div class="card"><span class="lbl">Open reports</span><span class="stat-val">${reports.length}</span><p class="hint">Moderation queue waiting in <span class="mono">/admin/reports</span>.</p></div>
			<div class="card"><span class="lbl">Active events</span><span class="stat-val">${activeEvents.length}</span><p class="hint">${activeEvents.length ? escapeHtml(activeEvents.map((e) => e.name).join(' · ')) : 'No events are currently live.'}</p></div>
			<div class="card"><span class="lbl">Event catalog</span><span class="stat-val">${eventsCatalog.length}</span><p class="hint">Configured event windows and rewards.</p></div>
		</div>
		<div class="grid cols-2" style="margin-top:16px">
			<div class="card">
				<h2 class="section-title">Admin Areas</h2>
				<div class="row" style="margin-bottom:12px"><a class="btn btn-primary" href="/admin/reports?secret=${encodeURIComponent(
					embeddedSecret
				)}">Open Reports</a><a class="btn btn-primary" href="/admin/events?secret=${encodeURIComponent(embeddedSecret)}">Open Events</a><a class="btn btn-primary" href="/admin/flags?secret=${encodeURIComponent(embeddedSecret)}">Open Flags</a></div>
				<ul class="list">
					<li>Reports is your moderation desk for bans, resets, and dismissing reports.</li>
					<li>Events is your protected event overview and future live-ops workspace.</li>
					<li>This dashboard is the hub for future tabs like flags, players, and admin logs.</li>
				</ul>
			</div>
			<div class="card">
				<h2 class="section-title">System Snapshot</h2>
				<div class="row" style="margin-bottom:10px">
					<span class="pill ${flags.reportsEnabled ? 'pill-ok' : ''}">Reports ${flags.reportsEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.questsEnabled ? 'pill-ok' : ''}">Quests ${flags.questsEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.shopEnabled ? 'pill-ok' : ''}">Shop ${flags.shopEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.premiumEnabled ? 'pill-ok' : ''}">Premium ${flags.premiumEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.casualQueueEnabled ? 'pill-ok' : ''}">Casual ${flags.casualQueueEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.rankedQueueEnabled ? 'pill-ok' : ''}">Ranked ${flags.rankedQueueEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.queue2v2Enabled ? 'pill-ok' : ''}">2v2 ${flags.queue2v2Enabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.privateMatchesEnabled ? 'pill-ok' : ''}">Private ${flags.privateMatchesEnabled ? 'on' : 'off'}</span>
					<span class="pill ${flags.partyModeEnabled ? 'pill-ok' : ''}">Party ${flags.partyModeEnabled ? 'on' : 'off'}</span>
				</div>
				<p class="hint" style="margin:0">Use the Flags tab to flip core systems on or off without redeploying.</p>
			</div>
		</div>
		<div class="card" style="margin-top:16px">
			<h2 class="section-title">Recent Reports</h2>
			${latestReports ? `<ul class="list">${latestReports}</ul>` : '<p class="hint">No reports in the queue.</p>'}
		</div>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen Clash Admin</title>
<style>
:root{--bg0:#07051a;--bg1:#120b2e;--card:#151032e6;--stroke:#3d2f6b;--text:#ede9ff;--muted:#9b8fb8;--accent:#a78bfa;--accent2:#22d3ee;--danger:#f87171;--warn:#fbbf24;--ok:#34d399;--radius:12px;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(1200px 800px at 10% -10%,#2e1f5c 0%,transparent 50%),radial-gradient(900px 600px at 90% 30%,#0c3d4d 0%,transparent 45%),linear-gradient(165deg,var(--bg0),var(--bg1))}
a{color:inherit;text-decoration:none}.wrap{max-width:1280px;margin:0 auto;padding:28px 20px 48px}header{margin-bottom:20px}
header h1{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;background:linear-gradient(90deg,var(--text),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--muted);font-size:.95rem;margin:0}.card{background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius);padding:20px 22px;backdrop-filter:blur(10px);box-shadow:0 16px 50px rgba(0,0,0,.35)}.card.thin{padding:12px 16px;margin-bottom:16px}
.grid{display:grid;gap:16px}.grid.cols-2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.grid.cols-3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.95rem}.banner-err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#fecaca}.banner-ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35);color:#a7f3d0}
.lbl{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}.hint{color:var(--muted);font-size:.9rem}.mono{font-family:ui-monospace,monospace;font-size:.84em}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.05);color:var(--text);font-weight:600;cursor:pointer}.btn:hover{background:rgba(255,255,255,.1)}.btn-primary{background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.18));border-color:rgba(167,139,250,.45)}.btn-muted{background:rgba(255,255,255,.05)}
.admin-nav{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 24px}.admin-tab{padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:var(--muted);font-weight:600}.admin-tab:hover{color:var(--text);background:rgba(255,255,255,.08)}.admin-tab-active{color:var(--text);background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.16));border-color:rgba(167,139,250,.45)}
.stat-val{display:block;font-size:1.45rem;font-weight:700;color:var(--accent2)}.list{margin:0;padding-left:18px}.list li{margin:0 0 8px}.section-title{margin:0 0 10px;font-size:1.05rem}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);font-size:.78rem}.pill-ok{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.35);color:#a7f3d0}
input[type=password]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--stroke);background:rgba(0,0,0,.25);color:var(--text);font-size:.95rem}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Lumen Clash Admin</h1><p class="sub">Main control center for moderation, events, and future live ops tools.</p></header>
${embeddedSecret ? renderAdminNav('dashboard', embeddedSecret) : ''}
${errBlock}${okBlock}
${bodyHtml}
</div>
</body>
</html>`;
}

function renderAdminEventsPage(opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const activeEvents = opts.activeEvents || [];
	const eventsCatalog = opts.eventsCatalog || [];
	const activeIds = new Set(activeEvents.map((e) => e.id));
	const rowsHtml = eventsCatalog
		.map((ev) => {
			const isActive = activeIds.has(ev.id);
			const mode = ev.forceStopped ? 'Stopped' : ev.forceActive ? 'Forced Live' : isActive ? 'Scheduled Live' : 'Queued';
			const rewards = []
				.concat(ev.grantedTitles || [])
				.concat(ev.grantedCosmetics || [])
				.join(', ');
			const startText = Number.isFinite(ev.startMs) ? new Date(ev.startMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a';
			const endText = Number.isFinite(ev.endMs) ? new Date(ev.endMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a';
			const controls = embeddedSecret
				? `<div class="row">
					<form method="post" action="/admin/events" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="start_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-primary">Start</button></form>
					<form method="post" action="/admin/events" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="stop_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-muted">Stop</button></form>
					<form method="post" action="/admin/events" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="resume_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-muted">Resume Schedule</button></form>
					<form method="post" action="/admin/events" class="inline-form" onsubmit="return confirm('Delete this event?');"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="delete_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-danger">Delete</button></form>
				</div>`
				: '';
			return `<tr><td><strong>${escapeHtml(ev.name)}</strong><div class="hint mono">${escapeHtml(ev.id)}</div></td><td><span class="pill ${
				isActive ? 'pill-ok' : ''
			}">${escapeHtml(mode)}</span></td><td class="mono">${escapeHtml(startText)}</td><td class="mono">${escapeHtml(endText)}</td><td>${escapeHtml(
				rewards || 'No extra rewards'
			)}</td><td>${controls}</td></tr>`;
		})
		.join('');
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const errBlock = errorMsg ? `<div class="banner banner-err">${escapeHtml(errorMsg)}</div>` : '';
	const okBlock = successMsg ? `<div class="banner banner-ok">${escapeHtml(successMsg)}</div>` : '';
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/events', 'Admin Sign In', 'Enter your admin secret to inspect event configuration.', 'Open events')
		: `<div class="grid cols-2">
			<div class="card">
				<h2 class="section-title">Active Right Now</h2>
				${activeEvents.length ? `<ul class="list">${activeEvents
					.map((ev) => `<li><strong>${escapeHtml(ev.name)}</strong> is currently live.</li>`)
					.join('')}</ul>` : '<p class="hint">No events are active at the moment.</p>'}
			</div>
			<div class="card">
				<h2 class="section-title">How Event Controls Work</h2>
				<p class="hint" style="margin-top:0">Create an event here to queue it. You can then start it immediately, stop it manually, or return it to scheduled mode at any time.</p>
				<div class="row"><a class="btn btn-muted" href="/admin?secret=${encodeURIComponent(embeddedSecret)}">Back to dashboard</a><a class="btn btn-primary" href="/admin/reports?secret=${encodeURIComponent(
					embeddedSecret
				)}">Open reports</a></div>
			</div>
		</div>
		<div class="card" style="margin-top:16px">
			<h2 class="section-title">Queue New Event</h2>
			<form method="post" action="/admin/events" class="grid cols-2">
				<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
				<input type="hidden" name="action" value="create_event">
				<label><span class="lbl">Event ID</span><input type="text" name="eventId" placeholder="spring_flash_sale"></label>
				<label><span class="lbl">Event Name</span><input type="text" name="eventName" placeholder="Spring Flash Sale" required></label>
				<label><span class="lbl">Start (UTC)</span><input type="datetime-local" name="startAt" required></label>
				<label><span class="lbl">End (UTC)</span><input type="datetime-local" name="endAt" required></label>
				<label><span class="lbl">XP Multiplier</span><input type="number" step="0.05" min="0.1" name="xpMultiplier" value="1"></label>
				<label><span class="lbl">Lumen Multiplier</span><input type="number" step="0.05" min="0.1" name="lumenMultiplier" value="1"></label>
				<label><span class="lbl">Granted Titles</span><input type="text" name="grantedTitles" placeholder="Pioneer, Founder"></label>
				<label><span class="lbl">Granted Cosmetics</span><input type="text" name="grantedCosmetics" placeholder="Gold, emote_clown"></label>
				<div class="row" style="grid-column:1 / -1"><button type="submit" class="btn btn-primary">Queue Event</button></div>
			</form>
		</div>
		<div class="card" style="margin-top:16px">
			<h2 class="section-title">Configured Event Catalog</h2>
			<div style="overflow:auto;border-radius:var(--radius);border:1px solid var(--stroke);background:rgba(10,6,28,.65)">
				<table style="width:100%;border-collapse:collapse;font-size:.88rem;min-width:720px">
					<thead><tr><th style="text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em">Event</th><th style="text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em">Status</th><th style="text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em">Starts</th><th style="text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em">Ends</th><th style="text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em">Rewards</th><th style="text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em">Controls</th></tr></thead>
					<tbody>${rowsHtml || '<tr><td colspan="6" style="padding:10px">No events configured.</td></tr>'}</tbody>
				</table>
			</div>
		</div>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen Clash Admin - Events</title>
<style>
:root{--bg0:#07051a;--bg1:#120b2e;--card:#151032e6;--stroke:#3d2f6b;--text:#ede9ff;--muted:#9b8fb8;--accent:#a78bfa;--accent2:#22d3ee;--danger:#f87171;--ok:#34d399;--radius:12px;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(1200px 800px at 10% -10%,#2e1f5c 0%,transparent 50%),radial-gradient(900px 600px at 90% 30%,#0c3d4d 0%,transparent 45%),linear-gradient(165deg,var(--bg0),var(--bg1))}
a{color:inherit;text-decoration:none}.wrap{max-width:1280px;margin:0 auto;padding:28px 20px 48px}header{margin-bottom:20px}
header h1{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;background:linear-gradient(90deg,var(--text),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}.sub{color:var(--muted);font-size:.95rem;margin:0}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius);padding:20px 22px;backdrop-filter:blur(10px);box-shadow:0 16px 50px rgba(0,0,0,.35)}.grid{display:grid;gap:16px}.grid.cols-2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.95rem}.banner-err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#fecaca}.banner-ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35);color:#a7f3d0}
.lbl{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}.hint{color:var(--muted);font-size:.9rem}.mono{font-family:ui-monospace,monospace;font-size:.84em}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.05);color:var(--text);font-weight:600;cursor:pointer}.btn:hover{background:rgba(255,255,255,.1)}.btn-primary{background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.18));border-color:rgba(167,139,250,.45)}.btn-muted{background:rgba(255,255,255,.05)}.btn-danger{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.35);color:#fecaca}
.admin-nav{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 24px}.admin-tab{padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:var(--muted);font-weight:600}.admin-tab:hover{color:var(--text);background:rgba(255,255,255,.08)}.admin-tab-active{color:var(--text);background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.16));border-color:rgba(167,139,250,.45)}
.list{margin:0;padding-left:18px}.list li{margin:0 0 8px}.section-title{margin:0 0 10px;font-size:1.05rem}.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);font-size:.78rem}.pill-ok{background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.35);color:#a7f3d0}
input[type=password],input[type=text],input[type=datetime-local],input[type=number]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--stroke);background:rgba(0,0,0,.25);color:var(--text);font-size:.95rem}.inline-form{display:inline-flex}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Lumen Clash Admin</h1><p class="sub">Protected event overview and future live-ops workspace.</p></header>
${embeddedSecret ? renderAdminNav('events', embeddedSecret) : ''}
${errBlock}${okBlock}
${bodyHtml}
</div>
</body>
</html>`;
}

function renderAdminFlagsPage(opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const flags = normalizeFeatureFlags(opts.flags);
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const errBlock = errorMsg ? `<div class="banner banner-err">${escapeHtml(errorMsg)}</div>` : '';
	const okBlock = successMsg ? `<div class="banner banner-ok">${escapeHtml(successMsg)}</div>` : '';
	const toggle = (name, label, hint) => {
		const enabled = !!flags[name];
		return `<div class="flag-card">
			<div class="flag-copy">
				<div class="flag-head">
					<strong>${escapeHtml(label)}</strong>
					<span class="flag-state ${enabled ? 'flag-state--enabled' : 'flag-state--disabled'}">${enabled ? 'Enabled' : 'Disabled'}</span>
				</div>
				<div class="hint">${escapeHtml(hint)}</div>
			</div>
			<div class="flag-actions">
				<form method="post" action="/admin/flags" class="inline-form">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="flagName" value="${escapeAttr(name)}">
					<input type="hidden" name="flagValue" value="true">
					<button type="submit" class="btn ${enabled ? 'btn-primary' : 'btn-muted'}">Enable</button>
				</form>
				<form method="post" action="/admin/flags" class="inline-form">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="flagName" value="${escapeAttr(name)}">
					<input type="hidden" name="flagValue" value="false">
					<button type="submit" class="btn ${enabled ? 'btn-muted' : 'btn-danger'}">Disable</button>
				</form>
			</div>
		</div>`;
	};
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/flags', 'Admin Sign In', 'Enter your admin secret to manage feature flags.', 'Open flags')
		: `<div class="card">
			<h2 class="section-title">System Toggles</h2>
			<div class="flags-grid">
				${toggle('questsEnabled', 'Quests', 'Controls claiming and quest reward access.')}
				${toggle('shopEnabled', 'Shop', 'Controls in-game item purchases.')}
				${toggle('premiumEnabled', 'Premium Unlock', 'Controls Luminary Pass premium unlock purchases.')}
				${toggle('reportsEnabled', 'Player Reports', 'Controls report submission from the client.')}
				${toggle('friendInvitesEnabled', 'Friend Invites', 'Controls social invite sending.')}
				${toggle('casualQueueEnabled', 'Casual Queue', 'Controls entering the default casual matchmaking queue.')}
				${toggle('rankedQueueEnabled', 'Ranked Queue', 'Controls entering ranked matchmaking.')}
				${toggle('queue2v2Enabled', '2v2 Queue', 'Controls entering 2v2 matchmaking.')}
				${toggle('privateMatchesEnabled', 'Private Matches', 'Controls duel room creation and private code joins.')}
				${toggle('partyModeEnabled', 'Party Mode', 'Controls party invites and joining party lobbies.')}
			</div>
			<div class="row" style="margin-top:16px"><a class="btn btn-muted" href="/admin?secret=${encodeURIComponent(
				embeddedSecret
			)}">Back to dashboard</a></div>
		</div>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen Clash Admin - Flags</title>
<style>
:root{--bg0:#07051a;--bg1:#120b2e;--card:#151032e6;--stroke:#3d2f6b;--text:#ede9ff;--muted:#9b8fb8;--accent:#a78bfa;--accent2:#22d3ee;--danger:#f87171;--ok:#34d399;--radius:12px;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(1200px 800px at 10% -10%,#2e1f5c 0%,transparent 50%),radial-gradient(900px 600px at 90% 30%,#0c3d4d 0%,transparent 45%),linear-gradient(165deg,var(--bg0),var(--bg1))}
a{color:inherit;text-decoration:none}.wrap{max-width:1280px;margin:0 auto;padding:28px 20px 48px}header{margin-bottom:20px}
header h1{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;background:linear-gradient(90deg,var(--text),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}.sub{color:var(--muted);font-size:.95rem;margin:0}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius);padding:20px 22px;backdrop-filter:blur(10px);box-shadow:0 16px 50px rgba(0,0,0,.35)}.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.95rem}.banner-err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#fecaca}.banner-ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35);color:#a7f3d0}
.hint{color:var(--muted);font-size:.9rem}.lbl{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.05);color:var(--text);font-weight:600;cursor:pointer}.btn:hover{background:rgba(255,255,255,.1)}.btn-primary{background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.18));border-color:rgba(167,139,250,.45)}.btn-muted{background:rgba(255,255,255,.05)}.btn-danger{background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.35);color:#fecaca}
.admin-nav{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 24px}.admin-tab{padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:var(--muted);font-weight:600}.admin-tab:hover{color:var(--text);background:rgba(255,255,255,.08)}.admin-tab-active{color:var(--text);background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.16));border-color:rgba(167,139,250,.45)}
.flags-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.flag-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--stroke);border-radius:12px;background:rgba(255,255,255,.04)}.flag-copy{display:flex;flex-direction:column;gap:8px}.flag-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.flag-state{padding:4px 9px;border-radius:999px;font-size:.74rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid rgba(255,255,255,.1)}.flag-state--enabled{color:#a7f3d0;background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.35)}.flag-state--disabled{color:#fecaca;background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.35)}.flag-actions{display:flex;gap:10px;flex-wrap:wrap}.inline-form{display:inline-flex}
input[type=password]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--stroke);background:rgba(0,0,0,.25);color:var(--text);font-size:.95rem}.section-title{margin:0 0 12px;font-size:1.05rem}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Lumen Clash Admin</h1><p class="sub">Control live feature availability from one place.</p></header>
${embeddedSecret ? renderAdminNav('flags', embeddedSecret) : ''}
${errBlock}${okBlock}
${bodyHtml}
</div>
</body>
</html>`;
}

function renderAdminAnnouncementsPage(opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const announcement = opts.announcement || { message: '', active: false, updatedAt: null };
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const errBlock = errorMsg ? `<div class="banner banner-err">${escapeHtml(errorMsg)}</div>` : '';
	const okBlock = successMsg ? `<div class="banner banner-ok">${escapeHtml(successMsg)}</div>` : '';
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/announcements', 'Admin Sign In', 'Enter your admin secret to manage global announcements.', 'Open announcements')
		: `<div class="grid cols-2">
			<div class="card">
				<h2 class="section-title">Live Announcement</h2>
				<p class="hint" style="margin-top:0">This message appears as a scrolling marquee to connected players.</p>
				<div class="announcement-preview ${announcement.active && announcement.message ? '' : 'announcement-preview-empty'}">${escapeHtml(
					announcement.active && announcement.message ? announcement.message : 'No announcement is live right now.'
				)}</div>
				<p class="hint" style="margin-bottom:0">Last updated: ${announcement.updatedAt ? escapeHtml(new Date(announcement.updatedAt).toISOString()) : 'Never'}</p>
			</div>
			<div class="card">
				<h2 class="section-title">Publish Announcement</h2>
				<form method="post" action="/admin/announcements">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="action" value="publish">
					<label><span class="lbl">Message</span><textarea name="message" rows="5" maxlength="220" placeholder="Server maintenance at 8 PM UTC. Ranked queue will be disabled for 20 minutes.">${escapeHtml(
						announcement.active ? announcement.message || '' : ''
					)}</textarea></label>
					<div class="row" style="margin-top:16px"><button type="submit" class="btn btn-primary">Publish</button></div>
				</form>
				<form method="post" action="/admin/announcements" style="margin-top:12px" onsubmit="return confirm('Clear the live announcement?');">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="action" value="clear">
					<button type="submit" class="btn btn-muted">Clear Announcement</button>
				</form>
			</div>
		</div>`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen Clash Admin - Announcements</title>
<style>
:root{--bg0:#07051a;--bg1:#120b2e;--card:#151032e6;--stroke:#3d2f6b;--text:#ede9ff;--muted:#9b8fb8;--accent:#a78bfa;--accent2:#22d3ee;--danger:#f87171;--ok:#34d399;--radius:12px;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(1200px 800px at 10% -10%,#2e1f5c 0%,transparent 50%),radial-gradient(900px 600px at 90% 30%,#0c3d4d 0%,transparent 45%),linear-gradient(165deg,var(--bg0),var(--bg1))}
a{color:inherit;text-decoration:none}.wrap{max-width:1280px;margin:0 auto;padding:28px 20px 48px}header{margin-bottom:20px}
header h1{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;background:linear-gradient(90deg,var(--text),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}.sub{color:var(--muted);font-size:.95rem;margin:0}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius);padding:20px 22px;backdrop-filter:blur(10px);box-shadow:0 16px 50px rgba(0,0,0,.35)}.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.95rem}.banner-err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#fecaca}.banner-ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35);color:#a7f3d0}
.hint{color:var(--muted);font-size:.9rem}.lbl{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.05);color:var(--text);font-weight:600;cursor:pointer}.btn:hover{background:rgba(255,255,255,.1)}.btn-primary{background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.18));border-color:rgba(167,139,250,.45)}.btn-muted{background:rgba(255,255,255,.05)}
.admin-nav{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 24px}.admin-tab{padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:var(--muted);font-weight:600}.admin-tab:hover{color:var(--text);background:rgba(255,255,255,.08)}.admin-tab-active{color:var(--text);background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.16));border-color:rgba(167,139,250,.45)}
.grid{display:grid;gap:16px}.grid.cols-2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}.section-title{margin:0 0 12px;font-size:1.05rem}.announcement-preview{padding:16px;border-radius:12px;border:1px solid rgba(34,211,238,.35);background:linear-gradient(135deg,rgba(34,211,238,.14),rgba(167,139,250,.08));font-weight:600;line-height:1.4}.announcement-preview-empty{border-style:dashed;color:var(--muted)}
input[type=password],textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--stroke);background:rgba(0,0,0,.25);color:var(--text);font-size:.95rem}.textarea{resize:vertical}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Lumen Clash Admin</h1><p class="sub">Publish live marquee announcements for maintenance, events, and alerts.</p></header>
${embeddedSecret ? renderAdminNav('announcements', embeddedSecret) : ''}
${errBlock}${okBlock}
${bodyHtml}
</div>
</body>
</html>`;
}

function renderReportsAdminPage(reports, nameByUid, opts = {}) {
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const embeddedSecret = opts.embeddedSecret || '';

	const rev = [...(reports || [])].slice().reverse();
	const categories = [...new Set(rev.map((r) => String(r.category || 'other')).filter(Boolean))].sort();

	const rowsHtml = rev
		.map((r) => {
			const t = r.ts ? new Date(r.ts).toISOString() : '';
			const cat = String(r.category || 'other');
			const repUid = r.reporterUid || '';
			const reportedUid = r.reportedUid || '';
			
			const repData = (repUid && nameByUid[repUid]) || { name: '—', banned: false };
			const reportedData = (reportedUid && nameByUid[reportedUid]) || { name: '—', banned: false };
			
			const repName = repData.name;
			const reportedName = reportedData.name;
			const isBanned = reportedData.banned;
			
			const room = r.roomId || '';
			const cli = r.clientVersion || '';
			const details = r.details || '';
			const searchBlob = [t, cat, repUid, repName, reportedUid, reportedName, room, cli, details].join(' ').toLowerCase();
			const bannedPill = isBanned ? '<span class="pill pill-danger">BANNED</span>' : '';

			const dismissForm =
				embeddedSecret && r.ts != null
					? `<form method="post" action="/admin/moderate" class="inline-form" onsubmit="return confirm('Remove this report from the queue?');"><input type="hidden" name="secret" value="${escapeAttr(
							embeddedSecret
					  )}"><input type="hidden" name="action" value="dismiss_report"><input type="hidden" name="ts" value="${escapeAttr(
							String(r.ts)
					  )}"><input type="hidden" name="reporterUid" value="${escapeAttr(repUid)}"><input type="hidden" name="reportedUid" value="${escapeAttr(
							reportedUid
					  )}"><button type="submit" class="btn btn-muted">Dismiss</button></form>`
					: '—';

			const banActionForm =
				embeddedSecret && reportedUid
					? `<div class="row" style="gap:4px">
						<form method="post" action="/admin/moderate" class="inline-form">
							<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
							<input type="hidden" name="action" value="${isBanned ? 'unban_player' : 'ban_player'}">
							<input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}">
							<button type="submit" class="btn ${isBanned ? 'btn-ok' : 'btn-warn'}">${isBanned ? 'Unban' : 'Ban Perm'}</button>
						</form>
						${!isBanned ? `
						<form method="post" action="/admin/moderate" class="inline-form">
							<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
							<input type="hidden" name="action" value="ban_player">
							<input type="hidden" name="ts" value="24">
							<input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}">
							<button type="submit" class="btn btn-muted" title="24 Hours">24h</button>
						</form>
						<form method="post" action="/admin/moderate" class="inline-form">
							<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
							<input type="hidden" name="action" value="ban_player">
							<input type="hidden" name="ts" value="168">
							<input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}">
							<button type="submit" class="btn btn-muted" title="7 Days">7d</button>
						</form>
						` : ''}
					</div>`
					: '';

			const resetReportedForm =
				embeddedSecret && reportedUid
					? `<form method="post" action="/admin/moderate" class="inline-form" onsubmit="return confirm('Wipe this reported account?');"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="reset_player"><input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}"><button type="submit" class="btn btn-danger" title="Full Reset">Reset</button></form>`
					: '—';

			return `<tr data-cat="${escapeAttr(cat)}" data-search="${escapeAttr(searchBlob)}"><td class="nowrap mono">${escapeHtml(
				t
			)}</td><td><span class="pill">${escapeHtml(cat)}</span></td><td class="player-cell"><span class="mono sm">${escapeHtml(
				repUid
			)}</span><span class="un">${escapeHtml(repName)}</span></td><td class="player-cell"><span class="mono sm">${escapeHtml(
				reportedUid
			)}</span><span class="un">${escapeHtml(reportedName)} ${bannedPill}</span></td><td class="mono sm">${escapeHtml(room)}</td><td class="mono sm">${escapeHtml(
				cli
			)}</td><td class="details">${escapeHtml(details)}</td><td class="actions">${banActionForm}${resetReportedForm}${dismissForm}</td></tr>`;
		})
		.join('');

	const catOptions =
		`<option value="">All categories</option>` +
		categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');

	const errBlock = errorMsg ? `<div class="banner banner-err">${escapeHtml(errorMsg)}</div>` : '';
	const okBlock = successMsg ? `<div class="banner banner-ok">${escapeHtml(successMsg)}</div>` : '';

	const toolbar = embeddedSecret
		? `<div class="toolbar"><label class="grow"><span class="lbl">Search</span><input type="search" id="filterQ" placeholder="UID, name, room, details" autocomplete="off"></label><label><span class="lbl">Category</span><select id="filterCat">${catOptions}</select></label><span class="row-count mono" id="rowCount"></span></div>`
		: '';

	const loginForm = !embeddedSecret
		? `<form method="post" action="/admin/reports" class="login card"><h2>Sign in</h2><p class="hint">Enter your admin secret to load and moderate reports.</p><label class="block"><span class="lbl">Admin secret</span><input type="password" name="secret" autocomplete="current-password" required></label><button type="submit" class="btn btn-primary">Load reports</button></form>`
		: `<form method="post" action="/admin/reports" class="inline row card thin"><input type="hidden" name="secret" value="${escapeAttr(
				embeddedSecret
		  )}"><button type="submit" class="btn btn-muted">Refresh list</button></form>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lumen Clash - Moderation</title>
<style>
:root{--bg0:#07051a;--bg1:#120b2e;--card:#151032e6;--stroke:#3d2f6b;--text:#ede9ff;--muted:#9b8fb8;--accent:#a78bfa;--accent2:#22d3ee;--danger:#f87171;--warn:#fbbf24;--ok:#34d399;--radius:12px;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(1200px 800px at 10% -10%,#2e1f5c 0%,transparent 50%),radial-gradient(900px 600px at 90% 30%,#0c3d4d 0%,transparent 45%),linear-gradient(165deg,var(--bg0),var(--bg1))}
.wrap{max-width:1280px;margin:0 auto;padding:28px 20px 48px}header{margin-bottom:20px}
header h1{font-size:1.65rem;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;background:linear-gradient(90deg,var(--text),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--muted);font-size:.95rem;margin:0}
.card{background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius);padding:20px 22px;backdrop-filter:blur(10px);box-shadow:0 16px 50px rgba(0,0,0,.35)}
.card.thin{padding:12px 16px;margin-bottom:16px}
.login{max-width:420px;margin-bottom:24px}.login h2{margin:0 0 8px;font-size:1.1rem}
.hint{color:var(--muted);font-size:.9rem;margin:0 0 16px}.block{display:block;margin-bottom:14px}
.lbl{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}
input[type=password],input[type=search],select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--stroke);background:rgba(0,0,0,.25);color:var(--text);font-size:.95rem}
select{cursor:pointer;max-width:220px}
.toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:16px;padding:14px 16px;background:var(--card);border:1px solid var(--stroke);border-radius:var(--radius)}
.toolbar .grow{flex:1;min-width:200px}.row-count{color:var(--muted);font-size:.85rem;align-self:center}
.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:.95rem}
.banner-err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#fecaca}
.banner-ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35);color:#a7f3d0}
.table-wrap{overflow:auto;border-radius:var(--radius);border:1px solid var(--stroke);background:rgba(10,6,28,.65)}
table{width:100%;border-collapse:collapse;font-size:.88rem;min-width:920px}
thead th{text-align:left;padding:12px 10px;background:rgba(87,67,148,.35);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--stroke);position:sticky;top:0;z-index:1}
tbody td{padding:10px;border-bottom:1px solid rgba(61,47,107,.45);vertical-align:top}
tbody tr:hover{background:rgba(167,139,250,.06)}.nowrap{white-space:nowrap}
.mono{font-family:ui-monospace,monospace;font-size:.82em}.sm{font-size:.78rem;opacity:.85;display:block}
.player-cell .un{display:block;font-weight:600;margin-top:2px;color:#e4dfff}
.pill-danger{background:rgba(248,113,113,.15);color:var(--danger)}
.btn-ok{background:rgba(52,211,153,.2);color:#a7f3d0;border-color:rgba(52,211,153,.4)}.btn-ok:hover{background:rgba(52,211,153,.3)}
.lookup-card{display:none;margin-bottom:24px;border:2px solid var(--accent);background:rgba(167,139,250,.05)}
.lookup-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-top:16px}
.stat-box{background:rgba(0,0,0,.3);padding:12px;border-radius:8px;border:1px solid var(--stroke)}
.stat-val{display:block;font-size:1.2rem;font-weight:700;color:var(--accent2)}
.row{display:flex;align-items:center;gap:8px}
.admin-nav{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 24px}
.admin-tab{padding:10px 14px;border-radius:10px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);color:var(--muted);font-weight:600;text-decoration:none}
.admin-tab:hover{color:var(--text);background:rgba(255,255,255,.08)}
.admin-tab-active{color:var(--text);background:linear-gradient(135deg,rgba(167,139,250,.28),rgba(34,211,238,.16));border-color:rgba(167,139,250,.45)}
.hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Moderation desk</h1><p class="sub">Advanced Player Management - Mod View v2.0</p></header>
${embeddedSecret ? renderAdminNav('reports', embeddedSecret) : ''}
${errBlock}${okBlock}

<div class="row" style="align-items:stretch;margin-bottom:24px">
	${loginForm}
	${embeddedSecret ? `
	<div class="card" style="flex:1">
		<h2>Player lookup</h2>
		<div class="row">
			<input type="text" id="lookupInput" placeholder="UID or Username" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--stroke);background:rgba(0,0,0,.2);color:#fff">
			<button onclick="doLookup()" class="btn btn-primary" style="width:auto;padding:0 24px">Search</button>
		</div>
		<div id="lookupResult" class="lookup-card card" style="margin-top:16px"></div>
	</div>
	` : ''}
</div>

${toolbar}
<div class="table-wrap">
<table id="reportTable">
<thead><tr>
<th>Time (UTC)</th><th>Category</th><th>Reporter</th><th>Reported</th><th>Room</th><th>Client</th><th>Details</th><th>Actions</th>
</tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="8">No reports yet.</td></tr>'}</tbody>
</table>
</div>
</div>
<script>
const secret = "${escapeAttr(embeddedSecret)}";
async function doLookup() {
	const q = document.getElementById('lookupInput').value.trim();
	const resBox = document.getElementById('lookupResult');
	if (!q) return;
	resBox.innerHTML = '<p>Searching...</p>';
	resBox.style.display = 'block';
	try {
		const res = await fetch('/admin/lookup?secret='+encodeURIComponent(secret)+'&q='+encodeURIComponent(q));
		const data = await res.json();
		if (!data.ok) {
			resBox.innerHTML = '<p style="color:var(--danger)">Error: ' + data.error + '</p>';
			return;
		}
		const p = data.profile;
		resBox.innerHTML = \`
			<div style="display:flex;justify-content:space-between;align-items:flex-start">
				<div>
					<h3 style="margin:0">\${p.username || 'Player'} \${p.banned ? '<span class="pill pill-danger">BANNED</span>' : ''}</h3>
					<code style="font-size:0.8rem;color:var(--muted)">\${p.uid}</code>
					\${p.banned && p.bannedUntil ? '<div style="font-size:0.75rem;color:var(--danger);margin-top:4px">Temporary ban until: ' + new Date(p.bannedUntil).toLocaleString() + '</div>' : ''}
				</div>
				<div class="row" style="gap:8px">
					<form method="post" action="/admin/moderate">
						<input type="hidden" name="secret" value="\${secret}">
						<input type="hidden" name="action" value="\${p.banned ? 'unban_player' : 'ban_player'}">
						<input type="hidden" name="targetUid" value="\${p.uid}">
						<button type="submit" class="btn \${p.banned ? 'btn-ok' : 'btn-warn'}" style="padding:4px 12px">\${p.banned ? 'Unban' : 'Ban Permanent'}</button>
					</form>
					\${!p.banned ? \`
					<form method="post" action="/admin/moderate">
						<input type="hidden" name="secret" value="\${secret}">
						<input type="hidden" name="action" value="ban_player">
						<input type="hidden" name="ts" value="24">
						<input type="hidden" name="targetUid" value="\${p.uid}">
						<button type="submit" class="btn btn-muted" style="padding:4px 12px">24h Ban</button>
					</form>
					<form method="post" action="/admin/moderate">
						<input type="hidden" name="secret" value="\${secret}">
						<input type="hidden" name="action" value="ban_player">
						<input type="hidden" name="ts" value="168">
						<input type="hidden" name="targetUid" value="\${p.uid}">
						<button type="submit" class="btn btn-muted" style="padding:4px 12px">7d Ban</button>
					</form>
					\` : ''}
				</div>
			</div>
			<div class="lookup-grid">
				<div class="stat-box"><span class="lbl">Lumens</span><span class="stat-val">\${p.lumens || 0}</span></div>
				<div class="stat-box"><span class="lbl">Level</span><span class="stat-val">\${p.level || 1}</span></div>
				<div class="stat-box"><span class="lbl">Wins / Losses</span><span class="stat-val">\${p.wins || 0} / \${p.losses || 0}</span></div>
				<div class="stat-box"><span class="lbl">Last seen</span><span class="stat-val" style="font-size:0.9rem">\${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'Never'}</span></div>
			</div>
			<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--stroke)">
				<h4 style="margin:0 0 12px;font-size:0.9rem">Adjust stats</h4>
				<form method="post" action="/admin/moderate" class="row">
					<input type="hidden" name="secret" value="\${secret}">
					<input type="hidden" name="action" value="adjust_stats">
					<input type="hidden" name="targetUid" value="\${p.uid}">
					<label style="flex:1"><span class="lbl">Lumens</span><input type="number" name="lumens" value="\${p.lumens || 0}"></label>
					<label style="flex:1"><span class="lbl">Level</span><input type="number" name="level" value="\${p.level || 1}"></label>
					<label style="flex:1"><span class="lbl">MMR</span><input type="number" name="mmr" value="\${p.rankedRecord ? p.rankedRecord.mmr : 1000}"></label>
					<button type="submit" class="btn btn-primary" style="width:auto;margin-top:18px">Save</button>
				</form>
			</div>
		\`;
	} catch(e) {
		resBox.innerHTML = '<p>Failed to lookup player.</p>';
	}
}

(function(){var q=document.getElementById("filterQ");var cat=document.getElementById("filterCat");var tbl=document.getElementById("reportTable");if(!q||!tbl)return;var rows=[].slice.call(tbl.querySelectorAll("tbody tr"));var rc=document.getElementById("rowCount");function apply(){var cq=(q.value||"").toLowerCase();var cc=cat?cat.value:"";var vis=0;var total=0;rows.forEach(function(tr){var tds=tr.querySelectorAll("td");if(tds.length===1&&tds[0].hasAttribute("colspan")){tr.style.display="";return;}total++;var blob=(tr.getAttribute("data-search")||"").toLowerCase();var c=tr.getAttribute("data-cat")||"";var okQ=!cq||blob.indexOf(cq)!==-1;var okC=!cc||c===cc;var show=okQ&&okC;tr.style.display=show?"":"none";if(show)vis++;});if(rc)rc.textContent=vis+" / "+total+" rows";}q.addEventListener("input",apply);if(cat)cat.addEventListener("change",apply);apply();})();
</script>
</body>
</html>`;
}

function renderAdminDashboardPageV2(summary, opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const reports = summary.reports || [];
	const activeEvents = summary.activeEvents || [];
	const playerSummary = summary.playerSummary || null;
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin', 'Admin Sign In', 'Enter your admin secret to open the admin dashboard.', 'Open dashboard')
		: `<section class="kpi-grid">
			<div class="kpi-card">
				<span class="lbl">Total players</span>
				<span class="stat-val">${playerSummary ? playerSummary.totalPlayers : '—'}</span>
				<div class="kpi-trend">${playerSummary ? `${playerSummary.activePlayers} active now` : 'Player overview unavailable'}</div>
			</div>
			<div class="kpi-card">
				<span class="lbl">Active events</span>
				<span class="stat-val">${activeEvents.length}</span>
				<div class="kpi-trend">${activeEvents.length ? escapeHtml(activeEvents.map((e) => e.name).join(' • ')) : 'No live events'}</div>
			</div>
			<div class="kpi-card">
				<span class="lbl">Open reports</span>
				<span class="stat-val">${reports.length}</span>
				<div class="kpi-trend">Moderation queue ready</div>
			</div>
		</section>
		<section class="split-grid">
			<div class="stack">
				<div class="card hero-card">
					<div class="section-head">
						<div class="section-copy">
							<h2 class="section-title">Admin Overview</h2>
							<p class="hint">Keep the landing page focused on quick health checks, then use the sub-pages for the full operational detail.</p>
						</div>
						<div class="row">
							<a class="btn btn-primary" href="/admin/players?secret=${encodeURIComponent(embeddedSecret)}">Player health</a>
							<a class="btn btn-primary" href="/admin/reports?secret=${encodeURIComponent(embeddedSecret)}">Reports</a>
							<a class="btn btn-primary" href="/admin/events?secret=${encodeURIComponent(embeddedSecret)}">Events</a>
						</div>
					</div>
					<div class="info-list">
						<div class="info-item"><span>Player health</span><span class="value">Account totals, active players, recent players</span></div>
						<div class="info-item"><span>Reports</span><span class="value">Moderation queue, player lookup, account actions</span></div>
						<div class="info-item"><span>Events / Flags / Announcements</span><span class="value">Live-ops controls and messaging</span></div>
					</div>
				</div>
				<div class="card">
					<h2 class="section-title">At a Glance</h2>
					<div class="info-list">
						<div class="info-item"><span>Recent 24 hours</span><span class="value">${playerSummary ? `${playerSummary.recent24h} players seen` : 'Unavailable'}</span></div>
						<div class="info-item"><span>Players in guilds</span><span class="value">${playerSummary ? playerSummary.guildedPlayers : '—'}</span></div>
						<div class="info-item"><span>Banned accounts</span><span class="value">${playerSummary ? playerSummary.bannedPlayers : '—'}</span></div>
					</div>
				</div>
			</div>
			<div class="stack">
				<div class="card">
					<h2 class="section-title">Live-ops Snapshot</h2>
					<div class="info-list">
						<div class="info-item"><span>Active events</span><span class="value">${activeEvents.length}</span></div>
						<div class="info-item"><span>Queued reports</span><span class="value">${reports.length}</span></div>
						<div class="info-item"><span>Sub-pages</span><span class="value">Players, Reports, Events, Flags, Announcements</span></div>
					</div>
				</div>
				<div class="card">
					<h2 class="section-title">Quick Links</h2>
					<div class="info-list">
						<div class="info-item"><span><a href="/admin/players?secret=${encodeURIComponent(embeddedSecret)}">Player health</a></span><span class="value">Population and activity view</span></div>
						<div class="info-item"><span><a href="/admin/flags?secret=${encodeURIComponent(embeddedSecret)}">Feature flags</a></span><span class="value">System controls</span></div>
						<div class="info-item"><span><a href="/admin/announcements?secret=${encodeURIComponent(embeddedSecret)}">Announcements</a></span><span class="value">Player-facing messaging</span></div>
					</div>
				</div>
			</div>
		</section>`;
	return renderAdminShell({
		title: 'Admin Overview',
		pageTitle: 'Lumen Clash Admin',
		subtitle: 'A lighter landing page for quick checks, with deeper tools moved into focused sub-pages.',
		activeTab: 'dashboard',
		embeddedSecret,
		errorMsg: opts.errorMsg || '',
		successMsg: opts.successMsg || '',
		heroMeta: embeddedSecret
			? `<span class="meta-chip"><strong>${playerSummary ? playerSummary.totalPlayers : '—'}</strong> players</span><span class="meta-chip"><strong>${playerSummary ? playerSummary.activePlayers : '—'}</strong> active now</span><span class="meta-chip"><strong>${reports.length}</strong> queued reports</span>`
			: `<span class="meta-chip"><strong>Protected</strong> admin access</span>`,
		bodyHtml
	});
}

function renderAdminEventsPageV2(opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const activeEvents = opts.activeEvents || [];
	const eventsCatalog = opts.eventsCatalog || [];
	const activeIds = new Set(activeEvents.map((e) => e.id));
	const rowsHtml = eventsCatalog
		.map((ev) => {
			const isActive = activeIds.has(ev.id);
			const mode = ev.forceStopped ? 'Stopped' : ev.forceActive ? 'Forced Live' : isActive ? 'Scheduled Live' : 'Queued';
			const rewards = [].concat(ev.grantedTitles || []).concat(ev.grantedCosmetics || []).join(', ');
			const startText = Number.isFinite(ev.startMs) ? new Date(ev.startMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a';
			const endText = Number.isFinite(ev.endMs) ? new Date(ev.endMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a';
			const controls = embeddedSecret
				? `<div class="row">
					<form method="post" action="/admin/events" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="start_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-primary">Start</button></form>
					<form method="post" action="/admin/events" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="stop_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-muted">Stop</button></form>
					<form method="post" action="/admin/events" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="resume_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-muted">Resume</button></form>
					<form method="post" action="/admin/events" class="inline-form" onsubmit="return confirm('Delete this event?');"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="delete_event"><input type="hidden" name="eventId" value="${escapeAttr(ev.id)}"><button type="submit" class="btn btn-danger">Delete</button></form>
				</div>`
				: '';
			return `<tr><td><strong>${escapeHtml(ev.name)}</strong><div class="hint mono">${escapeHtml(ev.id)}</div></td><td><span class="pill ${isActive ? 'pill-ok' : ''}">${escapeHtml(mode)}</span></td><td class="mono">${escapeHtml(startText)}</td><td class="mono">${escapeHtml(endText)}</td><td>${escapeHtml(rewards || 'No extra rewards')}</td><td>${controls}</td></tr>`;
		})
		.join('');
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/events', 'Admin Sign In', 'Enter your admin secret to inspect event configuration.', 'Open events')
		: `<section class="kpi-grid">
			<div class="kpi-card"><span class="lbl">Live now</span><span class="stat-val">${activeEvents.length}</span><div class="kpi-trend">Current event windows</div></div>
			<div class="kpi-card"><span class="lbl">Catalog entries</span><span class="stat-val">${eventsCatalog.length}</span><div class="kpi-trend">Queued or archived live-ops plans</div></div>
			<div class="kpi-card"><span class="lbl">Manual controls</span><span class="stat-val">3</span><div class="kpi-trend">Start, stop, and resume schedule</div></div>
		</section>
		<section class="split-grid">
			<div class="stack">
				<div class="card">
					<div class="section-head">
						<div class="section-copy">
							<h2 class="section-title">Queue New Event</h2>
							<p class="hint">Schedule a new window with rewards and multipliers, then override it manually if the live plan changes.</p>
						</div>
					</div>
					<form method="post" action="/admin/events" class="form-grid">
						<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
						<input type="hidden" name="action" value="create_event">
						<label><span class="lbl">Event ID</span><input type="text" name="eventId" placeholder="spring_flash_sale"></label>
						<label><span class="lbl">Event Name</span><input type="text" name="eventName" placeholder="Spring Flash Sale" required></label>
						<label><span class="lbl">Start (UTC)</span><input type="datetime-local" name="startAt" required></label>
						<label><span class="lbl">End (UTC)</span><input type="datetime-local" name="endAt" required></label>
						<label><span class="lbl">XP Multiplier</span><input type="number" step="0.05" min="0.1" name="xpMultiplier" value="1"></label>
						<label><span class="lbl">Lumen Multiplier</span><input type="number" step="0.05" min="0.1" name="lumenMultiplier" value="1"></label>
						<label><span class="lbl">Granted Titles</span><input type="text" name="grantedTitles" placeholder="Pioneer, Founder"></label>
						<label><span class="lbl">Granted Cosmetics</span><input type="text" name="grantedCosmetics" placeholder="Gold, emote_clown"></label>
						<div class="field-span-full row"><button type="submit" class="btn btn-primary">Queue event</button></div>
					</form>
				</div>
				<div class="card">
					<div class="section-head">
						<div class="section-copy">
							<h2 class="section-title">Configured Event Catalog</h2>
							<p class="hint">A cleaner overview of scheduled windows, reward bundles, and one-click live controls.</p>
						</div>
					</div>
					<div class="table-wrap">
						<table>
							<thead><tr><th>Event</th><th>Status</th><th>Starts</th><th>Ends</th><th>Rewards</th><th>Controls</th></tr></thead>
							<tbody>${rowsHtml || '<tr><td colspan="6">No events configured.</td></tr>'}</tbody>
						</table>
					</div>
				</div>
			</div>
			<div class="stack">
				<div class="card">
					<h2 class="section-title">Live Event Summary</h2>
					${activeEvents.length ? `<ul class="list">${activeEvents.map((ev) => `<li><strong>${escapeHtml(ev.name)}</strong> is currently active.</li>`).join('')}</ul>` : '<p class="hint">No events are active at the moment.</p>'}
				</div>
				<div class="card">
					<h2 class="section-title">How the controls work</h2>
					<div class="info-list">
						<div class="info-item"><span>Queue</span><span class="value">Create an event and let schedule handle it</span></div>
						<div class="info-item"><span>Start</span><span class="value">Force it live immediately</span></div>
						<div class="info-item"><span>Resume</span><span class="value">Return control to its time window</span></div>
					</div>
				</div>
			</div>
		</section>`;
	return renderAdminShell({
		title: 'Event Operations',
		pageTitle: 'Lumen Clash Admin - Events',
		subtitle: 'Schedule, monitor, and manually control live event windows from one cleaner workspace.',
		activeTab: 'events',
		embeddedSecret,
		errorMsg: opts.errorMsg || '',
		successMsg: opts.successMsg || '',
		heroMeta: embeddedSecret
			? `<span class="meta-chip"><strong>${activeEvents.length}</strong> live now</span><span class="meta-chip"><strong>${eventsCatalog.length}</strong> catalog entries</span>`
			: `<span class="meta-chip"><strong>Protected</strong> admin access</span>`,
		bodyHtml
	});
}

function renderAdminFlagsPageV2(opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const flags = normalizeFeatureFlags(opts.flags);
	const toggle = (name, label, hint) => {
		const enabled = !!flags[name];
		return `<div class="flag-card">
			<div class="flag-copy">
				<div class="flag-head">
					<strong>${escapeHtml(label)}</strong>
					<span class="flag-state ${enabled ? 'flag-state--enabled' : 'flag-state--disabled'}">${enabled ? 'Enabled' : 'Disabled'}</span>
				</div>
				<div class="hint">${escapeHtml(hint)}</div>
			</div>
			<div class="flag-actions">
				<form method="post" action="/admin/flags" class="inline-form">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="flagName" value="${escapeAttr(name)}">
					<input type="hidden" name="flagValue" value="true">
					<button type="submit" class="btn ${enabled ? 'btn-primary' : 'btn-muted'}">Enable</button>
				</form>
				<form method="post" action="/admin/flags" class="inline-form">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="flagName" value="${escapeAttr(name)}">
					<input type="hidden" name="flagValue" value="false">
					<button type="submit" class="btn ${enabled ? 'btn-muted' : 'btn-danger'}">Disable</button>
				</form>
			</div>
		</div>`;
	};
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/flags', 'Admin Sign In', 'Enter your admin secret to manage feature flags.', 'Open flags')
		: `<section class="kpi-grid">
			<div class="kpi-card"><span class="lbl">Enabled systems</span><span class="stat-val">${Object.values(flags).filter(Boolean).length}</span><div class="kpi-trend">Immediate live controls</div></div>
			<div class="kpi-card"><span class="lbl">Disabled systems</span><span class="stat-val">${Object.values(flags).filter((v) => !v).length}</span><div class="kpi-trend">Systems currently gated</div></div>
		</section>
		<div class="card">
			<div class="section-head">
				<div class="section-copy">
					<h2 class="section-title">System Toggles</h2>
					<p class="hint">Use these switches as your live safety layer. Every change applies without a new deploy.</p>
				</div>
			</div>
			<div class="flags-grid">
				${toggle('questsEnabled', 'Quests', 'Controls claiming and quest reward access.')}
				${toggle('shopEnabled', 'Shop', 'Controls in-game item purchases.')}
				${toggle('premiumEnabled', 'Premium Unlock', 'Controls Luminary Pass premium unlock purchases.')}
				${toggle('reportsEnabled', 'Player Reports', 'Controls report submission from the client.')}
				${toggle('friendInvitesEnabled', 'Friend Invites', 'Controls social invite sending.')}
				${toggle('casualQueueEnabled', 'Casual Queue', 'Controls entering the default casual matchmaking queue.')}
				${toggle('rankedQueueEnabled', 'Ranked Queue', 'Controls entering ranked matchmaking.')}
				${toggle('queue2v2Enabled', '2v2 Queue', 'Controls entering 2v2 matchmaking.')}
				${toggle('privateMatchesEnabled', 'Private Matches', 'Controls duel room creation and private code joins.')}
				${toggle('partyModeEnabled', 'Party Mode', 'Controls party invites and joining party lobbies.')}
			</div>
		</div>`;
	return renderAdminShell({
		title: 'Feature Controls',
		pageTitle: 'Lumen Clash Admin - Flags',
		subtitle: 'Flip major gameplay systems on or off quickly with a clearer control surface.',
		activeTab: 'flags',
		embeddedSecret,
		errorMsg: opts.errorMsg || '',
		successMsg: opts.successMsg || '',
		heroMeta: embeddedSecret ? `<span class="meta-chip"><strong>${Object.values(flags).filter(Boolean).length}</strong> systems enabled</span>` : '',
		bodyHtml
	});
}

function renderAdminAnnouncementsPageV2(opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const announcement = opts.announcement || { message: '', active: false, updatedAt: null };
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/announcements', 'Admin Sign In', 'Enter your admin secret to manage global announcements.', 'Open announcements')
		: `<section class="split-grid">
			<div class="card hero-card">
				<div class="section-head">
					<div class="section-copy">
						<h2 class="section-title">Live Announcement Preview</h2>
						<p class="hint">This message appears to players in the marquee bar.</p>
					</div>
				</div>
				<div class="announcement-preview ${announcement.active && announcement.message ? '' : 'announcement-preview-empty'}">${escapeHtml(
					announcement.active && announcement.message ? announcement.message : 'No announcement is live right now.'
				)}</div>
				<p class="hint">Last updated: ${announcement.updatedAt ? escapeHtml(new Date(announcement.updatedAt).toISOString()) : 'Never'}</p>
			</div>
			<div class="stack">
				<div class="card">
					<h2 class="section-title">Publish Announcement</h2>
					<form method="post" action="/admin/announcements">
						<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
						<input type="hidden" name="action" value="publish">
						<label><span class="lbl">Message</span><textarea name="message" rows="5" maxlength="220" placeholder="Server maintenance at 8 PM UTC. Ranked queue will be disabled for 20 minutes.">${escapeHtml(
							announcement.active ? announcement.message || '' : ''
						)}</textarea></label>
						<div class="row" style="margin-top:16px"><button type="submit" class="btn btn-primary">Publish</button></div>
					</form>
				</div>
				<div class="card">
					<h2 class="section-title">Clear Announcement</h2>
					<p class="hint">Use this when the message no longer applies or when you want the marquee hidden immediately.</p>
					<form method="post" action="/admin/announcements" onsubmit="return confirm('Clear the live announcement?');">
						<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
						<input type="hidden" name="action" value="clear">
						<button type="submit" class="btn btn-muted">Clear announcement</button>
					</form>
				</div>
			</div>
		</section>`;
	return renderAdminShell({
		title: 'Announcements',
		pageTitle: 'Lumen Clash Admin - Announcements',
		subtitle: 'Publish clearer player-facing notices for maintenance, live events, and urgent updates.',
		activeTab: 'announcements',
		embeddedSecret,
		errorMsg: opts.errorMsg || '',
		successMsg: opts.successMsg || '',
		heroMeta: announcement.active && announcement.message ? `<span class="meta-chip"><strong>Live</strong> marquee active</span>` : `<span class="meta-chip"><strong>Idle</strong> no live message</span>`,
		bodyHtml
	});
}

function renderReportsAdminPageV2(reports, nameByUid, opts = {}) {
	const errorMsg = opts.errorMsg || '';
	const successMsg = opts.successMsg || '';
	const embeddedSecret = opts.embeddedSecret || '';
	const rev = [...(reports || [])].slice().reverse();
	const categories = [...new Set(rev.map((r) => String(r.category || 'other')).filter(Boolean))].sort();
	const rowsHtml = rev
		.map((r) => {
			const t = r.ts ? new Date(r.ts).toISOString() : '';
			const cat = String(r.category || 'other');
			const repUid = r.reporterUid || '';
			const reportedUid = r.reportedUid || '';
			const repData = (repUid && nameByUid[repUid]) || { name: '—', banned: false };
			const reportedData = (reportedUid && nameByUid[reportedUid]) || { name: '—', banned: false };
			const repName = repData.name;
			const reportedName = reportedData.name;
			const isBanned = reportedData.banned;
			const room = r.roomId || '';
			const cli = r.clientVersion || '';
			const details = r.details || '';
			const searchBlob = [t, cat, repUid, repName, reportedUid, reportedName, room, cli, details].join(' ').toLowerCase();
			const bannedPill = isBanned ? '<span class="pill pill-danger">BANNED</span>' : '';
			const dismissForm =
				embeddedSecret && r.ts != null
					? `<form method="post" action="/admin/moderate" class="inline-form" onsubmit="return confirm('Remove this report from the queue?');"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="dismiss_report"><input type="hidden" name="ts" value="${escapeAttr(String(r.ts))}"><input type="hidden" name="reporterUid" value="${escapeAttr(repUid)}"><input type="hidden" name="reportedUid" value="${escapeAttr(reportedUid)}"><button type="submit" class="btn btn-muted">Dismiss</button></form>`
					: '';
			const banActionForm =
				embeddedSecret && reportedUid
					? `<div class="row" style="gap:4px">
						<form method="post" action="/admin/moderate" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="${isBanned ? 'unban_player' : 'ban_player'}"><input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}"><button type="submit" class="btn ${isBanned ? 'btn-ok' : 'btn-warn'}">${isBanned ? 'Unban' : 'Ban perm'}</button></form>
						${!isBanned ? `<form method="post" action="/admin/moderate" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="ban_player"><input type="hidden" name="ts" value="24"><input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}"><button type="submit" class="btn btn-muted">24h</button></form>
						<form method="post" action="/admin/moderate" class="inline-form"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="ban_player"><input type="hidden" name="ts" value="168"><input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}"><button type="submit" class="btn btn-muted">7d</button></form>` : ''}
					</div>`
					: '';
			const resetReportedForm =
				embeddedSecret && reportedUid
					? `<form method="post" action="/admin/moderate" class="inline-form" onsubmit="return confirm('Wipe this reported account?');"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><input type="hidden" name="action" value="reset_player"><input type="hidden" name="targetUid" value="${escapeAttr(reportedUid)}"><button type="submit" class="btn btn-danger">Reset</button></form>`
					: '';
			return `<tr data-cat="${escapeAttr(cat)}" data-search="${escapeAttr(searchBlob)}"><td class="nowrap mono">${escapeHtml(t)}</td><td><span class="pill">${escapeHtml(cat)}</span></td><td class="player-cell"><span class="mono sm">${escapeHtml(repUid)}</span><span class="un">${escapeHtml(repName)}</span></td><td class="player-cell"><span class="mono sm">${escapeHtml(reportedUid)}</span><span class="un">${escapeHtml(reportedName)} ${bannedPill}</span></td><td class="mono sm">${escapeHtml(room)}</td><td class="mono sm">${escapeHtml(cli)}</td><td class="details">${escapeHtml(details)}</td><td class="actions">${banActionForm}${resetReportedForm}${dismissForm}</td></tr>`;
		})
		.join('');
	const catOptions = `<option value="">All categories</option>` + categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
	const toolbar = embeddedSecret
		? `<div class="toolbar"><label class="grow"><span class="lbl">Search</span><input type="search" id="filterQ" placeholder="UID, name, room, details" autocomplete="off"></label><label><span class="lbl">Category</span><select id="filterCat">${catOptions}</select></label><span class="row-count mono" id="rowCount"></span></div>`
		: '';
	const loginForm = !embeddedSecret
		? renderAdminLoginCard('/admin/reports', 'Sign in', 'Enter your admin secret to load and moderate reports.', 'Load reports')
		: `<form method="post" action="/admin/reports" class="card card-thin inline row"><input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}"><button type="submit" class="btn btn-muted">Refresh list</button></form>`;
	const bodyHtml = `<section class="kpi-grid">
		<div class="kpi-card"><span class="lbl">Queued reports</span><span class="stat-val">${rev.length}</span><div class="kpi-trend">Items waiting for review</div></div>
		<div class="kpi-card"><span class="lbl">Categories</span><span class="stat-val">${categories.length}</span><div class="kpi-trend">Unique report types in queue</div></div>
	</section>
	<div class="row" style="align-items:stretch;margin-bottom:8px">
		${loginForm}
		${embeddedSecret ? `<div class="card" style="flex:1">
			<div class="section-head">
				<div class="section-copy">
					<h2 class="section-title">Player Lookup</h2>
					<p class="hint">Find a player quickly by UID or username, then apply bans or stat adjustments from one compact panel.</p>
				</div>
			</div>
			<div class="row">
				<input type="text" id="lookupInput" placeholder="UID or Username" style="flex:1">
				<button onclick="doLookup()" class="btn btn-primary">Search</button>
			</div>
			<div id="lookupResult" class="lookup-card card"></div>
		</div>` : ''}
	</div>
	${toolbar}
	<div class="card">
		<div class="section-head">
			<div class="section-copy">
				<h2 class="section-title">Moderation Queue</h2>
				<p class="hint">Search, filter, and action reports without losing sight of player identity or report context.</p>
			</div>
		</div>
		<div class="table-wrap">
			<table id="reportTable">
				<thead><tr><th>Time (UTC)</th><th>Category</th><th>Reporter</th><th>Reported</th><th>Room</th><th>Client</th><th>Details</th><th>Actions</th></tr></thead>
				<tbody>${rowsHtml || '<tr><td colspan="8">No reports yet.</td></tr>'}</tbody>
			</table>
		</div>
	</div>
	<script>
const secret = "${escapeAttr(embeddedSecret)}";
async function doLookup() {
	const q = document.getElementById('lookupInput').value.trim();
	const resBox = document.getElementById('lookupResult');
	if (!q) return;
	resBox.innerHTML = '<p>Searching...</p>';
	resBox.style.display = 'block';
	try {
		const res = await fetch('/admin/lookup?secret='+encodeURIComponent(secret)+'&q='+encodeURIComponent(q));
		const data = await res.json();
		if (!data.ok) {
			resBox.innerHTML = '<p style="color:var(--danger)">Error: ' + data.error + '</p>';
			return;
		}
		const p = data.profile;
		resBox.innerHTML = \`
			<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
				<div>
					<h3 style="margin:0">\${p.username || 'Player'} \${p.banned ? '<span class="pill pill-danger">BANNED</span>' : ''}</h3>
					<code style="font-size:0.8rem;color:var(--muted)">\${p.uid}</code>
					\${p.banned && p.bannedUntil ? '<div style="font-size:0.75rem;color:var(--danger);margin-top:4px">Temporary ban until: ' + new Date(p.bannedUntil).toLocaleString() + '</div>' : ''}
				</div>
				<div class="row" style="gap:8px">
					<form method="post" action="/admin/moderate">
						<input type="hidden" name="secret" value="\${secret}">
						<input type="hidden" name="action" value="\${p.banned ? 'unban_player' : 'ban_player'}">
						<input type="hidden" name="targetUid" value="\${p.uid}">
						<button type="submit" class="btn \${p.banned ? 'btn-ok' : 'btn-warn'}">\${p.banned ? 'Unban' : 'Ban permanent'}</button>
					</form>
				</div>
			</div>
			<div class="lookup-grid">
				<div class="stat-box"><span class="lbl">Lumens</span><span class="stat-val">\${p.lumens || 0}</span></div>
				<div class="stat-box"><span class="lbl">Level</span><span class="stat-val">\${p.level || 1}</span></div>
				<div class="stat-box"><span class="lbl">Wins / Losses</span><span class="stat-val">\${p.wins || 0} / \${p.losses || 0}</span></div>
				<div class="stat-box"><span class="lbl">Last seen</span><span class="stat-val" style="font-size:0.9rem">\${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'Never'}</span></div>
			</div>
			<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--stroke)">
				<h4 style="margin:0 0 12px;font-size:0.9rem">Adjust stats</h4>
				<form method="post" action="/admin/moderate" class="form-grid">
					<input type="hidden" name="secret" value="\${secret}">
					<input type="hidden" name="action" value="adjust_stats">
					<input type="hidden" name="targetUid" value="\${p.uid}">
					<label><span class="lbl">Lumens</span><input type="number" name="lumens" value="\${p.lumens || 0}"></label>
					<label><span class="lbl">Level</span><input type="number" name="level" value="\${p.level || 1}"></label>
					<label><span class="lbl">MMR</span><input type="number" name="mmr" value="\${p.rankedRecord ? p.rankedRecord.mmr : 1000}"></label>
					<div class="field-span-full row"><button type="submit" class="btn btn-primary">Save adjustments</button></div>
				</form>
			</div>
		\`;
	} catch(e) {
		resBox.innerHTML = '<p>Failed to lookup player.</p>';
	}
}
(function(){var q=document.getElementById("filterQ");var cat=document.getElementById("filterCat");var tbl=document.getElementById("reportTable");if(!q||!tbl)return;var rows=[].slice.call(tbl.querySelectorAll("tbody tr"));var rc=document.getElementById("rowCount");function apply(){var cq=(q.value||"").toLowerCase();var cc=cat?cat.value:"";var vis=0;var total=0;rows.forEach(function(tr){var tds=tr.querySelectorAll("td");if(tds.length===1&&tds[0].hasAttribute("colspan")){tr.style.display="";return;}total++;var blob=(tr.getAttribute("data-search")||"").toLowerCase();var c=tr.getAttribute("data-cat")||"";var okQ=!cq||blob.indexOf(cq)!==-1;var okC=!cc||c===cc;var show=okQ&&okC;tr.style.display=show?"":"none";if(show)vis++;});if(rc)rc.textContent=vis+" / "+total+" rows";}q.addEventListener("input",apply);if(cat)cat.addEventListener("change",apply);apply();})();
	</script>`;
	return renderAdminShell({
		title: 'Moderation Desk',
		pageTitle: 'Lumen Clash - Moderation',
		subtitle: 'A more professional review desk for reports, player lookups, and account actions.',
		activeTab: 'reports',
		embeddedSecret,
		errorMsg,
		successMsg,
		heroMeta: embeddedSecret ? `<span class="meta-chip"><strong>${rev.length}</strong> queued reports</span><span class="meta-chip"><strong>${categories.length}</strong> categories</span>` : '',
		bodyHtml
	});
}

function renderAdminPlayersPageV2(summary, opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const rows = summary.rows || [];
	const rowHtml = rows
		.map((player) => {
			const lastSeenText = player.lastSeen ? new Date(player.lastSeen).toISOString() : 'Never';
			const activeNow = player.lastSeen && Date.now() - player.lastSeen < 60_000;
			const statusText = activeNow ? 'Active now' : player.lastSeen ? 'Recently seen' : 'No activity';
			const guildText = player.guildId ? 'guild' : 'solo';
			const accountText = player.banned ? 'banned' : 'good standing';
			const searchBlob = [
				player.username || 'Player',
				player.uid,
				player.level,
				player.wins,
				player.losses,
				player.lumens,
				statusText,
				player.presence || 'menu',
				guildText,
				accountText,
				lastSeenText
			].join(' ').toLowerCase();
			return `<tr data-search="${escapeAttr(searchBlob)}" data-status="${escapeAttr(statusText.toLowerCase())}" data-account="${escapeAttr(accountText)}" data-guild="${escapeAttr(guildText)}">
				<td><strong>${escapeHtml(player.username || 'Player')}</strong><div class="hint mono">${escapeHtml(player.uid)}</div></td>
				<td>${player.level}</td>
				<td>${player.wins} / ${player.losses}</td>
				<td>${player.lumens}</td>
				<td><span class="pill ${activeNow ? 'pill-ok' : ''}">${escapeHtml(statusText)}</span><div class="hint">${escapeHtml(String(player.presence || 'menu'))}</div></td>
				<td class="mono">${escapeHtml(lastSeenText)}</td>
				<td>${player.guildId ? '<span class="pill pill-ok">Guild</span>' : '<span class="hint">Solo</span>'}</td>
				<td>${player.banned ? '<span class="pill pill-danger">Banned</span>' : '<span class="hint">Good standing</span>'}</td>
			</tr>`;
		})
		.join('');
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/players', 'Admin Sign In', 'Enter your admin secret to open player health and population analytics.', 'Open players')
		: `<section class="kpi-grid">
			<div class="kpi-card"><span class="lbl">Total players</span><span class="stat-val">${summary.totalPlayers}</span><div class="kpi-trend">Known accounts</div></div>
			<div class="kpi-card"><span class="lbl">Active now</span><span class="stat-val">${summary.activePlayers}</span><div class="kpi-trend">Seen in the last minute</div></div>
			<div class="kpi-card"><span class="lbl">Seen in 24h</span><span class="stat-val">${summary.recent24h}</span><div class="kpi-trend">Recent returning players</div></div>
			<div class="kpi-card"><span class="lbl">Total matches</span><span class="stat-val">${summary.totalMatches}</span><div class="kpi-trend">Wins plus losses across all accounts</div></div>
		</section>
		<section class="split-grid">
			<div class="stack">
				<div class="card">
					<div class="section-head">
						<div class="section-copy">
							<h2 class="section-title">Player Health</h2>
							<p class="hint">Use this page to understand how the game is doing with players without mixing that information into every other admin screen.</p>
						</div>
					</div>
					<div class="info-list">
						<div class="info-item"><span>Players in guilds</span><span class="value">${summary.guildedPlayers}</span></div>
						<div class="info-item"><span>Banned accounts</span><span class="value">${summary.bannedPlayers}</span></div>
						<div class="info-item"><span>Average matches per account</span><span class="value">${summary.totalPlayers ? (summary.totalMatches / summary.totalPlayers).toFixed(1) : '0.0'}</span></div>
					</div>
				</div>
			</div>
			<div class="stack">
				<div class="card">
					<h2 class="section-title">What this page shows</h2>
					<div class="info-list">
						<div class="info-item"><span>Account count</span><span class="value">Known players who have opened the game</span></div>
						<div class="info-item"><span>Active now</span><span class="value">Players seen during the last 60 seconds</span></div>
						<div class="info-item"><span>Seen in 24h</span><span class="value">A quick retention pulse</span></div>
					</div>
				</div>
			</div>
		</section>
		<div class="card">
			<div class="section-head">
				<div class="section-copy">
					<h2 class="section-title">All Known Players</h2>
					<p class="hint">Every indexed account sorted by recent activity.${summary.rowsTruncated ? ` Showing the first ${summary.rowsShown} rows to keep the page responsive.` : ''}</p>
				</div>
			</div>
			<div class="toolbar" style="margin-bottom:16px">
				<label class="grow"><span class="lbl">Search</span><input type="search" id="playerFilterQ" placeholder="Name, UID, presence, status, guild" autocomplete="off"></label>
				<label><span class="lbl">Account</span><select id="playerFilterAccount"><option value="">All accounts</option><option value="good standing">Good standing</option><option value="banned">Banned</option></select></label>
				<label><span class="lbl">Guild</span><select id="playerFilterGuild"><option value="">All players</option><option value="guild">In guild</option><option value="solo">Solo</option></select></label>
				<span class="row-count mono" id="playerRowCount"></span>
			</div>
			<div class="table-wrap">
				<table id="playerTable">
					<thead><tr><th>Player</th><th>Level</th><th>W / L</th><th>Lumens</th><th>Status</th><th>Last Seen</th><th>Guild</th><th>Account</th></tr></thead>
					<tbody>${rowHtml || '<tr><td colspan="8">No players found.</td></tr>'}</tbody>
				</table>
			</div>
		</div>
		<script>
(function(){
	var q = document.getElementById('playerFilterQ');
	var account = document.getElementById('playerFilterAccount');
	var guild = document.getElementById('playerFilterGuild');
	var table = document.getElementById('playerTable');
	var count = document.getElementById('playerRowCount');
	if (!table) return;
	var rows = [].slice.call(table.querySelectorAll('tbody tr'));
	function apply(){
		var query = ((q && q.value) || '').toLowerCase();
		var accountVal = account ? account.value : '';
		var guildVal = guild ? guild.value : '';
		var visible = 0;
		var total = 0;
		rows.forEach(function(tr){
			var tds = tr.querySelectorAll('td');
			if (tds.length === 1 && tds[0].hasAttribute('colspan')) {
				tr.style.display = '';
				return;
			}
			total++;
			var blob = (tr.getAttribute('data-search') || '').toLowerCase();
			var rowAccount = tr.getAttribute('data-account') || '';
			var rowGuild = tr.getAttribute('data-guild') || '';
			var okQuery = !query || blob.indexOf(query) !== -1;
			var okAccount = !accountVal || rowAccount === accountVal;
			var okGuild = !guildVal || rowGuild === guildVal;
			var show = okQuery && okAccount && okGuild;
			tr.style.display = show ? '' : 'none';
			if (show) visible++;
		});
		if (count) count.textContent = visible + ' / ' + total + ' players';
	}
	if (q) q.addEventListener('input', apply);
	if (account) account.addEventListener('change', apply);
	if (guild) guild.addEventListener('change', apply);
	apply();
})();
		</script>`;
	return renderAdminShell({
		title: 'Player Health',
		pageTitle: 'Lumen Clash Admin - Players',
		subtitle: 'A dedicated admin view for account totals, active players, and overall player population health.',
		activeTab: 'players',
		embeddedSecret,
		errorMsg: opts.errorMsg || '',
		successMsg: opts.successMsg || '',
		heroMeta: embeddedSecret ? `<span class="meta-chip"><strong>${summary.totalPlayers}</strong> accounts</span><span class="meta-chip"><strong>${summary.activePlayers}</strong> active now</span>` : '',
		bodyHtml
	});
}

function renderAdminRefreshPageV2(summary, opts = {}) {
	const embeddedSecret = opts.embeddedSecret || '';
	const bodyHtml = !embeddedSecret
		? renderAdminLoginCard('/admin/refresh', 'Admin Sign In', 'Enter your admin secret to open destructive reset tools.', 'Open resets')
		: `<section class="kpi-grid">
			<div class="kpi-card"><span class="lbl">Known players</span><span class="stat-val">${summary.totalPlayers || 0}</span><div class="kpi-trend">Accounts currently indexed</div></div>
			<div class="kpi-card"><span class="lbl">Guilded players</span><span class="stat-val">${summary.guildedPlayers || 0}</span><div class="kpi-trend">Profiles currently tied to guilds</div></div>
			<div class="kpi-card"><span class="lbl">Danger zone</span><span class="stat-val">4</span><div class="kpi-trend">Reset actions available</div></div>
		</section>
		<section class="grid cols-2">
			<div class="card">
				<div class="section-head">
					<div class="section-copy">
						<h2 class="section-title">Reset Usernames</h2>
						<p class="hint">Clears current usernames so players receive a fresh random name next time they return. Known-player indexing is preserved.</p>
					</div>
				</div>
				<form method="post" action="/admin/refresh" onsubmit="return confirm('Reset all usernames? Players will be assigned fresh random names when they return.');">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="action" value="reset_usernames">
					<button type="submit" class="btn btn-warn">Reset usernames</button>
				</form>
			</div>
			<div class="card">
				<div class="section-head">
					<div class="section-copy">
						<h2 class="section-title">Reset Levels</h2>
						<p class="hint">Resets account and class progression to the starting state while keeping other data such as usernames and social identity.</p>
					</div>
				</div>
				<form method="post" action="/admin/refresh" onsubmit="return confirm('Reset all player progression levels?');">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="action" value="reset_levels">
					<button type="submit" class="btn btn-warn">Reset levels</button>
				</form>
			</div>
			<div class="card">
				<div class="section-head">
					<div class="section-copy">
						<h2 class="section-title">Reset Guilds</h2>
						<p class="hint">Wipes all guild records and removes guild membership from player profiles so you can retest guild creation from scratch.</p>
					</div>
				</div>
				<form method="post" action="/admin/refresh" onsubmit="return confirm('Reset all guild data and memberships?');">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="action" value="reset_guilds">
					<button type="submit" class="btn btn-warn">Reset guilds</button>
				</form>
			</div>
			<div class="card hero-card">
				<div class="section-head">
					<div class="section-copy">
						<h2 class="section-title">Full Game Save Reset</h2>
						<p class="hint">Wipes player profiles, usernames, leaderboard data, guild data, and moderation queue data. Use only when you want a truly clean testing state.</p>
					</div>
				</div>
				<form method="post" action="/admin/refresh" onsubmit="return confirm('FULL RESET: wipe all player save data, usernames, guilds, leaderboard, and reports?');">
					<input type="hidden" name="secret" value="${escapeAttr(embeddedSecret)}">
					<input type="hidden" name="action" value="reset_all_data">
					<button type="submit" class="btn btn-danger">Full game reset</button>
				</form>
			</div>
		</section>`;
	return renderAdminShell({
		title: 'Reset Tools',
		pageTitle: 'Lumen Clash Admin - Resets',
		subtitle: 'Controlled reset actions for testing, bug reproduction, and clean-state workflows.',
		activeTab: 'refresh',
		embeddedSecret,
		errorMsg: opts.errorMsg || '',
		successMsg: opts.successMsg || '',
		heroMeta: embeddedSecret ? `<span class="meta-chip"><strong>${summary.totalPlayers || 0}</strong> indexed players</span>` : '',
		bodyHtml
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const featureFlags = await loadFeatureFlags(env);

		if (url.pathname === '/play') {
			const charId = normalizePlayCharId(url.searchParams.get('char'));
			if (!charId) {
				return new Response(JSON.stringify({ ok: false, error: 'Missing or invalid char' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			let skin = url.searchParams.get('skin') || 'Default';
			console.log(`[GameJoin] User: ${url.searchParams.get('uid')} Class: ${charId} Skin: ${skin}`);
			let playerId = url.searchParams.get('uid') || crypto.randomUUID();
			let specificRoomId = url.searchParams.get('roomId');

			let roomId, isNew;
			let queue = url.searchParams.get('queue') || 'casual';
			if (queue === 'casual' && !featureFlags.casualQueueEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Casual queue is currently disabled.' }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			if (queue === 'ranked' && !featureFlags.rankedQueueEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Ranked queue is currently disabled.' }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			if (queue === '2v2' && !featureFlags.queue2v2Enabled) {
				return new Response(JSON.stringify({ ok: false, error: '2v2 queue is currently disabled.' }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			if (specificRoomId) {
				roomId = specificRoomId;
				isNew = true; // For private, we let the GameRoom handle uniqueness
			} else {
				let mmId = env.MATCHMAKER.idFromName('global-matchmaker');
				let mm = env.MATCHMAKER.get(mmId);
				let mmRes = await mm.fetch(`http://internal/get-room?queue=${queue}&uid=${playerId}`);
				let mmData = await mmRes.json();
				roomId = mmData.roomId;
				isNew = mmData.isNew;
			}

			let id = env.GAME_ROOM.idFromName(roomId); 
			let room = env.GAME_ROOM.get(id);

			// Check for ban before allowing join
			const profileId = env.PLAYER_PROFILE.idFromName(playerId);
			const profile = env.PLAYER_PROFILE.get(profileId);
			const profRes = await profile.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(playerId)}`));
			const profData = await profRes.json();
			if (profData.banned) {
				return new Response(JSON.stringify({ ok: false, error: 'Your account is banned from matchmaking.', bannedUntil: profData.bannedUntil }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}

			return room.fetch(new Request(`http://internal/play?roomId=${roomId}&isNew=${isNew}&char=${charId}&uid=${playerId}&skin=${skin}&queue=${queue}`, request));
		}

		if (url.pathname === '/profile') {
			let uid = url.searchParams.get('uid');
			if (!uid) return new Response('Missing UID', { status: 400, headers: corsHeaders(request) });
			let id = env.PLAYER_PROFILE.idFromName(uid);
			let profile = env.PLAYER_PROFILE.get(id);
			const res = await profile.fetch(new Request(`http://internal/get-stats?uid=${uid}`));
			return new Response(res.body, { status: res.status, headers: corsHeaders(request, { 'Content-Type': 'application/json' }) });
		}

		if (url.pathname === '/public-config') {
			const announcement = await loadAnnouncement(env);
			return new Response(JSON.stringify({ ok: true, announcement }), {
				headers: corsHeaders(request, { 'Content-Type': 'application/json' })
			});
		}

		if (url.pathname === '/guild/info') {
			const uid = url.searchParams.get('uid');
			if (!uid) {
				return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			const guild = await getGuildForUid(env, uid);
			return new Response(JSON.stringify({ ok: true, guild }), {
				headers: corsHeaders(request, { 'Content-Type': 'application/json' })
			});
		}

		if (url.pathname === '/guild/directory') {
			const guilds = await getGuildRegistry(env);
			const res = await guilds.fetch(new Request('http://internal/directory'));
			return new Response(res.body, {
				status: res.status,
				headers: corsHeaders(request, { 'Content-Type': 'application/json' })
			});
		}

		if (url.pathname === '/guild/create' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) {
					return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), {
						status: 400,
						headers: corsHeaders(request, { 'Content-Type': 'application/json' })
					});
				}
				const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const profileRes = await profile.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
				const profileData = await profileRes.json();
				const guilds = await getGuildRegistry(env);
				const res = await guilds.fetch(new Request('http://internal/create', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						uid,
						username: profileData.username || 'Player',
						name: normalizeGuildName(body.name),
						tag: normalizeGuildTag(body.tag),
						description: body.description || '',
						icon: body.icon || 'comet',
						banner: body.banner || 'aurora',
						isPublic: body.isPublic !== false
					})
				}));
				return new Response(res.body, {
					status: res.status,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
		}

		if (url.pathname === '/guild/join' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) {
					return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), {
						status: 400,
						headers: corsHeaders(request, { 'Content-Type': 'application/json' })
					});
				}
				const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const profileRes = await profile.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
				const profileData = await profileRes.json();
				const guilds = await getGuildRegistry(env);
				const res = await guilds.fetch(new Request('http://internal/join', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						uid,
						username: profileData.username || 'Player',
						code: sanitizeGuildSearchCode(body.code),
						allowPrivateJoin: body.allowPrivateJoin === true
					})
				}));
				return new Response(res.body, {
					status: res.status,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
		}

		if (url.pathname === '/guild/leave' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) {
					return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), {
						status: 400,
						headers: corsHeaders(request, { 'Content-Type': 'application/json' })
					});
				}
				const guilds = await getGuildRegistry(env);
				const res = await guilds.fetch(new Request('http://internal/leave', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ uid })
				}));
				return new Response(res.body, {
					status: res.status,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
		}

		if (url.pathname === '/guild/chat' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				const message = String(body.message || '').trim();
				if (!uid || !message) {
					return new Response(JSON.stringify({ ok: false, error: 'Missing guild chat message' }), {
						status: 400,
						headers: corsHeaders(request, { 'Content-Type': 'application/json' })
					});
				}
				const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const profileRes = await profile.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
				const profileData = await profileRes.json();
				const guilds = await getGuildRegistry(env);
				const res = await guilds.fetch(new Request('http://internal/chat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						uid,
						username: profileData.username || 'Player',
						message
					})
				}));
				return new Response(res.body, {
					status: res.status,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
		}

		if (url.pathname === '/guild/update' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) {
					return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), {
						status: 400,
						headers: corsHeaders(request, { 'Content-Type': 'application/json' })
					});
				}
				const guilds = await getGuildRegistry(env);
				const forwardBody = { uid };
				if (Object.prototype.hasOwnProperty.call(body, 'description')) forwardBody.description = body.description || '';
				if (Object.prototype.hasOwnProperty.call(body, 'icon')) forwardBody.icon = body.icon || 'comet';
				if (Object.prototype.hasOwnProperty.call(body, 'banner')) forwardBody.banner = body.banner || 'aurora';
				if (Object.prototype.hasOwnProperty.call(body, 'isPublic')) forwardBody.isPublic = body.isPublic !== false;
				if (Object.prototype.hasOwnProperty.call(body, 'recruitmentStatus')) forwardBody.recruitmentStatus = body.recruitmentStatus;
				if (Object.prototype.hasOwnProperty.call(body, 'recruitmentMessage')) forwardBody.recruitmentMessage = body.recruitmentMessage || '';
				if (Object.prototype.hasOwnProperty.call(body, 'recruitmentFocus')) forwardBody.recruitmentFocus = body.recruitmentFocus;
				if (Object.prototype.hasOwnProperty.call(body, 'recruitmentPlaystyle')) forwardBody.recruitmentPlaystyle = body.recruitmentPlaystyle;
				if (Object.prototype.hasOwnProperty.call(body, 'bulletinMessage')) forwardBody.bulletinMessage = body.bulletinMessage || '';
				const res = await guilds.fetch(new Request('http://internal/update', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(forwardBody)
				}));
				return new Response(res.body, {
					status: res.status,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
		}

		if (url.pathname === '/guild/member-role' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) {
					return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), {
						status: 400,
						headers: corsHeaders(request, { 'Content-Type': 'application/json' })
					});
				}
				const guilds = await getGuildRegistry(env);
				const res = await guilds.fetch(new Request('http://internal/member-role', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						uid,
						targetUid: body.targetUid,
						role: body.role
					})
				}));
				return new Response(res.body, {
					status: res.status,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
					status: 400,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
		}

		if (url.pathname === '/set-username' || url.pathname === '/save-customization') {
			if (request.method === 'OPTIONS') {
				return new Response(null, { headers: corsHeaders(request, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }) });
			}
			
			if (url.pathname === '/save-customization') {
				try {
					const body = await request.json();
					const uid = body.uid;
					if (!uid) return new Response('Missing UID', { status: 400, headers: corsHeaders(request) });
					let profileId = env.PLAYER_PROFILE.idFromName(uid);
					let profile = env.PLAYER_PROFILE.get(profileId);
					const res = await profile.fetch(new Request('http://internal/save-customization', {
						method: 'POST',
						body: JSON.stringify(body),
						headers: { 'Content-Type': 'application/json' }
					}));
					return new Response(res.body, { status: res.status, headers: corsHeaders(request, { 'Content-Type': 'application/json' }) });
				} catch(e) {
					return new Response('Invalid Request', { status: 400, headers: corsHeaders(request) });
				}
			}

			try {
				const body = await request.json();
				const uid = body.uid;
				const newName = (body.username || '').trim();
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`set-username:${uid || clientIp}:${clientIp}`, 8, 60_000)) {
					return new Response(JSON.stringify({ ok: false, error: 'Too many rename attempts. Try again in a minute.' }), { status: 429, headers: corsHeaders(request) });
				}
				if (!uid || !newName) return new Response(JSON.stringify({ ok: false, error: 'Missing fields' }), { status: 400, headers: corsHeaders(request) });
				if (newName.length < 3 || newName.length > 16) return new Response(JSON.stringify({ ok: false, error: 'Username must be 3-16 characters' }), { status: 400, headers: corsHeaders(request) });
				if (!/^[a-zA-Z0-9_]+$/.test(newName)) return new Response(JSON.stringify({ ok: false, error: 'Letters, numbers, and underscores only' }), { status: 400, headers: corsHeaders(request) });

				// Check uniqueness via global registry
				let regId = env.USERNAME_REGISTRY.idFromName('global');
				let registry = env.USERNAME_REGISTRY.get(regId);
				let regRes = await registry.fetch(new Request(`http://internal/claim?name=${encodeURIComponent(newName)}&uid=${uid}`));
				let regData = await regRes.json();
				if (!regData.ok) return new Response(JSON.stringify(regData), { status: 409, headers: corsHeaders(request) });

				// Save in profile
				let profileId = env.PLAYER_PROFILE.idFromName(uid);
				let profile = env.PLAYER_PROFILE.get(profileId);
				await profile.fetch(new Request(`http://internal/set-name?name=${encodeURIComponent(newName)}`));

				return new Response(JSON.stringify({ ok: true, username: newName }), { headers: corsHeaders(request) });
			} catch(e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), { status: 400, headers: corsHeaders(request) });
			}
		}

		if (url.pathname === '/leaderboard') {
			let lbId = env.LEADERBOARD.idFromName('global');
			let lb = env.LEADERBOARD.get(lbId);
			const res = await lb.fetch(new Request('http://internal/top'));
			return new Response(res.body, { status: res.status, headers: corsHeaders(request, { 'Content-Type': 'application/json' }) });
		}

		if (url.pathname === '/add-friend') {
			const body = await request.json();
			const { uid, friendName } = body;
			const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
			if (isRateLimited(`add-friend:${uid || clientIp}:${clientIp}`, 25, 60_000)) {
				return new Response(JSON.stringify({ ok: false, error: 'Rate limit exceeded. Try again shortly.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
			}
			if (!uid || !friendName) return new Response('Missing fields', { status: 400 });
			
			// 1. Find friend's UID
			let regId = env.USERNAME_REGISTRY.idFromName('global');
			let registry = env.USERNAME_REGISTRY.get(regId);
			let regRes = await registry.fetch(new Request(`http://internal/get-uid?name=${encodeURIComponent(friendName)}`));
			let regData = await regRes.json();
			if (!regData.ok) return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { status: 404 });
			
			const friendUid = regData.uid;
			if (uid === friendUid) return new Response(JSON.stringify({ ok: false, error: "Can't friend yourself" }), { status: 400 });

			// 2. Add to target's pending requests
			let p2 = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(friendUid));
			await p2.fetch(new Request(`http://internal/friend-request?from=${uid}`));
			
			return new Response(JSON.stringify({ ok: true, msg: 'Request sent!' }), { headers: { 'Content-Type': 'application/json' }});
		}

		if (url.pathname === '/accept-friend') {
			const body = await request.json();
			const { uid, friendUid } = body;
			if (!uid || !friendUid) return new Response('Missing fields', { status: 400 });
			
			let p1 = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			let p2 = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(friendUid));
			
			// Add to both friends lists
			await p1.fetch(new Request(`http://internal/friend-accept?target=${friendUid}`));
			await p2.fetch(new Request(`http://internal/friend-accept?target=${uid}`));
			
			return new Response(JSON.stringify({ ok: true }));
		}

		if (url.pathname === '/decline-friend') {
			const body = await request.json();
			const { uid, friendUid } = body;
			let p1 = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			await p1.fetch(new Request(`http://internal/friend-decline?target=${friendUid}`));
			return new Response(JSON.stringify({ ok: true }));
		}

		if (url.pathname === '/remove-friend') {
			const body = await request.json();
			const { uid, friendUid } = body;
			let p1 = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			let p2 = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(friendUid));
			await p1.fetch(new Request(`http://internal/friend-remove?target=${friendUid}`));
			await p2.fetch(new Request(`http://internal/friend-remove?target=${uid}`));
			return new Response(JSON.stringify({ ok: true }));
		}

		if (url.pathname === '/friends-status') {
			const uid = url.searchParams.get('uid');
			if (!uid) return new Response('Missing UID', { status: 400, headers: corsHeaders(request) });
			let p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			let res = await p.fetch(new Request(`http://internal/get-lobby-data`));
			let data = await res.json();
			return new Response(JSON.stringify({ ...(data.social || {}), guild: data.guild || null }), { headers: corsHeaders(request, { 'Content-Type': 'application/json' }) });
		}

		const jsonHeaders = corsHeaders(request, { 'Content-Type': 'application/json' });

		if (url.pathname === '/update-presence' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = body.uid;
				if (!uid) return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400, headers: jsonHeaders });
				const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const res = await profile.fetch(
					new Request('http://internal/update-presence', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ state: body.state })
					})
				);
				return new Response(res.body, { status: res.status, headers: jsonHeaders });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/friend-invite-send' && request.method === 'POST') {
			if (!featureFlags.friendInvitesEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Friend invites are currently disabled.' }), { status: 403, headers: jsonHeaders });
			}
			try {
				const body = await request.json();
				const { uid, targetUid, type } = body;
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`friend-invite-send:${uid || clientIp}:${clientIp}`, 20, 60_000)) {
					return new Response(JSON.stringify({ ok: false, error: 'Rate limit exceeded. Try again shortly.' }), { status: 429, headers: jsonHeaders });
				}
				if (!uid || !targetUid || uid === targetUid || !type) {
					return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), { status: 400, headers: jsonHeaders });
				}
				if (type === 'duel' && !featureFlags.privateMatchesEnabled) {
					return new Response(JSON.stringify({ ok: false, error: 'Private matches are currently disabled.' }), { status: 403, headers: jsonHeaders });
				}
				if (type === 'party' && !featureFlags.partyModeEnabled) {
					return new Response(JSON.stringify({ ok: false, error: 'Party mode is currently disabled.' }), { status: 403, headers: jsonHeaders });
				}
				const pSelf = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const selfRes = await pSelf.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
				const selfData = await selfRes.json();
				if (!selfData.friends || !selfData.friends.includes(targetUid)) {
					return new Response(JSON.stringify({ ok: false, error: 'You can only send invites to friends' }), { status: 403, headers: jsonHeaders });
				}
				const pTarget = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(targetUid));
				const targetRes = await pTarget.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(targetUid)}`));
				const targetData = await targetRes.json();
				
				let roomPayload = { roomId: null, code: null, partyId: null, guildId: null, guildName: null, guildTag: null, joinCode: null };
				if (type === 'duel') {
					const mmId = env.MATCHMAKER.idFromName('global-matchmaker');
					const mmRes = await env.MATCHMAKER.get(mmId).fetch(new Request('http://internal/create-private'));
					roomPayload = await mmRes.json();
					if (!roomPayload.roomId || !roomPayload.code) {
						return new Response(JSON.stringify({ ok: false, error: 'Could not create room' }), { status: 500, headers: jsonHeaders });
					}
				} else if (type === 'party') {
					roomPayload.partyId = 'party-' + crypto.randomUUID();
				} else if (type === 'guild') {
					const guild = await getGuildForUid(env, uid);
					if (!guild) {
						return new Response(JSON.stringify({ ok: false, error: 'You must be in a guild to invite a friend.' }), { status: 400, headers: jsonHeaders });
					}
					if (targetData.guildId || targetData.guild) {
						return new Response(JSON.stringify({ ok: false, error: 'That friend is already in a guild.' }), { status: 400, headers: jsonHeaders });
					}
					roomPayload.guildId = guild.id;
					roomPayload.guildName = guild.name;
					roomPayload.guildTag = guild.tag;
					roomPayload.joinCode = guild.joinCode;
				}

				await pTarget.fetch(
					new Request('http://internal/invite-send', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							type,
							fromUid: uid,
							roomId: roomPayload.roomId,
							partyId: roomPayload.partyId,
							code: roomPayload.code,
							guildId: roomPayload.guildId,
							guildName: roomPayload.guildName,
							guildTag: roomPayload.guildTag,
							joinCode: roomPayload.joinCode
						})
					})
				);
				return new Response(
					JSON.stringify({ ok: true, type, roomId: roomPayload.roomId, partyId: roomPayload.partyId, code: roomPayload.code, guildId: roomPayload.guildId, guildName: roomPayload.guildName, guildTag: roomPayload.guildTag, joinCode: roomPayload.joinCode }),
					{ headers: jsonHeaders }
				);
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Server error' }), { status: 500, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/friend-invite-decline' && request.method === 'POST') {
			try {
				const body = await request.json();
				const { uid, fromUid, type } = body;
				if (!uid || !fromUid || !type) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
				const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				await p.fetch(
					new Request('http://internal/invite-remove', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ fromUid })
					})
				);
				return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/friend-invite-accept' && request.method === 'POST') {
			try {
				const body = await request.json();
				const { uid, fromUid, type } = body;
				if (!uid || !fromUid || !type) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
				const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const res = await p.fetch(
					new Request('http://internal/invite-take', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ fromUid })
					})
				);
				const data = await res.json();
				if (data.ok && data.type === 'guild' && data.joinCode) {
					const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
					const profileRes = await profile.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
					const profileData = await profileRes.json();
					const guilds = await getGuildRegistry(env);
					const joinRes = await guilds.fetch(new Request('http://internal/join', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							uid,
							username: profileData.username || 'Player',
							code: data.joinCode
						})
					}));
					const joinData = await joinRes.json();
					if (!joinData.ok) {
						return new Response(JSON.stringify(joinData), { status: joinRes.status, headers: jsonHeaders });
					}
					data.guild = joinData.guild;
				}
				return new Response(JSON.stringify(data), { headers: jsonHeaders });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/create-private') {
			if (!featureFlags.privateMatchesEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Private matches are currently disabled.' }), {
					status: 403,
					headers: jsonHeaders
				});
			}
			let mmId = env.MATCHMAKER.idFromName('global-matchmaker');
			return env.MATCHMAKER.get(mmId).fetch(new Request('http://internal/create-private'));
		}

		if (url.pathname === '/lobby-update') {
			const uid = url.searchParams.get('uid');
			if (!uid) return new Response('Missing UID', { status: 400 });

			// Fetch Profile + Social + Leaderboard in parallel
			const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			const lb = env.LEADERBOARD.get(env.LEADERBOARD.idFromName('global'));

			const [profRes, lbRes] = await Promise.all([
				p.fetch(new Request(`http://internal/get-lobby-data`)),
				lb.fetch(new Request(`http://internal/get-top-cached`))
			]);

			const profData = await profRes.json();
			const lbData = await lbRes.json();

			return new Response(JSON.stringify({
				...profData,
				leaderboard: lbData
			}), { headers: { 'Content-Type': 'application/json' }});
		}

		if (url.pathname === '/join-private') {
			if (!featureFlags.privateMatchesEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Private matches are currently disabled.' }), {
					status: 403,
					headers: jsonHeaders
				});
			}
			let code = url.searchParams.get('code');
			let mmId = env.MATCHMAKER.idFromName('global-matchmaker');
			return env.MATCHMAKER.get(mmId).fetch(new Request(`http://internal/join-private?code=${code}`));
		}

		if (url.pathname === '/admin/lookup') {
			const configured = getAdminReportsSecret(env);
			const secret = adminSecretFromRequest(request) || url.searchParams.get('secret');
			if (!configured || secret !== configured) {
				return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401 });
			}
			const query = url.searchParams.get('q');
			if (!query) return new Response(JSON.stringify({ ok: false, error: 'Missing query' }), { status: 400 });

			let uid = query;
			if (!/^[0-9a-f-]{36}$/i.test(query)) {
				// Search by name
				const reg = env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global'));
				const regRes = await reg.fetch(new Request(`http://internal/get-uid?name=${encodeURIComponent(query)}`));
				const regData = await regRes.json();
				if (!regData.ok) return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { status: 404 });
				uid = regData.uid;
			}

			const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			const res = await p.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
			const data = await res.json();
			return new Response(JSON.stringify({ ok: true, profile: data }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/admin') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(
					renderAdminDashboardPageV2({ reports: [], activeEvents: [], eventsCatalog: [] }, {
						errorMsg: 'ADMIN_REPORTS_SECRET is not configured - run: wrangler secret put ADMIN_REPORTS_SECRET'
					}),
					{ status: 503, headers: ADMIN_HTML_HEADERS }
				);
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					try {
						const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
						const listRes = await hub.fetch(new Request('http://internal/list'));
						const data = await listRes.json();
						const eventsCatalog = await eventsCatalogForClient(env);
						const activeEvents = await getActiveEvents(env);
						const playerSummary = await loadAdminPlayerOverview(env, { includeRows: false });
						return new Response(
							renderAdminDashboardPageV2(
								{ reports: data.reports || [], activeEvents, eventsCatalog, playerSummary },
								{ embeddedSecret: secret }
							),
							{ headers: ADMIN_HTML_HEADERS }
						);
					} catch (e) {
						const eventsCatalog = await eventsCatalogForClient(env);
						const activeEvents = await getActiveEvents(env);
						return new Response(
							renderAdminDashboardPageV2(
								{ reports: [], activeEvents, eventsCatalog, playerSummary: null },
								{ embeddedSecret: secret, errorMsg: 'Could not load admin summary.' }
							),
							{ status: 500, headers: ADMIN_HTML_HEADERS }
						);
					}
				}
				return new Response(renderAdminDashboardPageV2({ reports: [], activeEvents: [], eventsCatalog: [] }, {}), {
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-home:${clientIp}`, 30, 60_000)) {
					return new Response(
						renderAdminDashboardPageV2({ reports: [], activeEvents: [], eventsCatalog: [] }, { errorMsg: 'Too many attempts. Try again in a minute.' }),
						{ status: 429, headers: ADMIN_HTML_HEADERS }
					);
				}
				const okSecret = await parseAdminSecretBody(request.clone(), configured);
				if (!okSecret) {
					return new Response(
						renderAdminDashboardPageV2({ reports: [], activeEvents: [], eventsCatalog: [] }, { errorMsg: 'Invalid secret.' }),
						{ status: 401, headers: ADMIN_HTML_HEADERS }
					);
				}
				try {
					const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
					const listRes = await hub.fetch(new Request('http://internal/list'));
					const data = await listRes.json();
					const eventsCatalog = await eventsCatalogForClient(env);
					const activeEvents = await getActiveEvents(env);
					const playerSummary = await loadAdminPlayerOverview(env, { includeRows: false });
					return new Response(
						renderAdminDashboardPageV2(
							{ reports: data.reports || [], activeEvents, eventsCatalog, playerSummary },
							{ embeddedSecret: okSecret }
						),
						{ headers: ADMIN_HTML_HEADERS }
					);
				} catch (e) {
					const eventsCatalog = await eventsCatalogForClient(env);
					const activeEvents = await getActiveEvents(env);
					return new Response(
						renderAdminDashboardPageV2(
							{ reports: [], activeEvents, eventsCatalog, playerSummary: null },
							{ embeddedSecret: okSecret, errorMsg: 'Could not load admin summary.' }
						),
						{ status: 500, headers: ADMIN_HTML_HEADERS }
					);
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/players') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(renderAdminPlayersPageV2({ totalPlayers: 0, activePlayers: 0, recent24h: 0, totalMatches: 0, bannedPlayers: 0, guildedPlayers: 0, rows: [] }, { errorMsg: 'ADMIN_REPORTS_SECRET is not configured.' }), {
					status: 503,
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					try {
						const playerSummary = await loadAdminPlayerOverview(env);
						return new Response(renderAdminPlayersPageV2(playerSummary, { embeddedSecret: secret }), {
							headers: ADMIN_HTML_HEADERS
						});
					} catch (e) {
						return new Response(renderAdminPlayersPageV2({ totalPlayers: 0, activePlayers: 0, recent24h: 0, totalMatches: 0, bannedPlayers: 0, guildedPlayers: 0, rows: [] }, { embeddedSecret: secret, errorMsg: 'Could not load player overview.' }), {
							status: 500,
							headers: ADMIN_HTML_HEADERS
						});
					}
				}
				return new Response(renderAdminPlayersPageV2({ totalPlayers: 0, activePlayers: 0, recent24h: 0, totalMatches: 0, bannedPlayers: 0, guildedPlayers: 0, rows: [] }, {}), {
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-players:${clientIp}`, 30, 60_000)) {
					return new Response(renderAdminPlayersPageV2({ totalPlayers: 0, activePlayers: 0, recent24h: 0, totalMatches: 0, bannedPlayers: 0, guildedPlayers: 0, rows: [] }, { errorMsg: 'Too many attempts. Try again in a minute.' }), {
						status: 429,
						headers: ADMIN_HTML_HEADERS
					});
				}
				const okSecret = await parseAdminSecretBody(request.clone(), configured);
				if (!okSecret) {
					return new Response(renderAdminPlayersPageV2({ totalPlayers: 0, activePlayers: 0, recent24h: 0, totalMatches: 0, bannedPlayers: 0, guildedPlayers: 0, rows: [] }, { errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: ADMIN_HTML_HEADERS
					});
				}
				try {
					const playerSummary = await loadAdminPlayerOverview(env);
					return new Response(renderAdminPlayersPageV2(playerSummary, { embeddedSecret: okSecret }), {
						headers: ADMIN_HTML_HEADERS
					});
				} catch (e) {
					return new Response(renderAdminPlayersPageV2({ totalPlayers: 0, activePlayers: 0, recent24h: 0, totalMatches: 0, bannedPlayers: 0, guildedPlayers: 0, rows: [] }, { embeddedSecret: okSecret, errorMsg: 'Could not load player overview.' }), {
						status: 500,
						headers: ADMIN_HTML_HEADERS
					});
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/refresh') {
			const configured = getAdminReportsSecret(env);
			const emptySummary = { totalPlayers: 0, guildedPlayers: 0 };
			if (!configured) {
				return new Response(renderAdminRefreshPageV2(emptySummary, { errorMsg: 'ADMIN_REPORTS_SECRET is not configured.' }), {
					status: 503,
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					try {
						const playerSummary = await loadAdminPlayerOverview(env, { includeRows: false });
						return new Response(renderAdminRefreshPageV2(playerSummary, { embeddedSecret: secret }), {
							headers: ADMIN_HTML_HEADERS
						});
					} catch (e) {
						return new Response(renderAdminRefreshPageV2(emptySummary, { embeddedSecret: secret, errorMsg: 'Could not load reset overview.' }), {
							status: 500,
							headers: ADMIN_HTML_HEADERS
						});
					}
				}
				return new Response(renderAdminRefreshPageV2(emptySummary, {}), {
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-refresh:${clientIp}`, 20, 60_000)) {
					return new Response(renderAdminRefreshPageV2(emptySummary, { errorMsg: 'Too many reset attempts. Try again in a minute.' }), {
						status: 429,
						headers: ADMIN_HTML_HEADERS
					});
				}
				const okSecret = await parseAdminSecretBody(request.clone(), configured);
				if (!okSecret) {
					return new Response(renderAdminRefreshPageV2(emptySummary, { errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: ADMIN_HTML_HEADERS
					});
				}
				let successMsg = '';
				let errorMsg = '';
				try {
					const form = await request.clone().formData();
					const action = String(form.get('action') || '').trim();
					const knownPlayers = await listKnownPlayers(env);
					if (action === 'reset_usernames') {
						const processed = await runForKnownPlayers(env, knownPlayers, (uid) => performResetUsername(env, uid));
						const reg = env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global'));
						await reg.fetch(new Request('http://internal/wipe-usernames', { method: 'POST' }));
						successMsg = `Reset usernames for ${processed} players.`;
					} else if (action === 'reset_levels') {
						const processed = await runForKnownPlayers(env, knownPlayers, (uid) => performResetLevels(env, uid));
						successMsg = `Reset progression for ${processed} players.`;
					} else if (action === 'reset_guilds') {
						const processed = await runForKnownPlayers(env, knownPlayers, (uid) => performClearGuildMembership(env, uid));
						const guilds = await getGuildRegistry(env);
						await guilds.fetch(new Request('http://internal/wipe', { method: 'POST' }));
						successMsg = `Reset guild data and cleared memberships for ${processed} players.`;
					} else if (action === 'reset_all_data') {
						const processed = await runForKnownPlayers(env, knownPlayers, (uid) => performResetPlayer(env, uid));
						await env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global')).fetch(new Request('http://internal/wipe'));
						await env.LEADERBOARD.get(env.LEADERBOARD.idFromName('global')).fetch(new Request('http://internal/wipe'));
						const guilds = await getGuildRegistry(env);
						await guilds.fetch(new Request('http://internal/wipe', { method: 'POST' }));
						const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
						await hub.fetch(new Request('http://internal/wipe', { method: 'POST' }));
						successMsg = `Full game save reset completed for ${processed} indexed players.`;
					} else {
						errorMsg = 'Unknown reset action.';
					}
				} catch (e) {
					errorMsg = 'Reset action failed.';
				}
				try {
					const playerSummary = await loadAdminPlayerOverview(env, { includeRows: false });
					return new Response(renderAdminRefreshPageV2(playerSummary, { embeddedSecret: okSecret, successMsg, errorMsg }), {
						status: errorMsg && !successMsg ? 400 : 200,
						headers: ADMIN_HTML_HEADERS
					});
				} catch (e) {
					return new Response(renderAdminRefreshPageV2(emptySummary, { embeddedSecret: okSecret, successMsg, errorMsg: errorMsg || 'Could not reload reset overview.' }), {
						status: 500,
						headers: ADMIN_HTML_HEADERS
					});
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/events') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(
					renderAdminEventsPageV2({
						errorMsg: 'ADMIN_REPORTS_SECRET is not configured - run: wrangler secret put ADMIN_REPORTS_SECRET'
					}),
					{ status: 503, headers: ADMIN_HTML_HEADERS }
				);
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					const eventsCatalog = await eventsCatalogForClient(env);
					const activeEvents = await getActiveEvents(env);
					return new Response(
						renderAdminEventsPageV2({
							embeddedSecret: secret,
							activeEvents,
							eventsCatalog
						}),
						{ headers: ADMIN_HTML_HEADERS }
					);
				}
				return new Response(renderAdminEventsPageV2({}), { headers: ADMIN_HTML_HEADERS });
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-events:${clientIp}`, 30, 60_000)) {
					return new Response(renderAdminEventsPageV2({ errorMsg: 'Too many attempts. Try again in a minute.' }), {
						status: 429,
						headers: ADMIN_HTML_HEADERS
					});
				}
				const okSecret = await parseAdminSecretBody(request.clone(), configured);
				if (!okSecret) {
					return new Response(renderAdminEventsPageV2({ errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: ADMIN_HTML_HEADERS
					});
				}
				let successMsg = '';
				let errorMsg = '';
				try {
					const form = await request.clone().formData();
					const action = String(form.get('action') || '').trim();
					let events = await loadEventsCatalog(env);
					if (action === 'create_event') {
						const id = String(form.get('eventId') || '').trim() || `event_${Date.now()}`;
						const name = String(form.get('eventName') || '').trim();
						const startInput = String(form.get('startAt') || '').trim();
						const endInput = String(form.get('endAt') || '').trim();
						const xpMultiplier = Number(form.get('xpMultiplier'));
						const lumenMultiplier = Number(form.get('lumenMultiplier'));
						const grantedTitles = String(form.get('grantedTitles') || '')
							.split(',')
							.map((x) => x.trim())
							.filter(Boolean);
						const grantedCosmetics = String(form.get('grantedCosmetics') || '')
							.split(',')
							.map((x) => x.trim())
							.filter(Boolean);
						const startMs = Date.parse(startInput);
						const endMs = Date.parse(endInput);
						if (!name || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
							errorMsg = 'Provide a name plus valid start and end times.';
						} else if (events.some((ev) => ev.id === id)) {
							errorMsg = `An event with id "${id}" already exists.`;
						} else {
							events.push({
								id,
								name,
								startMs,
								endMs,
								xpMultiplier,
								lumenMultiplier,
								grantedTitles,
								grantedCosmetics,
								forceActive: false,
								forceStopped: false
							});
							await saveEventsCatalog(env, events);
							successMsg = `Queued event "${name}".`;
						}
					} else if (action === 'start_event' || action === 'stop_event' || action === 'resume_event' || action === 'delete_event') {
						const eventId = String(form.get('eventId') || '').trim();
						const idx = events.findIndex((ev) => ev.id === eventId);
						if (idx === -1) {
							errorMsg = 'Event not found.';
						} else if (action === 'delete_event') {
							const removed = events[idx];
							events.splice(idx, 1);
							await saveEventsCatalog(env, events);
							successMsg = `Deleted event "${removed.name}".`;
						} else {
							if (action === 'start_event') {
								events[idx].forceActive = true;
								events[idx].forceStopped = false;
								successMsg = `Started "${events[idx].name}".`;
							} else if (action === 'stop_event') {
								events[idx].forceActive = false;
								events[idx].forceStopped = true;
								successMsg = `Stopped "${events[idx].name}".`;
							} else if (action === 'resume_event') {
								events[idx].forceActive = false;
								events[idx].forceStopped = false;
								successMsg = `Returned "${events[idx].name}" to scheduled mode.`;
							}
							await saveEventsCatalog(env, events);
						}
					}
				} catch (e) {
					errorMsg = 'Could not update events.';
				}
				const eventsCatalog = await eventsCatalogForClient(env);
				const activeEvents = await getActiveEvents(env);
				return new Response(
					renderAdminEventsPageV2({
						embeddedSecret: okSecret,
						activeEvents,
						eventsCatalog,
						successMsg,
						errorMsg
					}),
					{ headers: ADMIN_HTML_HEADERS }
				);
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/flags') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(renderAdminFlagsPageV2({ errorMsg: 'ADMIN_REPORTS_SECRET is not configured.' }), {
					status: 503,
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					return new Response(renderAdminFlagsPageV2({ embeddedSecret: secret, flags: await loadFeatureFlags(env) }), {
						headers: ADMIN_HTML_HEADERS
					});
				}
				return new Response(renderAdminFlagsPageV2({}), { headers: ADMIN_HTML_HEADERS });
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-flags:${clientIp}`, 30, 60_000)) {
					return new Response(renderAdminFlagsPageV2({ errorMsg: 'Too many attempts. Try again in a minute.' }), {
						status: 429,
						headers: ADMIN_HTML_HEADERS
					});
				}
				const okSecret = await parseAdminSecretBody(request.clone(), configured);
				if (!okSecret) {
					return new Response(renderAdminFlagsPageV2({ errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: ADMIN_HTML_HEADERS
					});
				}
				try {
					const form = await request.clone().formData();
					const flagName = String(form.get('flagName') || '').trim();
					const flagValue = String(form.get('flagValue') || '').trim().toLowerCase();
					const currentFlags = await loadFeatureFlags(env);
					if (!(flagName in currentFlags)) {
						return new Response(renderAdminFlagsPageV2({ embeddedSecret: okSecret, flags: currentFlags, errorMsg: 'Unknown feature flag.' }), {
							status: 400,
							headers: ADMIN_HTML_HEADERS
						});
					}
					const flags = {
						...currentFlags,
						[flagName]: flagValue === 'true'
					};
					const saved = await saveFeatureFlags(env, flags);
					return new Response(renderAdminFlagsPageV2({ embeddedSecret: okSecret, flags: saved, successMsg: 'Feature flags updated.' }), {
						headers: ADMIN_HTML_HEADERS
					});
				} catch (e) {
					return new Response(renderAdminFlagsPageV2({ embeddedSecret: okSecret, flags: await loadFeatureFlags(env), errorMsg: 'Could not save feature flags.' }), {
						status: 500,
						headers: ADMIN_HTML_HEADERS
					});
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/announcements') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(renderAdminAnnouncementsPageV2({ errorMsg: 'ADMIN_REPORTS_SECRET is not configured.' }), {
					status: 503,
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					return new Response(renderAdminAnnouncementsPageV2({ embeddedSecret: secret, announcement: await loadAnnouncement(env) }), {
						headers: ADMIN_HTML_HEADERS
					});
				}
				return new Response(renderAdminAnnouncementsPageV2({}), { headers: ADMIN_HTML_HEADERS });
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-announcements:${clientIp}`, 30, 60_000)) {
					return new Response(renderAdminAnnouncementsPageV2({ errorMsg: 'Too many attempts. Try again in a minute.' }), {
						status: 429,
						headers: ADMIN_HTML_HEADERS
					});
				}
				const okSecret = await parseAdminSecretBody(request.clone(), configured);
				if (!okSecret) {
					return new Response(renderAdminAnnouncementsPageV2({ errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: ADMIN_HTML_HEADERS
					});
				}
				try {
					const form = await request.clone().formData();
					const action = String(form.get('action') || '').trim();
					let announcement;
					if (action === 'clear') {
						announcement = await saveAnnouncement(env, { active: false, message: '' });
						return new Response(renderAdminAnnouncementsPageV2({ embeddedSecret: okSecret, announcement, successMsg: 'Announcement cleared.' }), {
							headers: ADMIN_HTML_HEADERS
						});
					}
					const message = String(form.get('message') || '').trim();
					if (!message) {
						return new Response(renderAdminAnnouncementsPageV2({ embeddedSecret: okSecret, announcement: await loadAnnouncement(env), errorMsg: 'Enter a message before publishing.' }), {
							status: 400,
							headers: ADMIN_HTML_HEADERS
						});
					}
					announcement = await saveAnnouncement(env, { active: true, message });
					return new Response(renderAdminAnnouncementsPageV2({ embeddedSecret: okSecret, announcement, successMsg: 'Announcement published.' }), {
						headers: ADMIN_HTML_HEADERS
					});
				} catch (e) {
					return new Response(renderAdminAnnouncementsPageV2({ embeddedSecret: okSecret, announcement: await loadAnnouncement(env), errorMsg: 'Could not update announcement.' }), {
						status: 500,
						headers: ADMIN_HTML_HEADERS
					});
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/join-party') {
			if (!featureFlags.partyModeEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Party mode is currently disabled.' }), {
					status: 403,
					headers: jsonHeaders
				});
			}
			const partyId = url.searchParams.get('partyId');
			if (!partyId) return new Response('Missing partyId', { status: 400 });
			const id = env.PARTY_ROOM.idFromName(partyId);
			const room = env.PARTY_ROOM.get(id);
			return room.fetch(request);
		}

		if (url.pathname === '/admin/reports') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(
					renderReportsAdminPageV2([], {}, {
						errorMsg: 'ADMIN_REPORTS_SECRET is not configured — run: wrangler secret put ADMIN_REPORTS_SECRET'
					}),
					{ status: 503, headers: ADMIN_HTML_HEADERS }
				);
			}
			if (request.method === 'GET') {
				const secret = adminSecretFromRequest(request) || url.searchParams.get('secret') || '';
				if (secret && secret === configured) {
					try {
						const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
						const listRes = await hub.fetch(new Request('http://internal/list'));
						const data = await listRes.json();
						const reports = data.reports || [];
						const nameByUid = await resolveReportPlayerNames(env, reports);
						return new Response(renderReportsAdminPageV2(reports, nameByUid, { embeddedSecret: secret }), {
							headers: ADMIN_HTML_HEADERS
						});
					} catch (e) {
						return new Response(renderReportsAdminPageV2([], {}, { embeddedSecret: secret, errorMsg: 'Could not load reports.' }), {
							status: 500,
							headers: ADMIN_HTML_HEADERS
						});
					}
				}
				return new Response(renderReportsAdminPageV2([], {}, {}), {
					headers: ADMIN_HTML_HEADERS
				});
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-reports:${clientIp}`, 30, 60_000)) {
					return new Response(renderReportsAdminPageV2([], {}, { errorMsg: 'Too many attempts. Try again in a minute.' }), {
						status: 429,
						headers: ADMIN_HTML_HEADERS
					});
				}
				let secretInput = adminSecretFromRequest(request);
				if (!secretInput) {
					try {
						const ct = (request.headers.get('Content-Type') || '').toLowerCase();
						if (ct.includes('application/json')) {
							const j = await request.json();
							secretInput = (j && j.secret) || '';
						} else {
							const form = await request.formData();
							secretInput = form.get('secret') || '';
						}
					} catch (e) {
						secretInput = '';
					}
				}
				if (!secretInput || secretInput !== configured) {
					return new Response(renderReportsAdminPageV2([], {}, { errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: ADMIN_HTML_HEADERS
					});
				}
				try {
					const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
					const listRes = await hub.fetch(new Request('http://internal/list'));
					const data = await listRes.json();
					const reports = data.reports || [];
					const nameByUid = await resolveReportPlayerNames(env, reports);
					return new Response(renderReportsAdminPageV2(reports, nameByUid, { embeddedSecret: secretInput }), {
						headers: ADMIN_HTML_HEADERS
					});
				} catch (e) {
					return new Response(renderReportsAdminPageV2([], {}, { errorMsg: 'Could not load reports.' }), {
						status: 500,
						headers: ADMIN_HTML_HEADERS
					});
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/moderate') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(
					renderReportsAdminPageV2([], {}, { errorMsg: 'ADMIN_REPORTS_SECRET is not configured.' }),
					{ status: 503, headers: ADMIN_HTML_HEADERS }
				);
			}
			if (request.method !== 'POST') {
				// Help the user find the dashboard if they navigate here by mistake
				return new Response('Redirection to Admin Dashboard...', {
					status: 302,
					headers: { 'Location': '/admin/reports' }
				});
			}
			const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
			if (isRateLimited(`admin-moderate:${clientIp}`, 40, 60_000)) {
				return new Response(renderReportsAdminPageV2([], {}, { errorMsg: 'Too many moderation attempts. Wait a minute.' }), {
					status: 429,
					headers: ADMIN_HTML_HEADERS
				});
			}
			const okSecret = await parseAdminSecretBody(request.clone(), configured);
			if (!okSecret) {
				return new Response(renderReportsAdminPageV2([], {}, { errorMsg: 'Invalid secret.' }), {
					status: 401,
					headers: ADMIN_HTML_HEADERS
				});
			}
			let action = '';
			let targetUid = '';
			let ts = null;
			let reporterUid = '';
			let reportedUid = '';
			try {
				const ct = (request.headers.get('Content-Type') || '').toLowerCase();
				if (ct.includes('application/json')) {
					const j = await request.json();
					action = String(j.action || '');
					targetUid = String(j.targetUid || '').trim();
					ts = j.ts != null ? Number(j.ts) : null;
					reporterUid = String(j.reporterUid || '');
					reportedUid = String(j.reportedUid || '');
				} else {
					const form = await request.formData();
					action = String(form.get('action') || '');
					targetUid = String(form.get('targetUid') || '').trim();
					const tss = form.get('ts');
					ts = tss != null && tss !== '' ? Number(tss) : null;
					reporterUid = String(form.get('reporterUid') || '');
					reportedUid = String(form.get('reportedUid') || '');
				}
			} catch (e) {
				action = '';
			}
			let successMsg = '';
			let errFlash = '';
			try {
				if (action === 'reset_player' && targetUid) {
					await performResetPlayer(env, targetUid);
					successMsg = `Account reset completed for UID ${targetUid}.`;
				} else if (action === 'ban_player' && targetUid) {
					const hours = ts; // We'll hijack 'ts' field for hours if action is ban
					await performBanPlayer(env, targetUid, hours);
					successMsg = hours ? `Temporary ban (${hours}h) applied to UID ${targetUid}.` : `Permanent ban applied to UID ${targetUid}.`;
				} else if (action === 'unban_player' && targetUid) {
					await performUnbanPlayer(env, targetUid);
					successMsg = `Unbanned UID ${targetUid}.`;
				} else if (action === 'adjust_stats' && targetUid) {
					let adjustments = {};
					if (ct.includes('application/json')) {
						const j = await request.clone().json();
						adjustments = j;
					} else {
						const form = await request.clone().formData();
						if (form.get('lumens') !== null) adjustments.lumens = Number(form.get('lumens'));
						if (form.get('level') !== null) adjustments.level = Number(form.get('level'));
						if (form.get('mmr') !== null) adjustments.mmr = Number(form.get('mmr'));
					}
					await performAdjustStats(env, targetUid, adjustments);
					successMsg = `Stats updated for UID ${targetUid}.`;
				} else if (action === 'dismiss_report' && ts != null && !Number.isNaN(ts)) {
					const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
					const rm = await hub.fetch(
						new Request('http://internal/remove-report', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ ts, reporterUid, reportedUid })
						})
					);
					const dj = await rm.json();
					if (dj.ok && dj.removed > 0) successMsg = 'Report dismissed.';
					else errFlash = 'No matching report to dismiss (already removed?).';
				} else {
					errFlash = 'Unknown or incomplete action.';
				}
			} catch (e) {
				errFlash = 'Moderation action failed.';
			}
			try {
				const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
				const listRes = await hub.fetch(new Request('http://internal/list'));
				const data = await listRes.json();
				const reports = data.reports || [];
				const nameByUid = await resolveReportPlayerNames(env, reports);
				const status = errFlash && !successMsg ? 400 : 200;
				return new Response(
					renderReportsAdminPageV2(reports, nameByUid, {
						embeddedSecret: okSecret,
						successMsg: successMsg || undefined,
						errorMsg: errFlash || undefined
					}),
					{ status, headers: ADMIN_HTML_HEADERS }
				);
			} catch (e) {
				return new Response(
					renderReportsAdminPageV2([], {}, { embeddedSecret: okSecret, errorMsg: errFlash || 'Could not reload list.' }),
					{ status: 500, headers: ADMIN_HTML_HEADERS }
				);
			}
		}

		if (url.pathname === '/report') {
			if (!featureFlags.reportsEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Reports are currently disabled.' }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					headers: corsHeaders(request, {
						'Access-Control-Allow-Methods': 'POST, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type'
					})
				});
			}
			if (request.method === 'POST') {
				try {
					const body = await request.json();
					const reporterUid = (body.reporterUid || '').trim();
					const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
					if (isRateLimited(`report:${reporterUid || clientIp}:${clientIp}`, 8, 60_000)) {
						return new Response(JSON.stringify({ ok: false, error: 'Too many reports. Try again later.' }), {
							status: 429,
							headers: jsonHeaders
						});
					}
					const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
					await hub.fetch(
						new Request('http://internal/append', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								ts: Date.now(),
								reporterUid: reporterUid || null,
								reportedUid: body.reportedUid || null,
								roomId: body.roomId || null,
								category: String(body.category || 'other').slice(0, 64),
								details: String(body.details || '').slice(0, 2000),
								clientVersion: body.clientVersion || null
							})
						})
					);
					console.log('[report]', { reporterUid, category: body.category });
					return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
				} catch (e) {
					return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), { status: 400, headers: jsonHeaders });
				}
			}
			return new Response(JSON.stringify({ ok: false }), { status: 405, headers: jsonHeaders });
		}

		if (url.pathname === '/claim-quest') {
			if (!featureFlags.questsEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Quests are currently disabled.' }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			if (request.method === 'OPTIONS') {
				return new Response(null, { headers: corsHeaders(request, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }) });
			}
			if (request.method === 'POST') {
				try {
					const body = await request.json();
					const uid = body.uid;
					if (!uid) return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400, headers: jsonHeaders });
					const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
					const res = await profile.fetch(new Request(`http://internal/claim-quest`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body)
					}));
					return new Response(res.body, { status: res.status, headers: corsHeaders(request, { 'Content-Type': 'application/json' }) });
				} catch (e) {
					return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
				}
			}
			return new Response(JSON.stringify({ ok: false }), { status: 405, headers: jsonHeaders });
		}

		if (url.pathname === '/unlock-premium') {
			if (!featureFlags.premiumEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Premium unlock is currently disabled.' }), {
					status: 403,
					headers: corsHeaders(request, { 'Content-Type': 'application/json' })
				});
			}
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					headers: corsHeaders(request, {
						'Access-Control-Allow-Methods': 'POST, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type'
					})
				});
			}
			if (request.method === 'POST') {
				try {
					const body = await request.json();
					const uid = body.uid;
					if (!uid) {
						return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400, headers: jsonHeaders });
					}
					const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
					const res = await profile.fetch(
						new Request(`http://internal/unlock-premium?uid=${encodeURIComponent(uid)}`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: '{}'
						})
					);
					return new Response(res.body, { status: res.status, headers: corsHeaders(request, { 'Content-Type': 'application/json' }) });
				} catch (e) {
					return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
				}
			}
			return new Response(JSON.stringify({ ok: false }), { status: 405, headers: jsonHeaders });
		}
		if (url.pathname === '/system-reset') {
			const secret = request.headers.get('X-Dev-Secret');
			if (secret !== 'dev-reset-2026') {
				return new Response('Unauthorized', { status: 401 });
			}
			
			// Wipe Registry
			await env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global')).fetch(new Request('http://internal/wipe'));
			// Wipe Leaderboard
			await env.LEADERBOARD.get(env.LEADERBOARD.idFromName('global')).fetch(new Request('http://internal/wipe'));
			
			return new Response(JSON.stringify({ ok: true, msg: 'System wiped.' }), { headers: { 'Content-Type': 'application/json' }});
		}

		if (url.pathname === '/reset-player') {
			const uid = url.searchParams.get('uid');
			if (!uid) return new Response('Missing UID', { status: 400 });
			await performResetPlayer(env, uid);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' }});
		}

		return new Response('Lumen Clash API Server', { status: 200, headers: corsHeaders(request) });
	},
};

const DUEL_INVITE_TTL_MS = 15 * 60 * 1000;

// Random username generator
const ADJECTIVES = ['Swift','Bold','Dark','Neon','Iron','Void','Frost','Storm','Shadow','Blaze','Cyber','Ember','Lunar','Phantom','Crimson','Crystal','Thunder','Silver','Atomic','Stellar'];
const NOUNS = ['Weaver','Knight','Sage','Hunter','Striker','Falcon','Wolf','Viper','Titan','Reaper','Ghost','Blade','Raven','Phoenix','Dragon','Spark','Saber','Hawk','Fox','Lynx'];
function generateRandomUsername() {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	const num = Math.floor(Math.random() * 999);
	return `${adj}${noun}${num}`;
}


const QUEST_CATALOG = [
	{ id: 'd_play', label: 'Complete a match', slot: 'daily', target: 1, metric: 'matches' },
	{ id: 'd_win', label: 'Win a match', slot: 'daily', target: 1, metric: 'wins' },
	{ id: 'd_dmg', label: 'Deal 1000 damage', slot: 'daily', target: 1000, metric: 'damage' },
	{ id: 'd_abil', label: 'Use 15 abilities', slot: 'daily', target: 15, metric: 'abilities' },
	{ id: 'w_wins', label: 'Win 3 matches', slot: 'weekly', target: 3, metric: 'wins' },
	{ id: 'w_play', label: 'Play 10 matches', slot: 'weekly', target: 10, metric: 'matches' },
	{ id: 'w_dmg', label: 'Deal 5000 damage', slot: 'weekly', target: 5000, metric: 'damage' }
];

const BP_RANK_REWARDS = {
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

/** Time-boxed live events (server authority). Edit windows for seasons — client only displays. */
const DEFAULT_EVENTS_CATALOG = [
	{
		id: 'season_1_neon',
		name: 'Season 1: Neon Ascension',
		startMs: Date.parse('2026-03-28T00:00:00.000Z'),
		endMs: Date.parse('2026-06-30T23:59:59.999Z'),
		xpMultiplier: 1.25,
		lumenMultiplier: 1.5,
		grantedTitles: ['Pioneer']
	}
];

function normalizeAdminEvent(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const id = String(raw.id || '').trim();
	const name = String(raw.name || '').trim();
	const startMs = Number(raw.startMs);
	const endMs = Number(raw.endMs);
	if (!id || !name || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
	return {
		id,
		name,
		startMs,
		endMs,
		xpMultiplier: Math.max(0.1, Number(raw.xpMultiplier) || 1),
		lumenMultiplier: Math.max(0.1, Number(raw.lumenMultiplier) || 1),
		grantedTitles: Array.isArray(raw.grantedTitles) ? raw.grantedTitles.map((x) => String(x || '').trim()).filter(Boolean) : [],
		grantedCosmetics: Array.isArray(raw.grantedCosmetics) ? raw.grantedCosmetics.map((x) => String(x || '').trim()).filter(Boolean) : [],
		forceActive: !!raw.forceActive,
		forceStopped: !!raw.forceStopped
	};
}

async function loadEventsCatalog(env) {
	try {
		const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
		const res = await hub.fetch(new Request('http://internal/get-events'));
		if (!res.ok) return DEFAULT_EVENTS_CATALOG;
		const data = await res.json();
		if (!data.ok) return DEFAULT_EVENTS_CATALOG;
		if (data.events == null) return DEFAULT_EVENTS_CATALOG;
		if (!Array.isArray(data.events)) return DEFAULT_EVENTS_CATALOG;
		const normalized = data.events.map(normalizeAdminEvent).filter(Boolean);
		return normalized;
	} catch (e) {
		return DEFAULT_EVENTS_CATALOG;
	}
}

async function saveEventsCatalog(env, events) {
	const normalized = (events || []).map(normalizeAdminEvent).filter(Boolean);
	const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
	await hub.fetch(
		new Request('http://internal/set-events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ events: normalized })
		})
	);
	return normalized;
}

async function loadFeatureFlags(env) {
	try {
		const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
		const res = await hub.fetch(new Request('http://internal/get-flags'));
		if (!res.ok) return { ...DEFAULT_FEATURE_FLAGS };
		const data = await res.json();
		return normalizeFeatureFlags(data.flags);
	} catch (e) {
		return { ...DEFAULT_FEATURE_FLAGS };
	}
}

async function saveFeatureFlags(env, flags) {
	const normalized = normalizeFeatureFlags(flags);
	const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
	await hub.fetch(
		new Request('http://internal/set-flags', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ flags: normalized })
		})
	);
	return normalized;
}

async function loadAnnouncement(env) {
	try {
		const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
		const res = await hub.fetch(new Request('http://internal/get-announcement'));
		if (!res.ok) return { active: false, message: '', updatedAt: null };
		const data = await res.json();
		const a = data && data.announcement ? data.announcement : null;
		if (!a || typeof a !== 'object') return { active: false, message: '', updatedAt: null };
		return {
			active: !!a.active && !!String(a.message || '').trim(),
			message: String(a.message || '').trim(),
			updatedAt: a.updatedAt || null
		};
	} catch (e) {
		return { active: false, message: '', updatedAt: null };
	}
}

async function saveAnnouncement(env, announcement) {
	const normalized = {
		active: !!announcement.active && !!String(announcement.message || '').trim(),
		message: String(announcement.message || '').trim(),
		updatedAt: Date.now()
	};
	const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
	await hub.fetch(
		new Request('http://internal/set-announcement', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ announcement: normalized })
		})
	);
	return normalized;
}

function getActiveEventsFromCatalog(eventsCatalog, nowMs = Date.now()) {
	const out = [];
	for (const e of eventsCatalog || []) {
		const scheduledActive = nowMs >= e.startMs && nowMs < e.endMs;
		const isActive = !e.forceStopped && (e.forceActive || scheduledActive);
		if (isActive) {
			out.push({
				id: e.id,
				name: e.name,
				xpMultiplier: e.xpMultiplier || 1,
				lumenMultiplier: e.lumenMultiplier || 1,
				grantedTitles: e.grantedTitles || [],
				grantedCosmetics: e.grantedCosmetics || []
			});
		}
	}
	return out;
}

async function getActiveEvents(env, nowMs = Date.now()) {
	const catalog = await loadEventsCatalog(env);
	return getActiveEventsFromCatalog(catalog, nowMs);
}

function combineEventXpMultiplier(events) {
	return events.reduce((a, e) => a * (e.xpMultiplier || 1), 1);
}

function combineEventLumenMultiplier(events) {
	return events.reduce((a, e) => a * (e.lumenMultiplier || 1), 1);
}

function eventsCatalogForClientFromCatalog(eventsCatalog) {
	return (eventsCatalog || []).map((e) => ({
		id: e.id,
		name: e.name,
		startMs: e.startMs,
		endMs: e.endMs,
		xpMultiplier: e.xpMultiplier || 1,
		lumenMultiplier: e.lumenMultiplier || 1,
		grantedTitles: e.grantedTitles || [],
		grantedCosmetics: e.grantedCosmetics || [],
		forceActive: !!e.forceActive,
		forceStopped: !!e.forceStopped
	}));
}

async function eventsCatalogForClient(env) {
	const catalog = await loadEventsCatalog(env);
	return eventsCatalogForClientFromCatalog(catalog);
}

async function listKnownPlayers(env) {
	try {
		const reg = env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global'));
		const res = await reg.fetch(new Request('http://internal/list-users'));
		if (!res.ok) return [];
		const data = await res.json();
		return Array.isArray(data.players) ? data.players : [];
	} catch (e) {
		return [];
	}
}

async function loadAdminPlayerOverview(env, opts = {}) {
	const knownPlayers = await listKnownPlayers(env);
	const includeRows = opts.includeRows !== false;
	const rowLimit = Number.isFinite(opts.rowLimit) ? Math.max(0, Math.floor(opts.rowLimit)) : 500;
	const rows = [];
	const now = Date.now();
	const ONLINE_GRACE_MS = 60_000;
	const BATCH_SIZE = 24;
	for (let i = 0; i < knownPlayers.length; i += BATCH_SIZE) {
		const batch = knownPlayers.slice(i, i + BATCH_SIZE);
		const batchRows = await Promise.all(
			batch.map(async (player) => {
				try {
					const uid = String(player.uid || '').trim();
					if (!uid) return null;
					const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
					const res = await profile.fetch(new Request(`http://internal/get-stats?uid=${encodeURIComponent(uid)}`));
					if (!res.ok) return null;
					const data = await res.json();
					return {
						uid,
						username: data.username || player.username || 'Player',
						level: Number(data.level) || 1,
						wins: Number(data.wins) || 0,
						losses: Number(data.losses) || 0,
						lumens: Number(data.lumens) || 0,
						lastSeen: data.lastSeen || null,
						presence: data.clientPresence || 'menu',
						banned: !!data.banned,
						guildId: data.guildId || null,
						matchCount: (Number(data.wins) || 0) + (Number(data.losses) || 0)
					};
				} catch (e) {
					return null;
				}
			})
		);
		for (const row of batchRows) {
			if (row) rows.push(row);
		}
	}
	rows.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || a.username.localeCompare(b.username));
	const activePlayers = rows.filter((p) => now - (p.lastSeen || 0) < ONLINE_GRACE_MS).length;
	const recent24h = rows.filter((p) => now - (p.lastSeen || 0) < 86_400_000).length;
	const totalMatches = rows.reduce((sum, p) => sum + p.matchCount, 0);
	return {
		rows: includeRows ? rows.slice(0, rowLimit) : [],
		rowsShown: includeRows ? Math.min(rows.length, rowLimit) : 0,
		rowsTruncated: includeRows ? rows.length > rowLimit : false,
		totalPlayers: rows.length,
		activePlayers,
		recent24h,
		bannedPlayers: rows.filter((p) => p.banned).length,
		guildedPlayers: rows.filter((p) => p.guildId).length,
		totalMatches
	};
}

const SHOP_CATALOG = [
	{ id: 'emote_clown', type: 'emote', name: '🤡', price: 100 },
	{ id: 'emote_ghost', type: 'emote', name: '👻', price: 150 },
	{ id: 'title_champion', type: 'title', name: 'Champion', price: 500 },
	{ id: 'skin_void_gold', type: 'skin', name: 'Gold', charId: 'voidWeaver', price: 1000 }
];



function utcDayKey() {
	return new Date().toISOString().slice(0, 10);
}

function utcWeekKey(d = new Date()) {
	const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function ensureQuestBuckets(stats) {
	stats.questMetrics = stats.questMetrics || { daily: {}, weekly: {} };
	let changed = false;
	const dk = utcDayKey();
	const wk = utcWeekKey();
	const d = stats.questMetrics.daily || {};
	const w = stats.questMetrics.weekly || {};
	if (d.periodKey !== dk) {
		stats.questMetrics.daily = { periodKey: dk, wins: 0, matches: 0, damage: 0, abilities: 0, claimed: {} };
		changed = true;
	} else {
		stats.questMetrics.daily = {
			periodKey: dk,
			wins: d.wins || 0,
			matches: d.matches || 0,
			damage: d.damage || 0,
			abilities: d.abilities || 0,
			claimed: d.claimed && typeof d.claimed === 'object' ? d.claimed : {}
		};
	}
	if (w.periodKey !== wk) {
		stats.questMetrics.weekly = { periodKey: wk, wins: 0, matches: 0, damage: 0, abilities: 0, claimed: {} };
		changed = true;
	} else {
		stats.questMetrics.weekly = {
			periodKey: wk,
			wins: w.wins || 0,
			matches: w.matches || 0,
			damage: w.damage || 0,
			abilities: w.abilities || 0,
			claimed: w.claimed && typeof w.claimed === 'object' ? w.claimed : {}
		};
	}
	return changed;
}

function questProgress(bucket, q) {
	if (q.metric === 'wins') return bucket.wins || 0;
	if (q.metric === 'damage') return bucket.damage || 0;
	if (q.metric === 'abilities') return bucket.abilities || 0;
	return bucket.matches || 0;
}

function grantBpRewardsForRankUp(stats, fromLevel, toLevel) {
	stats.lumens = Math.max(0, Number(stats.lumens) || 0);
	for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
		const r = BP_RANK_REWARDS[lvl];
		if (!r) continue;
		if (r.type === 'emote') {
			if (!stats.unlockedCosmetics.includes(r.id)) stats.unlockedCosmetics.push(r.id);
		} else if (r.type === 'title') {
			if (!stats.unlockedTitles.includes(r.name)) stats.unlockedTitles.push(r.name);
		} else if (r.type === 'credits' && r.id === 'lumens') {
			stats.lumens += Math.max(0, Number(r.amount) || 0);
		}
	}
}
function syncAccountLevelFromClasses(stats) {
	const cls = stats.classes || {};
	const keys = Object.keys(cls);
	if (keys.length === 0) {
		stats.level = 1;
		return false;
	}
	let sum = 0;
	for (const k of keys) {
		const c = cls[k];
		sum += Math.max(1, Number(c && c.level) || 1);
	}
	const next = sum - (keys.length - 1);
	const changed = stats.level !== next;
	stats.level = next;
	return changed;
}

export class PlayerProfile {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		const requestUid = String(url.searchParams.get('uid') || '').trim();

		// Initialize default schema if missing
		let stats = await this.state.storage.get('stats') || { 
			level: 1, 
			xp: 0, 
			wins: 0, 
			losses: 0, 
			lumens: 0,
			luminaryPassXp: 0,
			bpPremiumUnlocked: false,
			username: null, 
			matchHistory: [],
			classes: {
				'aegisKnight': { level: 1, xp: 0 },
				'lumenSage': { level: 1, xp: 0 },
				'voidWeaver': { level: 1, xp: 0 }
			},
			unlockedCosmetics: [],
			unlockedTitles: [],
			equippedTitle: '',
			equippedSkins: {
				'aegisKnight': 'Default',
				'lumenSage': 'Default',
				'voidWeaver': 'Default'
			},
			rankedRecord: { placements: 0, mmr: 1000 },
			guildId: null,
			banned: false,
			bannedUntil: null,
			uid: null
		};
		// Auto-expire ban
		if (stats.banned && stats.bannedUntil && Date.now() > stats.bannedUntil) {
			stats.banned = false;
			stats.bannedUntil = null;
			await this.state.storage.put('stats', stats);
		}
		stats.matchHistory = stats.matchHistory || [];
		stats.classes = stats.classes || {
			'aegisKnight': { level: 1, xp: 0 },
			'lumenSage': { level: 1, xp: 0 },
			'voidWeaver': { level: 1, xp: 0 }
		};
		stats.unlockedCosmetics = stats.unlockedCosmetics || [];
		stats.unlockedTitles = stats.unlockedTitles || [];
		stats.equippedSkins = stats.equippedSkins || {};
		stats.rankedRecord = stats.rankedRecord || { placements: 0, mmr: 1000 };
		if (stats.guildId === undefined) stats.guildId = null;
		if (stats.uid === undefined) stats.uid = null;
		let shouldSaveStats = false;
		if (requestUid && stats.uid !== requestUid) {
			stats.uid = requestUid;
			shouldSaveStats = true;
		}

		// Generate a random username on first ever access
		if (!stats.username) {
			stats.username = generateRandomUsername();
			shouldSaveStats = true;
		}
		const registrationUid = stats.uid || requestUid;
		if (registrationUid && stats.username) {
			try {
				let regId = this.env.USERNAME_REGISTRY.idFromName('global');
				let registry = this.env.USERNAME_REGISTRY.get(regId);
				await registry.fetch(new Request(`http://internal/claim?name=${encodeURIComponent(stats.username)}&uid=${encodeURIComponent(registrationUid)}`));
			} catch(e) { /* best-effort registration for auto-generated names */ }
		}
		if (shouldSaveStats) {
			await this.state.storage.put('stats', stats);
		}

		if (url.pathname === '/get-stats') {
			let dirty = false;
			if (syncAccountLevelFromClasses(stats)) dirty = true;
			if (ensureQuestBuckets(stats)) dirty = true;
			stats.lumens = Math.max(0, Number(stats.lumens) || 0);
			stats.luminaryPassXp = Math.max(0, Number(stats.luminaryPassXp) || 0);
			if (stats.bpPremiumUnlocked === undefined) stats.bpPremiumUnlocked = false;

			const activeEvents = await getActiveEvents(this.env);
			for (const ev of activeEvents) {
				if (ev.grantedTitles && ev.grantedTitles.length) {
					for (const t of ev.grantedTitles) {
						if (!stats.unlockedTitles.includes(t)) {
							stats.unlockedTitles.push(t);
							dirty = true;
						}
					}
				}
				if (ev.grantedCosmetics && ev.grantedCosmetics.length) {
					for (const c of ev.grantedCosmetics) {
						if (!stats.unlockedCosmetics.includes(c)) {
							stats.unlockedCosmetics.push(c);
							dirty = true;
						}
					}
				}
			}

			if (dirty) await this.state.storage.put('stats', stats);
			const featureFlags = await loadFeatureFlags(this.env);
			const guild = await getGuildForUid(this.env, url.searchParams.get('uid'));
			const out = {
				...stats,
				questCatalog: QUEST_CATALOG,
				eventsCatalog: await eventsCatalogForClient(this.env),
				activeEvents,
				eventXpMultiplier: combineEventXpMultiplier(activeEvents),
				eventLumenMultiplier: combineEventLumenMultiplier(activeEvents),
				featureFlags,
				shopCatalog: SHOP_CATALOG,
				guild
			};
			return new Response(JSON.stringify(out), { headers: corsHeaders(request) });
		}

		if (url.pathname === '/set-name') {
			stats.username = decodeURIComponent(url.searchParams.get('name'));
			await this.state.storage.put('stats', stats);
			return new Response('OK');
		}

		if (url.pathname === '/add-xp') {
			let isWin = false;
			let isRanked = false;
			let rankedDelta = 0;
			let classId = 'aegisKnight';
			let uid = url.searchParams.get('uid') || 'unknown';
			let matchSnap = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };

			if (request.method === 'POST') {
				try {
					const j = await request.json();
					isWin = !!j.win;
					isRanked = !!j.isRanked;
					if (j.rankedDelta !== undefined) rankedDelta = Number(j.rankedDelta) || 0;
					classId = j.classId || 'aegisKnight';
					uid = j.uid || uid;
					if (j.matchStats && typeof j.matchStats === 'object') {
						matchSnap.damageDealt = Math.max(0, Number(j.matchStats.damageDealt) || 0);
						matchSnap.damageTaken = Math.max(0, Number(j.matchStats.damageTaken) || 0);
						matchSnap.abilitiesUsed = Math.max(0, Number(j.matchStats.abilitiesUsed) || 0);
						matchSnap.turnSwaps = Math.max(0, Number(j.matchStats.turnSwaps) || 0);
					}
				} catch (e) {
					isWin = url.searchParams.get('win') === 'true';
					classId = url.searchParams.get('classId') || 'aegisKnight';
					uid = url.searchParams.get('uid') || uid;
				}
			} else {
				isWin = url.searchParams.get('win') === 'true';
				classId = url.searchParams.get('classId') || 'aegisKnight';
				uid = url.searchParams.get('uid') || uid;
			}

			let xpGained = isWin ? 50 : 10;

			if (isWin) stats.wins += 1;
			else stats.losses += 1;
			stats.xp += xpGained;

			if (isRanked) {
				stats.rankedRecord.placements += 1;
				stats.rankedRecord.mmr = Math.max(0, stats.rankedRecord.mmr + rankedDelta);
			}

			if (!stats.classes[classId]) stats.classes[classId] = { level: 1, xp: 0 };
			let c = stats.classes[classId];
			c.xp += xpGained;

			let neededXP = c.level * 100;
			let leveledUp = false;
			while (c.xp >= neededXP) {
				c.xp -= neededXP;
				c.level += 1;
				neededXP = c.level * 100;
				leveledUp = true;
			}

			const oldAccountLevel = stats.level;
			syncAccountLevelFromClasses(stats);
			grantBpRewardsForRankUp(stats, oldAccountLevel, stats.level);

			stats.lumens = Math.max(0, Number(stats.lumens) || 0);
			stats.luminaryPassXp = Math.max(0, Number(stats.luminaryPassXp) || 0);
			const activeEvents = await getActiveEvents(this.env);
			const eventXpMult = combineEventXpMultiplier(activeEvents);
			const eventLumenMult = combineEventLumenMultiplier(activeEvents);
			const passXpApplied = Math.round(xpGained * eventXpMult);
			stats.luminaryPassXp += passXpApplied;

			ensureQuestBuckets(stats);
			const questCompleted = [];
			const lumensPerQuest = Math.round(5 * eventLumenMult);
			const daily = stats.questMetrics.daily;
			const weekly = stats.questMetrics.weekly;
			const prevD = { wins: daily.wins, matches: daily.matches, damage: daily.damage || 0, abilities: daily.abilities || 0 };
			const prevW = { wins: weekly.wins, matches: weekly.matches, damage: weekly.damage || 0, abilities: weekly.abilities || 0 };
			daily.matches += 1;
			weekly.matches += 1;
			daily.damage = (daily.damage || 0) + matchSnap.damageDealt;
			weekly.damage = (weekly.damage || 0) + matchSnap.damageDealt;
			daily.abilities = (daily.abilities || 0) + matchSnap.abilitiesUsed;
			weekly.abilities = (weekly.abilities || 0) + matchSnap.abilitiesUsed;
			if (isWin) {
				daily.wins += 1;
				weekly.wins += 1;
			}
			for (const q of QUEST_CATALOG) {
				const bucket = q.slot === 'daily' ? daily : weekly;
				const prev = q.slot === 'daily' ? prevD : prevW;
				const prevVal = q.metric === 'wins' ? prev.wins : prev.matches;
				const metricVal = questProgress(bucket, q);
				const target = q.target;
				const wasDone = !!bucket.claimed[q.id] || prevVal >= target;
				const nowDone = !!bucket.claimed[q.id] || metricVal >= target;
				if (!wasDone && nowDone && !bucket.claimed[q.id]) {
					questCompleted.push({ id: q.id, label: q.label });
				}
			}

			stats.matchHistory.push({
				result: isWin ? 'Win' : 'Loss',
				classId,
				xpEarned: xpGained,
				leveledUp,
				timestamp: Date.now()
			});
			if (stats.matchHistory.length > 10) {
				stats.matchHistory = stats.matchHistory.slice(-10);
			}

			stats.lastSeen = Date.now();
			await this.state.storage.put('stats', stats);

			if (uid) {
				try {
					const guilds = await getGuildRegistry(this.env);
					await guilds.fetch(new Request('http://internal/add-xp', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ uid, xp: xpGained })
					}));
				} catch (e) {}
			}

			if (isWin && stats.username) {
				this.env.LEADERBOARD.get(this.env.LEADERBOARD.idFromName('global')).fetch(
					new Request('http://internal/update', {
						method: 'POST',
						body: JSON.stringify({
							uid,
							username: stats.username,
							wins: stats.wins,
							level: stats.level,
							xp: stats.xp
						})
					})
				).catch((e) => console.error('Leaderboard update failed', e));
			}

			return new Response(
				JSON.stringify({
					...stats,
					questCatalog: QUEST_CATALOG,
					eventsCatalog: await eventsCatalogForClient(this.env),
					activeEvents,
					eventXpMultiplier: eventXpMult,
					eventLumenMultiplier: eventLumenMult,
					passXpApplied,
					lastMatchClassId: classId,
					xpGained,
					leveledUp,
					questCompleted,
					matchStats: matchSnap,
					isRanked,
					rankedDelta
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		}

		if (url.pathname === '/save-customization') {
			let { equippedTitle, charId, skin } = await request.json();
			if (equippedTitle !== undefined) stats.equippedTitle = equippedTitle;
			if (charId && skin) {
				if (!stats.equippedSkins) stats.equippedSkins = {};
				stats.equippedSkins[charId] = skin;
			}
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ success: true, stats }));
		}

		if (url.pathname === '/update-presence') {
			let body = {};
			try {
				body = await request.json();
			} catch (e) {}
			const allowed = new Set(['menu', 'match', 'private_lobby', 'away']);
			const state = allowed.has(body.state) ? body.state : 'menu';
			stats.clientPresence = state;
			stats.lastSeen = Date.now();
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/admin-reset-username' && request.method === 'POST') {
			stats.username = null;
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/admin-reset-levels' && request.method === 'POST') {
			stats.level = 1;
			stats.xp = 0;
			stats.luminaryPassXp = 0;
			stats.classes = {
				'aegisKnight': { level: 1, xp: 0 },
				'lumenSage': { level: 1, xp: 0 },
				'voidWeaver': { level: 1, xp: 0 }
			};
			syncAccountLevelFromClasses(stats);
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/admin-clear-guild' && request.method === 'POST') {
			stats.guildId = null;
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/invite-send') {
			const body = await request.json();
			const { type, fromUid, roomId, partyId, code } = body;
			if (!fromUid || !type) return new Response(JSON.stringify({ ok: false }), { status: 400 });
			stats.invites = stats.invites || [];
			const now = Date.now();
			stats.invites = stats.invites.filter((i) => now - (i.ts || 0) < DUEL_INVITE_TTL_MS && i.fromUid !== fromUid);
			stats.invites.push({ type, fromUid, roomId, partyId, code, guildId: body.guildId || null, guildName: body.guildName || null, guildTag: body.guildTag || null, joinCode: body.joinCode || null, ts: now });
			if (stats.invites.length > 8) stats.invites = stats.invites.slice(-8);
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/invite-remove') {
			const body = await request.json();
			const fromUid = body.fromUid;
			if (!fromUid) return new Response(JSON.stringify({ ok: false }), { status: 400 });
			stats.invites = (stats.invites || []).filter((i) => i.fromUid !== fromUid);
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/invite-take') {
			const body = await request.json();
			const fromUid = body.fromUid;
			if (!fromUid) return new Response(JSON.stringify({ ok: false, error: 'Missing fromUid' }), { status: 400 });
			const now = Date.now();
			stats.invites = stats.invites || [];
			const inv = stats.invites.find((i) => i.fromUid === fromUid && now - (i.ts || 0) < DUEL_INVITE_TTL_MS);
			if (!inv) return new Response(JSON.stringify({ ok: false, error: 'Invite expired or not found' }), { status: 404 });
			stats.invites = stats.invites.filter((i) => i.fromUid !== fromUid);
			await this.state.storage.put('stats', stats);
			return new Response(
				JSON.stringify({ ok: true, type: inv.type, roomId: inv.roomId, partyId: inv.partyId, code: inv.code, guildId: inv.guildId || null, guildName: inv.guildName || null, guildTag: inv.guildTag || null, joinCode: inv.joinCode || null }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}

		if (url.pathname === '/claim-quest') {
			try {
				const flags = await loadFeatureFlags(this.env);
				if (!flags.questsEnabled) {
					return new Response(JSON.stringify({ ok: false, error: 'Quests are currently disabled.' }), { status: 403 });
				}
				const body = await request.json();
				const qid = body.questId;
				if (!qid) return new Response(JSON.stringify({ ok: false, error: 'Missing questId' }), { status: 400 });

				// Ensure buckets are up to date
				ensureQuestBuckets(stats);

				const q = QUEST_CATALOG.find((x) => x.id === qid);
				if (!q) return new Response(JSON.stringify({ ok: false, error: 'Unknown quest' }), { status: 404 });

				const bucket = q.slot === 'daily' ? stats.questMetrics.daily : stats.questMetrics.weekly;
				const metricVal = questProgress(bucket, q);

				if (metricVal < q.target) {
					return new Response(JSON.stringify({ ok: false, error: 'Quest not completed yet' }), { status: 400 });
				}
				if (bucket.claimed[q.id]) {
					return new Response(JSON.stringify({ ok: false, error: 'Quest already claimed' }), { status: 400 });
				}

				const activeEvents = await getActiveEvents(this.env);
				const eventLumenMult = combineEventLumenMultiplier(activeEvents);
				const lumensPerQuest = Math.round(5 * eventLumenMult);

				bucket.claimed[q.id] = true;
				stats.lumens = (stats.lumens || 0) + lumensPerQuest;
				await this.state.storage.put('stats', stats);

				return new Response(JSON.stringify({ ok: true, lumensGranted: lumensPerQuest, lumens: stats.lumens, bucket }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), { status: 400 });
			}
		}

		if (url.pathname === '/friend-request') {
			const fromUid = url.searchParams.get('from');
			stats.friendRequests = stats.friendRequests || [];
			if (!stats.friendRequests.includes(fromUid) && (!stats.friends || !stats.friends.includes(fromUid))) {
				stats.friendRequests.push(fromUid);
				await this.state.storage.put('stats', stats);
			}
			return new Response('OK');
		}

		if (url.pathname === '/ban') {
			const until = Number(url.searchParams.get('until')) || null;
			stats.banned = true;
			stats.bannedUntil = until;
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }));
		}

		if (url.pathname === '/unban') {
			stats.banned = false;
			stats.bannedUntil = null;
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }));
		}

		if (url.pathname === '/adjust-stats') {
			const body = await request.json();
			if (body.lumens != null) stats.lumens = Number(body.lumens) || 0;
			if (body.mmr != null) stats.mmr = Number(body.mmr) || 0;
			if (body.level != null) stats.level = Number(body.level) || 1;
			if (body.xp != null) stats.xp = Number(body.xp) || 0;
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true, stats }));
		}

		if (url.pathname === '/friend-accept') {
			const target = url.searchParams.get('target');
			stats.friends = stats.friends || [];
			stats.friendRequests = stats.friendRequests || [];
			
			// Remove from requests if there
			stats.friendRequests = stats.friendRequests.filter(r => r !== target);
			
			// Add to friends if not there
			if (!stats.friends.includes(target)) {
				stats.friends.push(target);
			}
			await this.state.storage.put('stats', stats);
			return new Response('OK');
		}

		if (url.pathname === '/friend-decline') {
			const target = url.searchParams.get('target');
			stats.friendRequests = stats.friendRequests || [];
			stats.friendRequests = stats.friendRequests.filter(r => r !== target);
			await this.state.storage.put('stats', stats);
			return new Response('OK');
		}

		if (url.pathname === '/friend-remove') {
			const target = url.searchParams.get('target');
			stats.friends = stats.friends || [];
			stats.friends = stats.friends.filter(f => f !== target);
			await this.state.storage.put('stats', stats);
			return new Response('OK');
		}

		if (url.pathname === '/unlock-premium' && request.method === 'POST') {
			const flags = await loadFeatureFlags(this.env);
			if (!flags.premiumEnabled) {
				return new Response(JSON.stringify({ ok: false, error: 'Premium unlock is currently disabled.' }), {
					status: 403,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const cost = 100;
			stats.lumens = Math.max(0, Number(stats.lumens) || 0);
			if (stats.bpPremiumUnlocked) {
				const activeEvents = await getActiveEvents(this.env);
				const out = {
					...stats,
					questCatalog: QUEST_CATALOG,
					eventsCatalog: await eventsCatalogForClient(this.env),
					activeEvents,
					eventXpMultiplier: combineEventXpMultiplier(activeEvents),
					eventLumenMultiplier: combineEventLumenMultiplier(activeEvents)
				};
				return new Response(JSON.stringify({ ok: true, already: true, stats: out }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			if (stats.lumens < cost) {
				return new Response(JSON.stringify({ ok: false, error: 'Not enough Lumens' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			stats.lumens -= cost;
			stats.bpPremiumUnlocked = true;
			await this.state.storage.put('stats', stats);
			const activeEvents = await getActiveEvents(this.env);
				const out = {
					...stats,
					questCatalog: QUEST_CATALOG,
					eventsCatalog: await eventsCatalogForClient(this.env),
					activeEvents,
					eventXpMultiplier: combineEventXpMultiplier(activeEvents),
					eventLumenMultiplier: combineEventLumenMultiplier(activeEvents)
				};
			return new Response(JSON.stringify({ ok: true, stats: out }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/shop/purchase' && request.method === 'POST') {
			try {
				const flags = await loadFeatureFlags(this.env);
				if (!flags.shopEnabled) {
					return new Response(JSON.stringify({ ok: false, error: 'Shop is currently disabled.' }), {
						status: 403,
						headers: { 'Content-Type': 'application/json' }
					});
				}
				const body = await request.json();
				const item = SHOP_CATALOG.find(i => i.id === body.itemId);
				if (!item) return new Response(JSON.stringify({ ok: false, error: 'Item not found' }), { status: 404 });
				
				stats.lumens = Math.max(0, Number(stats.lumens) || 0);
				stats.unlockedTitles = stats.unlockedTitles || [];
				stats.unlockedCosmetics = stats.unlockedCosmetics || [];

				const alreadyOwned = (item.type === 'title' && stats.unlockedTitles.includes(item.name)) || 
									 (item.type !== 'title' && stats.unlockedCosmetics.includes(item.name));
				
				if (alreadyOwned) return new Response(JSON.stringify({ ok: false, error: 'Already owned' }), { status: 400 });

				if (stats.lumens < item.price) {
					return new Response(JSON.stringify({ ok: false, error: 'Not enough Lumens' }), { status: 400 });
				}

				stats.lumens -= item.price;
				if (item.type === 'title') stats.unlockedTitles.push(item.name);
				else stats.unlockedCosmetics.push(item.name);
				
				await this.state.storage.put('stats', stats);
				
				const activeEvents = await getActiveEvents(this.env);
				const out = {
					...stats,
					questCatalog: QUEST_CATALOG,
					eventsCatalog: await eventsCatalogForClient(this.env),
					activeEvents,
					eventXpMultiplier: combineEventXpMultiplier(activeEvents),
					eventLumenMultiplier: combineEventLumenMultiplier(activeEvents),
					shopCatalog: SHOP_CATALOG
				};
				return new Response(JSON.stringify({ ok: true, stats: out }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Bad Request' }), { status: 400 });
			}
		}

		if (url.pathname === '/wipe') {
			await this.state.storage.deleteAll();
			return new Response('OK');
		}

		if (url.pathname === '/get-lobby-data') {
			stats.friends = stats.friends || [];
			stats.friendRequests = stats.friendRequests || [];
			
			const ONLINE_GRACE_MS = 60000;

			const fetchDetails = async (uids) => {
				const results = [];
				for (const fUid of uids) {
					try {
						let fProfile = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(fUid));
						let fRes = await fProfile.fetch(new Request(`http://internal/get-stats`));
						let fData = await fRes.json();
						const online = Date.now() - (fData.lastSeen || 0) < ONLINE_GRACE_MS;
						const p = fData.clientPresence || 'menu';
						const presenceLabel = !online
							? 'Offline'
							: p === 'match'
								? 'In match'
								: p === 'private_lobby'
									? 'Private lobby'
									: p === 'away'
										? 'Away'
										: 'In menu';
						results.push({
							uid: fUid,
							username: fData.username,
							level: fData.level,
							status: online ? 'Online' : 'Offline',
							presenceLabel
						});
					} catch(e) {}
				}
				return results;
			};

			const now = Date.now();
			stats.invites = stats.invites || [];
			const freshInv = stats.invites.filter((i) => now - (i.ts || 0) < DUEL_INVITE_TTL_MS);
			if (freshInv.length !== stats.invites.length) {
				stats.invites = freshInv;
				await this.state.storage.put('stats', stats);
			}

			const invitesResolved = [];
			for (const inv of freshInv) {
				try {
					const fp = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(inv.fromUid));
					const fr = await fp.fetch(new Request(`http://internal/get-stats`));
					const fd = await fr.json();
					invitesResolved.push({
						type: inv.type,
						fromUid: inv.fromUid,
						fromUsername: fd.username || 'Player',
						roomId: inv.roomId,
						partyId: inv.partyId,
						code: inv.code,
						guildId: inv.guildId || null,
						guildName: inv.guildName || null,
						guildTag: inv.guildTag || null,
						joinCode: inv.joinCode || null,
						ts: inv.ts
					});
				} catch (e) {}
			}
			
			const [friendsArr, requestsArr] = await Promise.all([
				fetchDetails(stats.friends),
				fetchDetails(stats.friendRequests)
			]);
			const guild = await getGuildForUid(this.env, url.searchParams.get('uid'));

			return new Response(JSON.stringify({ 
				profile: stats,
				guild,
				social: {
					friends: friendsArr,
					requests: requestsArr,
					invites: invitesResolved
				}
			}));
		}

		return new Response('Not found', { status: 404 });
	}
}

export class UsernameRegistry {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/claim') {
			const name = decodeURIComponent(url.searchParams.get('name')).toLowerCase();
			const uid = url.searchParams.get('uid');

			const existingOwner = await this.state.storage.get(`name:${name}`);
			if (existingOwner && existingOwner !== uid) {
				return new Response(JSON.stringify({ ok: false, error: 'Username already taken' }));
			}

			// Release old name for this user if they had one
			const oldName = await this.state.storage.get(`uid:${uid}`);
			if (oldName) {
				await this.state.storage.delete(`name:${oldName}`);
			}

			// Claim new name
			await this.state.storage.put(`name:${name}`, uid);
			await this.state.storage.put(`uid:${uid}`, name);
			await this.state.storage.put(`seen:${uid}`, true);

			return new Response(JSON.stringify({ ok: true }));
		}

		if (url.pathname === '/get-uid') {
			const name = decodeURIComponent(url.searchParams.get('name')).toLowerCase();
			const uid = await this.state.storage.get(`name:${name}`);
			if (!uid) return new Response(JSON.stringify({ ok: false }));
			return new Response(JSON.stringify({ ok: true, uid }));
		}

		if (url.pathname === '/lookup-name') {
			const uid = url.searchParams.get('uid');
			if (!uid) {
				return new Response(JSON.stringify({ ok: false, username: null }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			const username = await this.state.storage.get(`uid:${uid}`);
			return new Response(JSON.stringify({ ok: true, username: username || null }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (url.pathname === '/list-users') {
			const seenList = await this.state.storage.list({ prefix: 'seen:' });
			const legacyUidList = await this.state.storage.list({ prefix: 'uid:' });
			const seenUids = new Set();
			const players = [];
			for (const [key] of seenList) {
				const uid = String(key).slice(5);
				if (!uid) continue;
				seenUids.add(uid);
			}
			for (const [key] of legacyUidList) {
				const uid = String(key).slice(4);
				if (!uid) continue;
				seenUids.add(uid);
			}
			for (const uid of seenUids) {
				const username = await this.state.storage.get(`uid:${uid}`);
				if (!uid) continue;
				players.push({
					uid,
					username: username || null
				});
			}
			players.sort((a, b) => String(a.username || a.uid).localeCompare(String(b.username || b.uid)));
			return new Response(JSON.stringify({ ok: true, players }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (url.pathname === '/release') {
			const name = decodeURIComponent(url.searchParams.get('name')).toLowerCase();
			const uid = url.searchParams.get('uid');
			await this.state.storage.delete(`name:${name}`);
			await this.state.storage.delete(`uid:${uid}`);
			return new Response('OK');
		}

		if (url.pathname === '/wipe-usernames' && request.method === 'POST') {
			const nameList = await this.state.storage.list({ prefix: 'name:' });
			const uidList = await this.state.storage.list({ prefix: 'uid:' });
			for (const [key] of nameList) {
				await this.state.storage.delete(key);
			}
			for (const [key] of uidList) {
				await this.state.storage.delete(key);
			}
			return new Response(JSON.stringify({ ok: true }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (url.pathname === '/wipe') {
			await this.state.storage.deleteAll();
			return new Response('OK');
		}

		return new Response('Not found', { status: 404 });
	}
}

export class GameRoom {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sessions = [];
		this.turnTimer = null;
		this.rematchVotes = new Set();
		/** @type {Map<string, 'single'|'bo3'|'continue'>} */
		this.rematchModes = new Map();
		this.gameState = {
			status: 'WAITING_FOR_PLAYERS',
			turn: 0,
			turnDeadline: null,
			players: {}
		};
	}

	getClassData(charId) {
		switch (charId) {
			case 'aegisKnight':
			case 'knight':
				return {
					name: 'Aegis Knight', hp: 160,
					abilities: [
						{ id: 'shieldBash', name: 'Shield Bash', dmg: 10, cooldown: 0, currentCd: 0, type: 'damage' },
						{ id: 'fortify', name: 'Fortify', dmg: 0, cooldown: 2, currentCd: 0, type: 'shield', shieldPct: 50 },
						{ id: 'holySmite', name: 'Holy Smite', dmg: 20, cooldown: 3, currentCd: 0, type: 'damage' },
						{ id: 'ironWall', name: 'Iron Wall', dmg: 0, cooldown: 5, currentCd: 0, type: 'shield', shieldPct: 100 },
					]
				};
			case 'lumenSage':
			case 'sage':
				return {
					name: 'Lumen Sage', hp: 80,
					abilities: [
						{ id: 'arcaneBolt', name: 'Arcane Bolt', dmg: 20, cooldown: 0, currentCd: 0, type: 'damage' },
						{ id: 'radiantBurst', name: 'Radiant Burst', dmg: 40, cooldown: 4, currentCd: 0, type: 'damage' },
						{ id: 'healLight', name: 'Heal Light', dmg: 0, cooldown: 3, currentCd: 0, type: 'heal', healAmt: 25 },
						{ id: 'supernova', name: 'Supernova', dmg: 50, cooldown: 6, currentCd: 0, type: 'damage' },
					]
				};
			case 'voidWeaver':
			case 'void_weaver':
			default:
				return {
					name: 'Void Weaver', hp: 100,
					abilities: [
						{ id: 'shadowStrike', name: 'Shadow Strike', dmg: 15, cooldown: 0, currentCd: 0, type: 'damage' },
						{ id: 'voidBurst', name: 'Void Burst', dmg: 30, cooldown: 3, currentCd: 0, type: 'damage' },
						{ id: 'shadowStep', name: 'Shadow Step', dmg: 0, cooldown: 4, currentCd: 0, type: 'dodge' },
						{ id: 'drain', name: 'Drain', dmg: 10, cooldown: 3, currentCd: 0, type: 'drain', healAmt: 10 },
					]
				};
		}
	}

	startGameFromHeroSelect() {
		if (this.heroSelectTimer) {
			clearTimeout(this.heroSelectTimer);
			this.heroSelectTimer = null;
		}
		const hs = this.gameState.heroSelect;
		if (hs && hs.players) {
			for (const [pId, pick] of Object.entries(hs.players)) {
				const p = this.gameState.players[pId];
				if (!p) continue;
				const newClassData = this.getClassData(pick.charId);
				const hpBonus = (p.level - 1) * 10;
				p.classId = pick.charId;
				p.class = newClassData.name;
				p.equippedSkin = pick.skin || 'Default';
				p.maxHealth = newClassData.hp + hpBonus;
				p.health = p.maxHealth;
				p.atkBonus = (p.level - 1) * 2;
				p.abilities = newClassData.abilities.map(a => ({...a}));
				p.shield = { active: false, percent: 0 };
				p.dodge = false;
				p.matchStats = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };
			}
		}
		this.gameState.status = 'IN_PROGRESS';
		this.gameState.turn = 0;
		this.gameState.pendingActions = {};
		this.gameState.heroSelect = null;
		this.startTurnTimer();
		this.broadcastState();
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.searchParams.has('roomId')) {
			this.myRoomId = url.searchParams.get('roomId');
		}

		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}

		// Accept WebSocket securely
		let p = new WebSocketPair();
		let [client, server] = Object.values(p);

		server.accept();

		const isNew = url.searchParams.get('isNew') === 'true';
		const charId = normalizePlayCharId(url.searchParams.get('char'));
		const playerId = url.searchParams.get('uid');
		const skinId = url.searchParams.get('skin') || 'Default';

		if (!charId) {
			server.close(4001, 'Invalid hero');
			return new Response(null, { status: 101, webSocket: client });
		}

		// Handle initialization and abandoned queue check
		const isPrivate = this.myRoomId && this.myRoomId.includes('private');
		
		if (!this.gameState.status || this.sessions.length === 0) {
			// Initialize state if first player (Host in private, or Seeker in public)
			if (this.sessions.length === 0) {
				// Safety: If matchmaker thought this was an old room but it's empty, and it's NOT private, reject.
				// This forces a retry from the client, which usually gets a fresh room.
				if (!isNew && !isPrivate) {
					server.close(4000, "Queue Abandoned");
					return new Response(null, { status: 101, webSocket: client });
				}
				
				this.gameState = {
					status: 'WAITING_FOR_PLAYERS',
					players: {},
					turn: 0,
					turnDeadline: null
				};
			}
		}

		const is2v2 = this.myRoomId && this.myRoomId.includes('2v2');
		let pId = null;
		if (!this.gameState.players['p1']) pId = 'p1';
		else if (!this.gameState.players['p2']) pId = 'p2';
		else if (is2v2 && !this.gameState.players['p3']) pId = 'p3';
		else if (is2v2 && !this.gameState.players['p4']) pId = 'p4';

		if (!pId) {
			server.close(1011, "Room is full");
			return new Response(null, { status: 101, webSocket: client });
		}

		const classData = this.getClassData(charId);
		this.gameState.players[pId] = { 
			id: pId, 
			health: classData.hp, 
			maxHealth: classData.hp, 
			atkBonus: 0,
			level: 1,
			class: classData.name,
			classId: charId,
			equippedSkin: skinId, // Priority: URL param (immediate)
			uid: playerId,
			username: 'Player',
			abilities: classData.abilities.map(a => ({...a})),
			shield: { active: false, percent: 0 },
			dodge: false,
			matchStats: { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 }
		};
		this.sessions.push({ ws: server, id: pId, uid: playerId });

		// Fetch profile data asynchronously (non-blocking) to apply upgrades
		const self = this;
		(async () => {
			try {
				let profileDO = self.env.PLAYER_PROFILE.get(self.env.PLAYER_PROFILE.idFromName(playerId));
				let profileRes = await profileDO.fetch(new Request(`http://internal/get-stats?uid=${playerId}`));
				let profileData = await profileRes.json();
				
				const p = self.gameState.players[pId];
				if (p && profileData.classes && profileData.classes[charId]) {
					const c = profileData.classes[charId];
					p.level = c.level;
					
					let baseUsername = profileData.username || 'Player';
					if (profileData.equippedTitle) {
						p.username = `${baseUsername} [${profileData.equippedTitle}]`;
					} else {
						p.username = baseUsername;
					}

					// Skin selection
					p.equippedSkin = (profileData.equippedSkins && profileData.equippedSkins[charId]) || 'Default';
					
					// Elo init
					p.mmr = profileData.rankedRecord ? profileData.rankedRecord.mmr : 1000;
					p.placements = profileData.rankedRecord ? profileData.rankedRecord.placements : 0;

					// Apply Level-Up Bonuses: +10 HP per level (beyond 1), +2 ATK per level (beyond 1)
					const hpBonus = (c.level - 1) * 10;
					p.maxHealth += hpBonus;
					p.health += hpBonus;
					p.atkBonus = (c.level - 1) * 2;
					
					self.broadcastState();
				}
			} catch(e) { console.error('Profile fetch error:', e); }
		})();

		server.addEventListener('message', async (event) => {
			try { await this.webSocketMessage(server, event.data); } catch(e) {}
		});

		server.addEventListener('close', async (event) => {
			try { await this.webSocketClose(server, event.code, event.reason, event.wasClean); } catch(e) {}
		});
		
		server.addEventListener('error', async (event) => {
			try { await this.webSocketClose(server, 1011, "Error", false); } catch(e) {}
		});

		const requiredPlayers = is2v2 ? 4 : 2;
		if (this.sessions.length >= requiredPlayers && this.gameState.status === 'WAITING_FOR_PLAYERS') {
			this.gameState.status = 'HERO_SELECT';
			const deadline = Date.now() + 30000; // 30 seconds
			this.gameState.heroSelect = {
				deadline,
				players: {}
			};
			for (const s of this.sessions) {
				const p = this.gameState.players[s.id];
				this.gameState.heroSelect.players[s.id] = {
					charId: p ? p.classId : 'aegisKnight',
					skin: p ? p.equippedSkin : 'Default',
					ready: false
				};
			}
			// Auto-start when timer expires
			this.heroSelectTimer = setTimeout(() => {
				if (this.gameState.status === 'HERO_SELECT') {
					this.startGameFromHeroSelect();
				}
			}, 30000);
		}

		this.broadcastState();

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws, msg) {
		const session = this.sessions.find(s => s.ws === ws);
		if (!session) return;
		
		const playerId = session.id;
		
		try {
			const data = JSON.parse(msg);

			// Emotes can be sent at any time during a match
			if (data.action === 'emote' && this.gameState.status === 'IN_PROGRESS') {
				const ALLOWED_EMOTES = ['😡','😂','😭','🤠','💀','👽','🤡','👻','🔥','💪','😎','🫡','❤️','⚡','🎯','💤'];
				if (ALLOWED_EMOTES.includes(data.emote)) {
					const emoteMsg = JSON.stringify({ type: 'EMOTE', pId: playerId, emote: data.emote });
					this.sessions.forEach(s => { try { s.ws.send(emoteMsg); } catch(e) {} });
				}
				return;
			}

			// Rematch / Bo3 series
			if (data.action === 'rematch' && this.gameState.status === 'GAME_OVER') {
				let choice = data.series === 'bo3' ? 'bo3' : data.series === 'continue' ? 'continue' : 'single';
				const ser = this.gameState.series;
				if (ser && !ser.complete) choice = 'continue';

				this.rematchModes.set(playerId, choice);

				if (this.rematchModes.size === 2) {
					const modes = [...this.rematchModes.values()];
					this.rematchModes.clear();
					this.rematchVotes.clear();

					if (modes[0] !== modes[1]) {
						const statusMsg = JSON.stringify({ type: 'REMATCH_MODE_MISMATCH' });
						this.sessions.forEach(s => { try { s.ws.send(statusMsg); } catch(e) {} });
						return;
					}

					const mode = modes[0];
					if (mode === 'continue' && (!this.gameState.series || this.gameState.series.complete)) {
						const statusMsg = JSON.stringify({ type: 'REMATCH_MODE_MISMATCH' });
						this.sessions.forEach(s => { try { s.ws.send(statusMsg); } catch(e) {} });
						return;
					}

					if (mode === 'single') {
						this.gameState.series = null;
					} else if (mode === 'bo3') {
						const s = this.gameState.series;
						if (!s || s.complete) {
							const p1w = this.gameState.players.p1.health > 0 ? 1 : 0;
							const p2w = this.gameState.players.p2.health > 0 ? 1 : 0;
							this.gameState.series = { p1Wins: p1w, p2Wins: p2w, needed: 2, complete: false };
						}
					}

					for (const pId of ['p1', 'p2']) {
						const p = this.gameState.players[pId];
						if (p) delete p.postGame;
					}

					for (const pId of ['p1', 'p2']) {
						const p = this.gameState.players[pId];
						const classData = this.getClassData(p.classId);
						const hpBonus = (p.level - 1) * 10;
						p.maxHealth = classData.hp + hpBonus;
						p.health = p.maxHealth;
						p.abilities = classData.abilities.map(a => ({...a}));
						p.shield = { active: false, percent: 0 };
						p.dodge = false;
						p.matchStats = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };
					}

					this.gameState.status = 'IN_PROGRESS';
					this.gameState.turn = 0;
					this.startTurnTimer();
					this.broadcastState();
				} else {
					const statusMsg = JSON.stringify({ type: 'REMATCH_VOTE', pId: playerId, choice });
					this.sessions.forEach(s => { try { s.ws.send(statusMsg); } catch(e) {} });
				}
				return;
			}
			
			// Hero select actions
			if (data.action === 'hero-pick' && this.gameState.status === 'HERO_SELECT') {
				const hs = this.gameState.heroSelect;
				if (hs && hs.players[playerId]) {
					const validChars = ['aegisKnight','lumenSage','voidWeaver'];
					if (data.charId && validChars.includes(data.charId)) {
						hs.players[playerId].charId = data.charId;
					}
					if (data.skin) hs.players[playerId].skin = data.skin;
				}
				const hsMsg = JSON.stringify({ type: 'HERO_SELECT_UPDATE', heroSelect: this.gameState.heroSelect });
				this.sessions.forEach(s => { try { s.ws.send(hsMsg); } catch(e) {} });
				return;
			}

			if (data.action === 'hero-ready' && this.gameState.status === 'HERO_SELECT') {
				const hs = this.gameState.heroSelect;
				if (hs && hs.players[playerId]) {
					hs.players[playerId].ready = true;
				}
				const hsMsg = JSON.stringify({ type: 'HERO_SELECT_UPDATE', heroSelect: this.gameState.heroSelect });
				this.sessions.forEach(s => { try { s.ws.send(hsMsg); } catch(e) {} });
				// Check if all players are ready
				const allReady = this.sessions.every(s => hs.players[s.id] && hs.players[s.id].ready);
				if (allReady) {
					this.startGameFromHeroSelect();
				}
				return;
			}

			if (this.gameState.status !== 'IN_PROGRESS') return;

			const is2v2 = this.myRoomId && this.myRoomId.includes('2v2');
			const player = this.gameState.players[playerId];
			if (!player || player.health <= 0) return;

			if (data.action === 'ability') {
				const idx = data.abilityIndex;
				if (idx < 0 || idx >= player.abilities.length) return;

				const ability = player.abilities[idx];
				if (ability.currentCd > 0) return; // Still on cooldown
				
				if (!is2v2) {
					const isTurn = (playerId === 'p1' && this.gameState.turn === 0) || (playerId === 'p2' && this.gameState.turn === 1);
					if (!isTurn) return;
					this.gameState.pendingActions[playerId] = { action: 'ability', abilityIndex: idx, targetId: playerId === 'p1' ? 'p2' : 'p1' };
					await this.resolveActions(is2v2);
				} else {
					// In 2v2, any living player can submit action during the turn
					const defaultTarget = ['p1','p2'].includes(playerId) ? 'p3' : 'p1';
					this.gameState.pendingActions[playerId] = { action: 'ability', abilityIndex: idx, targetId: data.targetId || defaultTarget };
					
					// Check if everyone is ready
					const livingPlayers = Object.values(this.gameState.players).filter(p => p.health > 0);
					const allActed = livingPlayers.every(p => this.gameState.pendingActions[p.id]);
					
					// Also broadcast that this player has locked in
					if (allActed) {
						await this.resolveActions(is2v2);
					}
				}
			}

			this.broadcastState();
		} catch (e) {
			console.error("Error parsing message", e);
		}
	}

	async resolveActions(is2v2) {
		const acts = this.gameState.pendingActions;
		this.gameState.pendingActions = {};

		// Execute shields/dodges first
		for (const [pId, act] of Object.entries(acts)) {
			const p = this.gameState.players[pId];
			const ability = p.abilities[act.abilityIndex];
			if (ability.type === 'shield') p.shield = { active: true, percent: ability.shieldPct || 50 };
			if (ability.type === 'dodge') p.dodge = true;
		}

		// Execute damage/heals
		for (const [pId, act] of Object.entries(acts)) {
			const p = this.gameState.players[pId];
			const target = this.gameState.players[act.targetId] || this.gameState.players[pId === 'p1' || pId === 'p2' ? 'p3' : 'p1'];
			if (!target || target.health <= 0) continue; // Target is dead or invalid

			const ability = p.abilities[act.abilityIndex];
			
			if (!p.matchStats) p.matchStats = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };
			if (!target.matchStats) target.matchStats = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };
			
			p.matchStats.abilitiesUsed += 1;

			if (ability.type === 'damage' || ability.type === 'drain') {
				let dmg = ability.dmg + (p.atkBonus || 0);
				if (target.dodge) {
					dmg = 0; // Dodged
					target.dodge = false;
				} else if (target.shield.active) {
					dmg = Math.floor(dmg * (1 - target.shield.percent / 100));
				}
				target.health -= dmg;
				if (dmg > 0) {
					p.matchStats.damageDealt += dmg;
					target.matchStats.damageTaken += dmg;
				}
				if (ability.type === 'drain') {
					p.health = Math.min(p.maxHealth, p.health + (ability.healAmt || 0));
				}
			} else if (ability.type === 'heal') {
				target.health = Math.min(target.maxHealth, target.health + (ability.healAmt || 0));
			}

			// Cooldown trigger
			if (ability.cooldown > 0) ability.currentCd = ability.cooldown;
		}
		
		// Reset shields and dodges at end of resolution
		for (const p of Object.values(this.gameState.players)) {
			p.shield = { active: false, percent: 0 };
			p.dodge = false;
		}

		// Check Game Over
		let teamAAlive = false;
		let teamBAlive = false;
		let teamPlayersA = [];
		let teamPlayersB = [];

		if (is2v2) {
			teamPlayersA = [this.gameState.players['p1'], this.gameState.players['p2']].filter(Boolean);
			teamPlayersB = [this.gameState.players['p3'], this.gameState.players['p4']].filter(Boolean);
			teamAAlive = teamPlayersA.some(p => p.health > 0);
			teamBAlive = teamPlayersB.some(p => p.health > 0);
		} else {
			teamPlayersA = [this.gameState.players['p1']].filter(Boolean);
			teamPlayersB = [this.gameState.players['p2']].filter(Boolean);
			teamAAlive = teamPlayersA[0].health > 0;
			teamBAlive = teamPlayersB[0].health > 0;
		}

		if (!teamAAlive || !teamBAlive) {
			this.gameState.status = 'GAME_OVER';
			this.clearTurnTimer();

			const ser = this.gameState.series;
			if (ser && !ser.complete) {
				if (teamAAlive) ser.p1Wins = Math.min(ser.needed, ser.p1Wins + 1);
				else if (teamBAlive) ser.p2Wins = Math.min(ser.needed, ser.p2Wins + 1);
				if (ser.p1Wins >= ser.needed || ser.p2Wins >= ser.needed) ser.complete = true;
			}

			const isRanked = this.myRoomId && this.myRoomId.includes('ranked');
			let rankedDeltaA = 0, rankedDeltaB = 0;
			
			if (isRanked && (!ser || ser.complete)) {
				const k = 32;
				const p1Elo = teamPlayersA[0].mmr || 1000;
				const p2Elo = teamPlayersB[0].mmr || 1000;
				const expect1 = 1 / (1 + Math.pow(10, (p2Elo - p1Elo) / 400));
				const expect2 = 1 / (1 + Math.pow(10, (p1Elo - p2Elo) / 400));
				rankedDeltaA = Math.round(k * ( (teamAAlive ? 1 : 0) - expect1));
				rankedDeltaB = Math.round(k * ( (teamBAlive ? 1 : 0) - expect2));
			}

			const awardXP = async (p, isWin, rDelta) => {
				if (!p || !p.uid) return null;
				try {
					let xpDO = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(p.uid));
					const ms = p.matchStats || {};
					const res = await xpDO.fetch(
						new Request("http://internal/add-xp", { method: "POST", headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ win: isWin, isRanked: isRanked && (!ser || ser.complete), rankedDelta: rDelta, uid: p.uid, classId: p.classId, matchStats: ms })
						})
					);
					const updatedStats = await res.json();
					return { xpGained: isWin ? 50 : 10, ...updatedStats };
				} catch (e) { return null; }
			};

			const promises = [];
			for (const p of teamPlayersA) promises.push(awardXP(p, teamAAlive, rankedDeltaA).then(r => { if(r) p.postGame = r; }));
			for (const p of teamPlayersB) promises.push(awardXP(p, teamBAlive, rankedDeltaB).then(r => { if(r) p.postGame = r; }));
			await Promise.all(promises);

		} else {
			// Next turn
			this.gameState.turn = this.gameState.turn === 0 ? 1 : 0;
			// Tick cooldowns
			if (is2v2) {
				Object.values(this.gameState.players).forEach(p => {
					if (p.health > 0) p.matchStats.turnSwaps += 1;
					for (let ab of p.abilities) if (ab.currentCd > 0) ab.currentCd--;
				});
			} else {
				const nextPlayerId = this.gameState.turn === 0 ? 'p1' : 'p2';
				const cp = this.gameState.players[nextPlayerId];
				if (cp) {
					cp.matchStats.turnSwaps += 1;
					for (let ab of cp.abilities) if (ab.currentCd > 0) ab.currentCd--;
				}
			}
			this.startTurnTimer();
		}
	}

	startTurnTimer() {
		this.clearTurnTimer();
		this.gameState.turnDeadline = Date.now() + 15000;
		this.turnTimer = setTimeout(async () => {
			if (this.gameState.status !== 'IN_PROGRESS') return;
			// Auto-pass turn
			const is2v2 = this.myRoomId && this.myRoomId.includes('2v2');
			await this.resolveActions(is2v2);
			this.broadcastState();
		}, 15000);
	}

	clearTurnTimer() {
		if (this.turnTimer) {
			clearTimeout(this.turnTimer);
			this.turnTimer = null;
		}
	}

	async webSocketClose(ws, code, reason, wasClean) {
		try {
			this.sessions = this.sessions.filter(s => s.ws !== ws);
			this.gameState.status = 'WAITING_FOR_PLAYERS';
			this.gameState.players = {};
			this.gameState.series = null;
			this.rematchVotes.clear();
			this.rematchModes.clear();
			this.sessions.forEach(s => {
				try { s.ws.close(1011, "Opponent disconnected"); } catch(e) {}
			});
			this.sessions = [];
			
			// If it's a private room, we KILL it entirely on disconnect.
			// Private matches shouldn't be "re-listed".
			if (this.myRoomId) {
				let mmId = this.env.MATCHMAKER.idFromName('global-matchmaker');
				let mm = this.env.MATCHMAKER.get(mmId);
				if (this.myRoomId.includes('private')) {
					// Delete from matchmaker registry
					this.state.waitUntil(
						mm.fetch('http://internal/delete-private?roomId=' + this.myRoomId).catch(console.error)
					);
				} else {
					// Public: relist for others
					this.state.waitUntil(
						mm.fetch('http://internal/relist?roomId=' + this.myRoomId).catch(console.error)
					);
				}
			}

		} catch(e) {
			console.error("Close error", e);
		}
	}

	broadcastState() {
		const baseMsg = {
			type: 'STATE_UPDATE',
			state: this.gameState
		};
		
		this.sessions.forEach(s => {
			try {
				s.ws.send(JSON.stringify({
					...baseMsg,
					me: s.id
				}));
			} catch (e) {}
		});
	}
}

export class Matchmaker {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.memoryRoomId = null;
		console.log("MATCHMAKER INSTANTIATED!");
	}

	async fetch(request) {
		const url = new URL(request.url);
		
		if (url.pathname === '/get-room') {
			const isRanked = url.searchParams.get('queue') === 'ranked';
			const is2v2 = url.searchParams.get('queue') === '2v2';
			const queueKey = isRanked ? 'rankedRoomId' : is2v2 ? 'room2v2Id' : 'openRoomId';
			let openRoomId = await this.state.storage.get(queueKey);
			if (!isRanked && !is2v2 && !openRoomId) openRoomId = this.memoryRoomId;

			if (openRoomId) {
				if (!isRanked && !is2v2) this.memoryRoomId = null;
				
				if (is2v2) {
					let count = await this.state.storage.get('room2v2Count') || 1;
					count++;
					if (count >= 4) {
						await this.state.storage.delete(queueKey);
						await this.state.storage.delete('room2v2Count');
					} else {
						await this.state.storage.put('room2v2Count', count);
					}
					return new Response(JSON.stringify({ roomId: openRoomId, isNew: false }));
				}

				await this.state.storage.delete(queueKey);
				return new Response(JSON.stringify({ roomId: openRoomId, isNew: false }));
			} else {
				const newRoomId = (isRanked ? 'room-ranked-' : is2v2 ? 'room-2v2-' : 'room-') + crypto.randomUUID();
				if (!isRanked && !is2v2) this.memoryRoomId = newRoomId;
				await this.state.storage.put(queueKey, newRoomId);
				if (is2v2) await this.state.storage.put('room2v2Count', 1);
				return new Response(JSON.stringify({ roomId: newRoomId, isNew: true }));
			}
		}

		if (url.pathname === '/relist') {
			let roomId = url.searchParams.get('roomId');
			const isRanked = roomId.includes('ranked');
			const is2v2 = roomId.includes('2v2');
			const queueKey = isRanked ? 'rankedRoomId' : is2v2 ? 'room2v2Id' : 'openRoomId';
			let openRoomId = await this.state.storage.get(queueKey);
			if (!isRanked && !is2v2 && !openRoomId) openRoomId = this.memoryRoomId;

			if (!openRoomId) {
				if (!isRanked && !is2v2) this.memoryRoomId = roomId;
				await this.state.storage.put(queueKey, roomId);
				if (is2v2) await this.state.storage.put('room2v2Count', 1);
			}
			return new Response("OK");
		}
		
		if (url.pathname === '/create-private') {
			const code = Math.floor(100000 + Math.random() * 900000).toString();
			const newRoomId = 'room-private-' + crypto.randomUUID();
			
			// Store code -> room (for joining)
			await this.state.storage.put('privateCode:' + code, newRoomId);
			// Store room -> code (for cleanup)
			await this.state.storage.put('privateRoom:' + newRoomId, code);
			
			return new Response(JSON.stringify({ roomId: newRoomId, code }));
		}

		if (url.pathname === '/join-private') {
			const code = url.searchParams.get('code');
			const roomId = await this.state.storage.get('privateCode:' + code);
			if (!roomId) return new Response(JSON.stringify({ ok: false, error: 'Invalid or expired code' }), { status: 404 });
			
			return new Response(JSON.stringify({ ok: true, roomId }));
		}

		if (url.pathname === '/delete-private') {
			const roomId = url.searchParams.get('roomId');
			if (!roomId) return new Response("Missing RoomId", { status: 400 });
			
			const code = await this.state.storage.get('privateRoom:' + roomId);
			if (code) {
				await this.state.storage.delete('privateCode:' + code);
				await this.state.storage.delete('privateRoom:' + roomId);
			}
			return new Response("OK");
		}

		return new Response("Not Matchmaker Route", { status: 404 });
	}
}

export class Leaderboard {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/top') {
			let top50 = await this.state.storage.get('top50') || [];
			return new Response(JSON.stringify(top50), { headers: corsHeaders(request) });
		}

		if (url.pathname === '/get-top-cached') {
			// 10s Cache
			let cache = await this.state.storage.get('cache_ranks');
			if (cache && (Date.now() - cache.ts < 10000)) {
				return new Response(JSON.stringify(cache.data));
			}
			let top50 = await this.state.storage.get('top50') || [];
			await this.state.storage.put('cache_ranks', { ts: Date.now(), data: top50 });
			return new Response(JSON.stringify(top50));
		}

		if (url.pathname === '/update' && request.method === 'POST') {
			try {
				const playerStats = await request.json();
				let top50 = await this.state.storage.get('top50') || [];

				// Check if player is already in leaderboard
				const existingIdx = top50.findIndex(p => p.uid === playerStats.uid);
				if (existingIdx !== -1) {
					// Update existing entry
					if (playerStats.wins >= top50[existingIdx].wins) {
						top50[existingIdx] = playerStats;
					}
				} else {
					// Add if not full, or if better than the lowest
					if (top50.length < 50 || playerStats.wins > top50[top50.length - 1].wins) {
						top50.push(playerStats);
					}
				}

				// Sort by wins (descending), then level (descending), then xp (descending)
				top50.sort((a, b) => {
					if (b.wins !== a.wins) return b.wins - a.wins;
					if (b.level !== a.level) return b.level - a.level;
					return b.xp - a.xp;
				});

				// Keep only top 50
				if (top50.length > 50) {
					top50 = top50.slice(0, 50);
				}

				await this.state.storage.put('top50', top50);
				return new Response('OK', { status: 200 });
			} catch(e) {
				return new Response('Error', { status: 500 });
			}
		}

		if (url.pathname === '/remove-uid' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = body && body.uid;
				if (!uid) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				let top50 = (await this.state.storage.get('top50')) || [];
				top50 = top50.filter((row) => row.uid !== uid);
				await this.state.storage.put('top50', top50);
				await this.state.storage.delete('cache_ranks');
				return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/wipe') {
			await this.state.storage.deleteAll();
			return new Response('OK');
		}

		return new Response('Not found', { status: 404 });
	}
}

function guildLevelFromXp(xp) {
	const safeXp = Math.max(0, Number(xp) || 0);
	return Math.max(1, Math.floor(safeXp / 500) + 1);
}

function guildLevelFloorXp(level) {
	const safeLevel = Math.max(1, Number(level) || 1);
	return (safeLevel - 1) * 500;
}

function guildLevelCeilXp(level) {
	const safeLevel = Math.max(1, Number(level) || 1);
	return safeLevel * 500;
}

function makeGuildJoinCode() {
	return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function sanitizeGuildDescription(input) {
	return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function sanitizeGuildVisualId(input, fallback) {
	const value = String(input || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
	return value || fallback;
}

function canManageGuildRole(role) {
	return role === 'Leader' || role === 'Officer';
}

function canManageGuildRecruitment(role) {
	return role === 'Leader' || role === 'Recruiter';
}

function sanitizeGuildRecruitmentStatus(input, fallback = 'recruiting') {
	const value = String(input || '').trim().toLowerCase();
	return ['recruiting', 'invite_only', 'closed'].includes(value) ? value : fallback;
}

function sanitizeGuildRecruitmentFocus(input, fallback = 'all_modes') {
	const value = String(input || '').trim().toLowerCase();
	return ['all_modes', 'duels', 'squads'].includes(value) ? value : fallback;
}

function sanitizeGuildRecruitmentPlaystyle(input, fallback = 'mixed') {
	const value = String(input || '').trim().toLowerCase();
	return ['casual', 'competitive', 'mixed'].includes(value) ? value : fallback;
}

function sanitizeGuildRecruitmentMessage(input) {
	return String(input || '').trim().replace(/\s+/g, ' ').slice(0, 200);
}

function sanitizeGuildBulletin(input) {
	return String(input || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function guildSummary(guild) {
	if (!guild) return null;
	const xp = Math.max(0, Number(guild.xp) || 0);
	const level = guildLevelFromXp(xp);
	const levelFloorXp = guildLevelFloorXp(level);
	const nextLevelXp = guildLevelCeilXp(level);
	const members = (guild.members || []).map((m) => ({
		uid: m.uid,
		username: m.username,
		role: m.role || 'Member',
		contributedXp: Math.max(0, Number(m.contributedXp) || 0),
		joinedAt: m.joinedAt || Date.now()
	}));
	const leader = members.find((m) => m.role === 'Leader') || members[0] || null;
	const topContributor = members
		.slice()
		.sort((a, b) => (b.contributedXp || 0) - (a.contributedXp || 0))[0] || null;
	const totalContributionXp = members.reduce((sum, m) => sum + (Math.max(0, Number(m.contributedXp) || 0)), 0);
	return {
		id: guild.id,
		name: guild.name,
		tag: guild.tag,
		description: sanitizeGuildDescription(guild.description || ''),
		icon: sanitizeGuildVisualId(guild.icon, 'comet'),
		banner: sanitizeGuildVisualId(guild.banner, 'aurora'),
		isPublic: guild.isPublic !== false,
		recruitment: {
			status: sanitizeGuildRecruitmentStatus(guild.recruitmentStatus, guild.isPublic === false ? 'invite_only' : 'recruiting'),
			message: sanitizeGuildRecruitmentMessage(guild.recruitmentMessage || ''),
			focus: sanitizeGuildRecruitmentFocus(guild.recruitmentFocus, 'all_modes'),
			playstyle: sanitizeGuildRecruitmentPlaystyle(guild.recruitmentPlaystyle, 'mixed')
		},
		bulletin: {
			message: sanitizeGuildBulletin(guild.bulletinMessage || ''),
			updatedAt: guild.bulletinUpdatedAt || null,
			updatedBy: guild.bulletinUpdatedBy || null
		},
		joinCode: guild.joinCode,
		xp,
		level,
		createdAt: guild.createdAt || Date.now(),
		memberCount: members.length,
		memberCap: 50,
		leaderName: leader ? leader.username : null,
		totalContributionXp,
		topContributor: topContributor ? {
			username: topContributor.username,
			contributedXp: topContributor.contributedXp || 0
		} : null,
		levelFloorXp,
		nextLevelXp,
		xpIntoLevel: Math.max(0, xp - levelFloorXp),
		xpNeededForNextLevel: Math.max(0, nextLevelXp - xp),
		levelProgressPct: Math.max(0, Math.min(100, Math.round(((xp - levelFloorXp) / Math.max(1, nextLevelXp - levelFloorXp)) * 100))),
		members,
		chat: (guild.chat || []).slice(-25).map((msg) => ({
			uid: msg.uid,
			username: msg.username,
			message: msg.message,
			ts: msg.ts || Date.now()
		}))
	};
}

export class GuildRegistry {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/create' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				const username = String(body.username || 'Player').trim().slice(0, 24);
				const name = normalizeGuildName(body.name);
				const tag = normalizeGuildTag(body.tag);
				if (!uid) return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400 });
				if (name.length < 3) return new Response(JSON.stringify({ ok: false, error: 'Guild name must be at least 3 characters' }), { status: 400 });
				if (tag.length < 2) return new Response(JSON.stringify({ ok: false, error: 'Guild tag must be 2-5 letters or numbers' }), { status: 400 });
				const existingGuildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (existingGuildId) return new Response(JSON.stringify({ ok: false, error: 'You are already in a guild' }), { status: 400 });
				const nameKey = name.toLowerCase();
				const tagKey = tag.toLowerCase();
				if (await this.state.storage.get(`guildName:${nameKey}`)) {
					return new Response(JSON.stringify({ ok: false, error: 'Guild name already taken' }), { status: 409 });
				}
				if (await this.state.storage.get(`guildTag:${tagKey}`)) {
					return new Response(JSON.stringify({ ok: false, error: 'Guild tag already taken' }), { status: 409 });
				}
				const id = `guild-${crypto.randomUUID()}`;
				let joinCode = makeGuildJoinCode();
				for (let i = 0; i < 5 && await this.state.storage.get(`joinCode:${joinCode}`); i++) {
					joinCode = makeGuildJoinCode();
				}
				const guild = {
					id,
					name,
					tag,
					description: sanitizeGuildDescription(body.description || ''),
					icon: sanitizeGuildVisualId(body.icon, 'comet'),
					banner: sanitizeGuildVisualId(body.banner, 'aurora'),
					isPublic: body.isPublic !== false,
					recruitmentStatus: sanitizeGuildRecruitmentStatus(body.recruitmentStatus, body.isPublic === false ? 'invite_only' : 'recruiting'),
					recruitmentMessage: sanitizeGuildRecruitmentMessage(body.recruitmentMessage || ''),
					recruitmentFocus: sanitizeGuildRecruitmentFocus(body.recruitmentFocus, 'all_modes'),
					recruitmentPlaystyle: sanitizeGuildRecruitmentPlaystyle(body.recruitmentPlaystyle, 'mixed'),
					bulletinMessage: '',
					bulletinUpdatedAt: null,
					bulletinUpdatedBy: null,
					joinCode,
					xp: 0,
					createdAt: Date.now(),
					chat: [],
					members: [{
						uid,
						username,
						role: 'Leader',
						contributedXp: 0,
						joinedAt: Date.now()
					}]
				};
				await this.state.storage.put(`guild:${id}`, guild);
				await this.state.storage.put(`playerGuild:${uid}`, id);
				await this.state.storage.put(`joinCode:${joinCode}`, id);
				await this.state.storage.put(`guildName:${nameKey}`, id);
				await this.state.storage.put(`guildTag:${tagKey}`, id);
				return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Could not create guild' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/join' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				const username = String(body.username || 'Player').trim().slice(0, 24);
				const code = sanitizeGuildSearchCode(body.code);
				if (!uid || !code) return new Response(JSON.stringify({ ok: false, error: 'Missing guild code' }), { status: 400 });
				const existingGuildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (existingGuildId) return new Response(JSON.stringify({ ok: false, error: 'You are already in a guild' }), { status: 400 });
				const guildId = await this.state.storage.get(`joinCode:${code}`);
				if (!guildId) return new Response(JSON.stringify({ ok: false, error: 'Guild code not found' }), { status: 404 });
				const guild = await this.state.storage.get(`guild:${guildId}`);
				if (!guild) return new Response(JSON.stringify({ ok: false, error: 'Guild no longer exists' }), { status: 404 });
				if ((guild.members || []).length >= 50) return new Response(JSON.stringify({ ok: false, error: 'Guild is full' }), { status: 400 });
				if (guild.isPublic === false && !body.allowPrivateJoin) return new Response(JSON.stringify({ ok: false, error: 'This guild is not open for public joining' }), { status: 403 });
				const recruitmentStatus = sanitizeGuildRecruitmentStatus(guild.recruitmentStatus, guild.isPublic === false ? 'invite_only' : 'recruiting');
				if (recruitmentStatus === 'closed' && !body.allowPrivateJoin) {
					return new Response(JSON.stringify({ ok: false, error: 'This guild is not recruiting right now' }), { status: 403 });
				}
				if (recruitmentStatus === 'invite_only' && !body.allowPrivateJoin) {
					return new Response(JSON.stringify({ ok: false, error: 'This guild is invite only right now' }), { status: 403 });
				}
				guild.chat = guild.chat || [];
				if (!(guild.members || []).some((m) => m.uid === uid)) {
					guild.members.push({
						uid,
						username,
						role: 'Member',
						contributedXp: 0,
						joinedAt: Date.now()
					});
				}
				await this.state.storage.put(`guild:${guildId}`, guild);
				await this.state.storage.put(`playerGuild:${uid}`, guildId);
				return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Could not join guild' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/leave' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400 });
				const guildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (!guildId) return new Response(JSON.stringify({ ok: false, error: 'You are not in a guild' }), { status: 400 });
				const guild = await this.state.storage.get(`guild:${guildId}`);
				if (!guild) {
					await this.state.storage.delete(`playerGuild:${uid}`);
					return new Response(JSON.stringify({ ok: true, guild: null }), { headers: { 'Content-Type': 'application/json' } });
				}
				guild.chat = guild.chat || [];
				guild.members = (guild.members || []).filter((m) => m.uid !== uid);
				await this.state.storage.delete(`playerGuild:${uid}`);
				if (guild.members.length === 0) {
					await this.state.storage.delete(`guild:${guildId}`);
					await this.state.storage.delete(`joinCode:${guild.joinCode}`);
					await this.state.storage.delete(`guildName:${String(guild.name || '').toLowerCase()}`);
					await this.state.storage.delete(`guildTag:${String(guild.tag || '').toLowerCase()}`);
					return new Response(JSON.stringify({ ok: true, guild: null, disbanded: true }), { headers: { 'Content-Type': 'application/json' } });
				}
				if (!guild.members.some((m) => m.role === 'Leader')) {
					guild.members[0].role = 'Leader';
				}
				await this.state.storage.put(`guild:${guildId}`, guild);
				return new Response(JSON.stringify({ ok: true, guild: null, disbanded: false }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Could not leave guild' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/get-by-player') {
			const uid = String(url.searchParams.get('uid') || '').trim();
			if (!uid) return new Response(JSON.stringify({ ok: false, guild: null }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			const guildId = await this.state.storage.get(`playerGuild:${uid}`);
			if (!guildId) return new Response(JSON.stringify({ ok: true, guild: null }), { headers: { 'Content-Type': 'application/json' } });
			const guild = await this.state.storage.get(`guild:${guildId}`);
			return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/directory') {
			const list = await this.state.storage.list({ prefix: 'guild:' });
			const guilds = [];
			for (const [, guild] of list) {
				if (!guild || guild.isPublic === false) continue;
				guilds.push(guildSummary(guild));
			}
			guilds.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0) || (b.xp || 0) - (a.xp || 0));
			return new Response(JSON.stringify({ ok: true, guilds: guilds.slice(0, 50) }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/add-xp' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				const xp = Math.max(0, Number(body.xp) || 0);
				if (!uid || xp <= 0) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (!guildId) return new Response(JSON.stringify({ ok: true, guild: null }), { headers: { 'Content-Type': 'application/json' } });
				const guild = await this.state.storage.get(`guild:${guildId}`);
				if (!guild) return new Response(JSON.stringify({ ok: true, guild: null }), { headers: { 'Content-Type': 'application/json' } });
				guild.xp = Math.max(0, Number(guild.xp) || 0) + xp;
				const member = (guild.members || []).find((m) => m.uid === uid);
				if (member) member.contributedXp = Math.max(0, Number(member.contributedXp) || 0) + xp;
				await this.state.storage.put(`guild:${guildId}`, guild);
				return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/chat' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				const username = String(body.username || 'Player').trim().slice(0, 24);
				const message = String(body.message || '').trim().replace(/\s+/g, ' ').slice(0, 160);
				if (!uid || !message) return new Response(JSON.stringify({ ok: false, error: 'Missing message' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (!guildId) return new Response(JSON.stringify({ ok: false, error: 'You are not in a guild' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guild = await this.state.storage.get(`guild:${guildId}`);
				if (!guild) return new Response(JSON.stringify({ ok: false, error: 'Guild no longer exists' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
				guild.chat = guild.chat || [];
				guild.chat.push({
					uid,
					username,
					message,
					ts: Date.now()
				});
				if (guild.chat.length > 40) guild.chat = guild.chat.slice(-40);
				await this.state.storage.put(`guild:${guildId}`, guild);
				return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Could not send message' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/update' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				if (!uid) return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (!guildId) return new Response(JSON.stringify({ ok: false, error: 'You are not in a guild' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guild = await this.state.storage.get(`guild:${guildId}`);
				if (!guild) return new Response(JSON.stringify({ ok: false, error: 'Guild no longer exists' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
				const actor = (guild.members || []).find((m) => m.uid === uid);
				if (!actor) return new Response(JSON.stringify({ ok: false, error: 'Guild member not found' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
				const wantsCoreSettings = Object.prototype.hasOwnProperty.call(body, 'description')
					|| Object.prototype.hasOwnProperty.call(body, 'icon')
					|| Object.prototype.hasOwnProperty.call(body, 'banner')
					|| Object.prototype.hasOwnProperty.call(body, 'isPublic');
				const wantsRecruitmentSettings = Object.prototype.hasOwnProperty.call(body, 'recruitmentStatus')
					|| Object.prototype.hasOwnProperty.call(body, 'recruitmentMessage')
					|| Object.prototype.hasOwnProperty.call(body, 'recruitmentFocus')
					|| Object.prototype.hasOwnProperty.call(body, 'recruitmentPlaystyle')
					|| Object.prototype.hasOwnProperty.call(body, 'bulletinMessage');
				if (wantsCoreSettings && !canManageGuildRole(actor.role)) {
					return new Response(JSON.stringify({ ok: false, error: 'Only guild admins can update guild settings' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
				}
				if (wantsRecruitmentSettings && !canManageGuildRecruitment(actor.role)) {
					return new Response(JSON.stringify({ ok: false, error: 'Only guild leaders or approved recruiters can update recruitment posts' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
				}
				if (wantsCoreSettings) {
					guild.description = sanitizeGuildDescription(body.description || guild.description || '');
					guild.icon = sanitizeGuildVisualId(body.icon, guild.icon || 'comet');
					guild.banner = sanitizeGuildVisualId(body.banner, guild.banner || 'aurora');
					guild.isPublic = body.isPublic !== false;
				}
				if (wantsRecruitmentSettings) {
					guild.recruitmentStatus = sanitizeGuildRecruitmentStatus(body.recruitmentStatus, guild.recruitmentStatus || (guild.isPublic === false ? 'invite_only' : 'recruiting'));
					guild.recruitmentMessage = sanitizeGuildRecruitmentMessage(body.recruitmentMessage || '');
					guild.recruitmentFocus = sanitizeGuildRecruitmentFocus(body.recruitmentFocus, guild.recruitmentFocus || 'all_modes');
					guild.recruitmentPlaystyle = sanitizeGuildRecruitmentPlaystyle(body.recruitmentPlaystyle, guild.recruitmentPlaystyle || 'mixed');
					const bulletinMessage = sanitizeGuildBulletin(body.bulletinMessage || '');
					guild.bulletinMessage = bulletinMessage;
					guild.bulletinUpdatedAt = bulletinMessage ? Date.now() : null;
					guild.bulletinUpdatedBy = bulletinMessage ? (actor.username || actor.uid) : null;
				}
				await this.state.storage.put(`guild:${guildId}`, guild);
				return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Could not update guild settings' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/member-role' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = String(body.uid || '').trim();
				const targetUid = String(body.targetUid || '').trim();
				const role = String(body.role || '').trim();
				if (!uid || !targetUid || !role) return new Response(JSON.stringify({ ok: false, error: 'Missing role update data' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guildId = await this.state.storage.get(`playerGuild:${uid}`);
				if (!guildId) return new Response(JSON.stringify({ ok: false, error: 'You are not in a guild' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const guild = await this.state.storage.get(`guild:${guildId}`);
				if (!guild) return new Response(JSON.stringify({ ok: false, error: 'Guild no longer exists' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
				const actor = (guild.members || []).find((m) => m.uid === uid);
				if (!actor || actor.role !== 'Leader') return new Response(JSON.stringify({ ok: false, error: 'Only the guild leader can change member roles' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
				if (uid === targetUid) return new Response(JSON.stringify({ ok: false, error: 'Use leadership transfer later for self role changes' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				const target = (guild.members || []).find((m) => m.uid === targetUid);
				if (!target) return new Response(JSON.stringify({ ok: false, error: 'Guild member not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
				target.role = role === 'Officer' ? 'Officer' : role === 'Recruiter' ? 'Recruiter' : 'Member';
				await this.state.storage.put(`guild:${guildId}`, guild);
				return new Response(JSON.stringify({ ok: true, guild: guildSummary(guild) }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Could not update guild member role' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
		}

		if (url.pathname === '/wipe' && request.method === 'POST') {
			await this.state.storage.deleteAll();
			return new Response(JSON.stringify({ ok: true }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response('Not found', { status: 404 });
	}
}

export class PartyRoom {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sessions = [];
		this.partyState = {
			status: 'WAITING',
			leaderUid: null,
			players: {}
		};
	}

	async fetch(request) {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}
		let p = new WebSocketPair();
		let [client, server] = Object.values(p);
		server.accept();

		const url = new URL(request.url);
		const uid = url.searchParams.get('uid');
		const username = decodeURIComponent(url.searchParams.get('username') || 'Player');

		if (!uid) {
			server.close(4000, 'Missing uid');
			return new Response(null, { status: 101, webSocket: client });
		}

		if (this.sessions.length === 0) {
			this.partyState.leaderUid = uid;
		} else if (this.sessions.length >= 4) {
			server.close(4001, 'Party full');
			return new Response(null, { status: 101, webSocket: client });
		}

		this.partyState.players[uid] = { uid, username, ready: false };
		this.sessions.push({ ws: server, uid });

		server.addEventListener('message', async (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.action === 'ready' || data.action === 'set_ready') {
					this.partyState.players[uid].ready = data.ready != null ? !!data.ready : !!data.isReady;
					this.broadcastState();
				} else if ((data.action === 'queue' || data.action === 'find_match') && this.partyState.leaderUid === uid) {
					// Check if everyone is ready
					const allReady = Object.values(this.partyState.players).every(p => p.ready || p.uid === this.partyState.leaderUid);
					if (allReady) {
						this.partyState.status = 'QUEUING';
						this.broadcastState();
						
						// Talk to Matchmaker
						const mmId = this.env.MATCHMAKER.idFromName('global-matchmaker');
						const mm = this.env.MATCHMAKER.get(mmId);
						const res = await mm.fetch(new Request('http://internal/get-room?queue=2v2'));
						const rData = await res.json();
						
						const msg = JSON.stringify({ type: 'MATCH_FOUND', roomId: rData.roomId });
						this.sessions.forEach(s => { try { s.ws.send(msg); } catch(e){} });
					}
				}
			} catch (e) {}
		});

		server.addEventListener('close', () => {
			this.sessions = this.sessions.filter(s => s.ws !== server);
			delete this.partyState.players[uid];
			if (this.sessions.length === 0) {
				this.partyState.leaderUid = null;
			} else if (this.partyState.leaderUid === uid) {
				this.partyState.leaderUid = this.sessions[0].uid;
			}
			this.broadcastState();
		});
		
		server.addEventListener('error', () => {
			try { server.close(); } catch(e) {}
		});

		this.broadcastState();

		return new Response(null, { status: 101, webSocket: client });
	}

	broadcastState() {
		const members = Object.values(this.partyState.players || {}).map((p) => ({
			uid: p.uid,
			username: p.username,
			isReady: !!p.ready,
			status: p.ready ? 'ready' : 'waiting'
		}));
		const state = {
			status: this.partyState.status,
			leader: this.partyState.leaderUid,
			leaderUid: this.partyState.leaderUid,
			members
		};
		const msg = JSON.stringify({ type: 'PARTY_STATE', state });
		this.sessions.forEach(s => { try { s.ws.send(msg); } catch(e){} });
	}
}

export class ModerationHub {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/append" && request.method === "POST") {
			try {
				const row = await request.json();
				let list = (await this.state.storage.get("reports")) || [];
				list.push(row);
				if (list.length > 500) list = list.slice(-500);
				await this.state.storage.put("reports", list);
				return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/list" && request.method === "GET") {
			try {
				const list = (await this.state.storage.get("reports")) || [];
				return new Response(JSON.stringify({ ok: true, reports: list }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, reports: [] }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/remove-report" && request.method === "POST") {
			try {
				const body = await request.json();
				const ts = body && body.ts;
				const reporterUid = body && body.reporterUid;
				const reportedUid = body && body.reportedUid;
				let list = (await this.state.storage.get("reports")) || [];
				const before = list.length;
				list = list.filter(
					(r) => !(r.ts === ts && r.reporterUid === reporterUid && r.reportedUid === reportedUid)
				);
				await this.state.storage.put("reports", list);
				return new Response(JSON.stringify({ ok: true, removed: before - list.length }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, removed: 0 }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/get-events" && request.method === "GET") {
			try {
				const events = await this.state.storage.get("adminEventsCatalog");
				return new Response(JSON.stringify({ ok: true, events }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, events: [] }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/set-events" && request.method === "POST") {
			try {
				const body = await request.json();
				const events = Array.isArray(body && body.events) ? body.events : [];
				await this.state.storage.put("adminEventsCatalog", events);
				return new Response(JSON.stringify({ ok: true, count: events.length }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, count: 0 }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/get-flags" && request.method === "GET") {
			try {
				const flags = await this.state.storage.get("adminFeatureFlags");
				return new Response(JSON.stringify({ ok: true, flags }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, flags: null }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/set-flags" && request.method === "POST") {
			try {
				const body = await request.json();
				const flags = body && body.flags ? body.flags : null;
				await this.state.storage.put("adminFeatureFlags", flags);
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/get-announcement" && request.method === "GET") {
			try {
				const announcement = await this.state.storage.get("adminAnnouncement");
				return new Response(JSON.stringify({ ok: true, announcement }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, announcement: null }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/set-announcement" && request.method === "POST") {
			try {
				const body = await request.json();
				const announcement = body && body.announcement ? body.announcement : null;
				await this.state.storage.put("adminAnnouncement", announcement);
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "Content-Type": "application/json" }
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "Content-Type": "application/json" } });
			}
		}
		if (url.pathname === "/wipe" && request.method === "POST") {
			await this.state.storage.deleteAll();
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" }
			});
		}
		return new Response("Not found", { status: 404 });
	}
}

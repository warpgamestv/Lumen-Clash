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
		[...uids].map(async (uid) => [uid, await lookupUsernameForUid(env, uid)])
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
	const pRes = await p.fetch(new Request('http://internal/get-stats'));
	const pData = await pRes.json();

	if (pData.username) {
		const reg = env.USERNAME_REGISTRY.get(env.USERNAME_REGISTRY.idFromName('global'));
		await reg.fetch(new Request(`http://internal/release?uid=${encodeURIComponent(uid)}&name=${encodeURIComponent(pData.username)}`));
	}

	await p.fetch(new Request('http://internal/wipe'));
	await removePlayerFromLeaderboard(env, uid);
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
			const repName = (repUid && nameByUid[repUid]) || '—';
			const reportedName = (reportedUid && nameByUid[reportedUid]) || '—';
			const room = r.roomId || '';
			const cli = r.clientVersion || '';
			const details = r.details || '';
			const searchBlob = [t, cat, repUid, repName, reportedUid, reportedName, room, cli, details].join(' ').toLowerCase();

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

			const resetReportedForm =
				embeddedSecret && reportedUid
					? `<form method="post" action="/admin/moderate" class="inline-form" onsubmit="return confirm('Wipe this reported account (progress, username, leaderboard)?');"><input type="hidden" name="secret" value="${escapeAttr(
							embeddedSecret
					  )}"><input type="hidden" name="action" value="reset_player"><input type="hidden" name="targetUid" value="${escapeAttr(
							reportedUid
					  )}"><button type="submit" class="btn btn-danger">Reset reported</button></form>`
					: '—';

			const resetReporterForm =
				embeddedSecret && repUid
					? `<form method="post" action="/admin/moderate" class="inline-form" onsubmit="return confirm('Wipe the reporter account?');"><input type="hidden" name="secret" value="${escapeAttr(
							embeddedSecret
					  )}"><input type="hidden" name="action" value="reset_player"><input type="hidden" name="targetUid" value="${escapeAttr(
							repUid
					  )}"><button type="submit" class="btn btn-warn">Reset reporter</button></form>`
					: '—';

			return `<tr data-cat="${escapeAttr(cat)}" data-search="${escapeAttr(searchBlob)}"><td class="nowrap mono">${escapeHtml(
				t
			)}</td><td><span class="pill">${escapeHtml(cat)}</span></td><td class="player-cell"><span class="mono sm">${escapeHtml(
				repUid
			)}</span><span class="un">${escapeHtml(repName)}</span></td><td class="player-cell"><span class="mono sm">${escapeHtml(
				reportedUid
			)}</span><span class="un">${escapeHtml(reportedName)}</span></td><td class="mono sm">${escapeHtml(room)}</td><td class="mono sm">${escapeHtml(
				cli
			)}</td><td class="details">${escapeHtml(details)}</td><td class="actions">${resetReportedForm}${resetReporterForm}${dismissForm}</td></tr>`;
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
.pill{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(34,211,238,.12);color:var(--accent2);font-size:.8rem;font-weight:600}
.details{max-width:340px;word-break:break-word;white-space:pre-wrap;color:#d8d1f0;line-height:1.35}
.actions{min-width:200px}.inline-form{margin:0 0 8px}.inline-form:last-child{margin-bottom:0}
.btn{display:inline-block;padding:8px 12px;border-radius:8px;border:1px solid transparent;font-size:.82rem;font-weight:600;cursor:pointer;width:100%;transition:transform .05s,filter .15s}
.btn:active{transform:scale(.98)}.btn-primary{background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff}.btn-primary:hover{filter:brightness(1.08)}
.btn-muted{background:rgba(255,255,255,.08);color:var(--text);border-color:var(--stroke)}.btn-muted:hover{background:rgba(255,255,255,.12)}
.btn-danger{background:rgba(248,113,113,.2);color:#fecaca;border-color:rgba(248,113,113,.4)}.btn-danger:hover{background:rgba(248,113,113,.3)}
.btn-warn{background:rgba(251,191,36,.15);color:#fde68a;border-color:rgba(251,191,36,.35)}.btn-warn:hover{background:rgba(251,191,36,.25)}
.row{display:flex;align-items:center;gap:8px}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Moderation desk</h1><p class="sub">Player reports - Newest first - Up to 500 stored</p></header>
${errBlock}${okBlock}
${loginForm}
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
(function(){var q=document.getElementById("filterQ");var cat=document.getElementById("filterCat");var tbl=document.getElementById("reportTable");if(!q||!tbl)return;var rows=[].slice.call(tbl.querySelectorAll("tbody tr"));var rc=document.getElementById("rowCount");function apply(){var cq=(q.value||"").toLowerCase();var cc=cat?cat.value:"";var vis=0;var total=0;rows.forEach(function(tr){var tds=tr.querySelectorAll("td");if(tds.length===1&&tds[0].hasAttribute("colspan")){tr.style.display="";return;}total++;var blob=(tr.getAttribute("data-search")||"").toLowerCase();var c=tr.getAttribute("data-cat")||"";var okQ=!cq||blob.indexOf(cq)!==-1;var okC=!cc||c===cc;var show=okQ&&okC;tr.style.display=show?"":"none";if(show)vis++;});if(rc)rc.textContent=vis+" / "+total+" rows";}q.addEventListener("input",apply);if(cat)cat.addEventListener("change",apply);apply();})();
</script>
</body>
</html>`;
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === '/play') {
			let charId = url.searchParams.get('char') || 'voidWeaver';
			let skin = url.searchParams.get('skin') || 'Default';
			console.log(`[GameJoin] User: ${url.searchParams.get('uid')} Class: ${charId} Skin: ${skin}`);
			let playerId = url.searchParams.get('uid') || crypto.randomUUID();
			let specificRoomId = url.searchParams.get('roomId');

			let roomId, isNew;
			if (specificRoomId) {
				roomId = specificRoomId;
				isNew = true; // For private, we let the GameRoom handle uniqueness
			} else {
				let mmId = env.MATCHMAKER.idFromName('global-matchmaker');
				let mm = env.MATCHMAKER.get(mmId);
				let mmRes = await mm.fetch('http://internal/get-room');
				let mmData = await mmRes.json();
				roomId = mmData.roomId;
				isNew = mmData.isNew;
			}

			let id = env.GAME_ROOM.idFromName(roomId); 
			let room = env.GAME_ROOM.get(id);
			return room.fetch(new Request(`http://internal/play?roomId=${roomId}&isNew=${isNew}&char=${charId}&uid=${playerId}&skin=${skin}`, request));
		}

		if (url.pathname === '/profile') {
			let uid = url.searchParams.get('uid');
			if (!uid) return new Response('Missing UID', { status: 400 });
			let id = env.PLAYER_PROFILE.idFromName(uid);
			let profile = env.PLAYER_PROFILE.get(id);
			return profile.fetch(new Request(`http://internal/get-stats?uid=${uid}`));
		}

		if (url.pathname === '/set-username' || url.pathname === '/save-customization') {
			if (request.method === 'OPTIONS') {
				return new Response(null, { headers: corsHeaders(request, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }) });
			}
			
			if (url.pathname === '/save-customization') {
				try {
					const body = await request.json();
					const uid = body.uid;
					if (!uid) return new Response('Missing UID', { status: 400 });
					let profileId = env.PLAYER_PROFILE.idFromName(uid);
					let profile = env.PLAYER_PROFILE.get(profileId);
					return profile.fetch(new Request('http://internal/save-customization', {
						method: 'POST',
						body: JSON.stringify(body),
						headers: { 'Content-Type': 'application/json' }
					}));
				} catch(e) {
					return new Response('Invalid Request', { status: 400 });
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
			return lb.fetch(new Request('http://internal/top'));
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
			let p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
			let res = await p.fetch(new Request(`http://internal/get-lobby-data`));
			let data = await res.json();
			return new Response(JSON.stringify(data.social), { headers: { 'Content-Type': 'application/json' }});
		}

		const jsonHeaders = corsHeaders(request, { 'Content-Type': 'application/json' });

		if (url.pathname === '/update-presence' && request.method === 'POST') {
			try {
				const body = await request.json();
				const uid = body.uid;
				if (!uid) return new Response(JSON.stringify({ ok: false, error: 'Missing uid' }), { status: 400, headers: jsonHeaders });
				const profile = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				return profile.fetch(
					new Request('http://internal/update-presence', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ state: body.state })
					})
				);
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/friend-duel-invite' && request.method === 'POST') {
			try {
				const body = await request.json();
				const { uid, targetUid } = body;
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`friend-duel-invite:${uid || clientIp}:${clientIp}`, 20, 60_000)) {
					return new Response(JSON.stringify({ ok: false, error: 'Rate limit exceeded. Try again shortly.' }), { status: 429, headers: jsonHeaders });
				}
				if (!uid || !targetUid || uid === targetUid) {
					return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), { status: 400, headers: jsonHeaders });
				}
				const pSelf = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const selfRes = await pSelf.fetch(new Request('http://internal/get-stats'));
				const selfData = await selfRes.json();
				if (!selfData.friends || !selfData.friends.includes(targetUid)) {
					return new Response(JSON.stringify({ ok: false, error: 'You can only challenge friends' }), { status: 403, headers: jsonHeaders });
				}
				const mmId = env.MATCHMAKER.idFromName('global-matchmaker');
				const mmRes = await env.MATCHMAKER.get(mmId).fetch(new Request('http://internal/create-private'));
				const roomPayload = await mmRes.json();
				if (!roomPayload.roomId || !roomPayload.code) {
					return new Response(JSON.stringify({ ok: false, error: 'Could not create room' }), { status: 500, headers: jsonHeaders });
				}
				const pTarget = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(targetUid));
				await pTarget.fetch(
					new Request('http://internal/duel-invite-add', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							fromUid: uid,
							roomId: roomPayload.roomId,
							code: roomPayload.code
						})
					})
				);
				return new Response(
					JSON.stringify({ ok: true, roomId: roomPayload.roomId, code: roomPayload.code }),
					{ headers: jsonHeaders }
				);
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: 'Server error' }), { status: 500, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/friend-duel-decline' && request.method === 'POST') {
			try {
				const body = await request.json();
				const { uid, fromUid } = body;
				if (!uid || !fromUid) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
				const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				await p.fetch(
					new Request('http://internal/duel-invite-remove', {
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

		if (url.pathname === '/friend-duel-accept' && request.method === 'POST') {
			try {
				const body = await request.json();
				const { uid, fromUid } = body;
				if (!uid || !fromUid) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
				const p = env.PLAYER_PROFILE.get(env.PLAYER_PROFILE.idFromName(uid));
				const res = await p.fetch(
					new Request('http://internal/duel-invite-take', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ fromUid })
					})
				);
				const data = await res.json();
				return new Response(JSON.stringify(data), { headers: jsonHeaders });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false }), { status: 400, headers: jsonHeaders });
			}
		}

		if (url.pathname === '/create-private') {
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
			let code = url.searchParams.get('code');
			let mmId = env.MATCHMAKER.idFromName('global-matchmaker');
			return env.MATCHMAKER.get(mmId).fetch(new Request(`http://internal/join-private?code=${code}`));
		}

		if (url.pathname === '/admin/reports') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(
					renderReportsAdminPage([], {}, {
						errorMsg: 'ADMIN_REPORTS_SECRET is not configured — run: wrangler secret put ADMIN_REPORTS_SECRET'
					}),
					{ status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
				);
			}
			if (request.method === 'GET') {
				return new Response(renderReportsAdminPage([], {}, {}), {
					headers: { 'Content-Type': 'text/html; charset=utf-8' }
				});
			}
			if (request.method === 'POST') {
				const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
				if (isRateLimited(`admin-reports:${clientIp}`, 30, 60_000)) {
					return new Response(renderReportsAdminPage([], {}, { errorMsg: 'Too many attempts. Try again in a minute.' }), {
						status: 429,
						headers: { 'Content-Type': 'text/html; charset=utf-8' }
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
					return new Response(renderReportsAdminPage([], {}, { errorMsg: 'Invalid secret.' }), {
						status: 401,
						headers: { 'Content-Type': 'text/html; charset=utf-8' }
					});
				}
				try {
					const hub = env.MODERATION_HUB.get(env.MODERATION_HUB.idFromName('global'));
					const listRes = await hub.fetch(new Request('http://internal/list'));
					const data = await listRes.json();
					const reports = data.reports || [];
					const nameByUid = await resolveReportPlayerNames(env, reports);
					return new Response(renderReportsAdminPage(reports, nameByUid, { embeddedSecret: secretInput }), {
						headers: { 'Content-Type': 'text/html; charset=utf-8' }
					});
				} catch (e) {
					return new Response(renderReportsAdminPage([], {}, { errorMsg: 'Could not load reports.' }), {
						status: 500,
						headers: { 'Content-Type': 'text/html; charset=utf-8' }
					});
				}
			}
			return new Response('Method not allowed', { status: 405 });
		}

		if (url.pathname === '/admin/moderate') {
			const configured = getAdminReportsSecret(env);
			if (!configured) {
				return new Response(
					renderReportsAdminPage([], {}, { errorMsg: 'ADMIN_REPORTS_SECRET is not configured.' }),
					{ status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
				);
			}
			if (request.method !== 'POST') {
				return new Response('Method not allowed', { status: 405 });
			}
			const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
			if (isRateLimited(`admin-moderate:${clientIp}`, 40, 60_000)) {
				return new Response(renderReportsAdminPage([], {}, { errorMsg: 'Too many moderation attempts. Wait a minute.' }), {
					status: 429,
					headers: { 'Content-Type': 'text/html; charset=utf-8' }
				});
			}
			const okSecret = await parseAdminSecretBody(request.clone(), configured);
			if (!okSecret) {
				return new Response(renderReportsAdminPage([], {}, { errorMsg: 'Invalid secret.' }), {
					status: 401,
					headers: { 'Content-Type': 'text/html; charset=utf-8' }
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
					renderReportsAdminPage(reports, nameByUid, {
						embeddedSecret: okSecret,
						successMsg: successMsg || undefined,
						errorMsg: errFlash || undefined
					}),
					{ status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
				);
			} catch (e) {
				return new Response(
					renderReportsAdminPage([], {}, { embeddedSecret: okSecret, errorMsg: errFlash || 'Could not reload list.' }),
					{ status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
				);
			}
		}

		if (url.pathname === '/report') {
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

		if (url.pathname === '/unlock-premium') {
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
					return profile.fetch(
						new Request(`http://internal/unlock-premium?uid=${encodeURIComponent(uid)}`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: '{}'
						})
					);
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
	{ id: 'w_wins', label: 'Win 3 matches', slot: 'weekly', target: 3, metric: 'wins' },
	{ id: 'w_play', label: 'Play 10 matches', slot: 'weekly', target: 10, metric: 'matches' }
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
		stats.questMetrics.daily = { periodKey: dk, wins: 0, matches: 0, claimed: {} };
		changed = true;
	} else {
		stats.questMetrics.daily = {
			periodKey: dk,
			wins: d.wins || 0,
			matches: d.matches || 0,
			claimed: d.claimed && typeof d.claimed === 'object' ? d.claimed : {}
		};
	}
	if (w.periodKey !== wk) {
		stats.questMetrics.weekly = { periodKey: wk, wins: 0, matches: 0, claimed: {} };
		changed = true;
	} else {
		stats.questMetrics.weekly = {
			periodKey: wk,
			wins: w.wins || 0,
			matches: w.matches || 0,
			claimed: w.claimed && typeof w.claimed === 'object' ? w.claimed : {}
		};
	}
	return changed;
}

function questProgress(bucket, q) {
	if (q.metric === 'wins') return bucket.wins || 0;
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
			}
		};
		stats.matchHistory = stats.matchHistory || [];
		stats.classes = stats.classes || {
			'aegisKnight': { level: 1, xp: 0 },
			'lumenSage': { level: 1, xp: 0 },
			'voidWeaver': { level: 1, xp: 0 }
		};
		stats.unlockedCosmetics = stats.unlockedCosmetics || [];
		stats.unlockedTitles = stats.unlockedTitles || [];
		stats.equippedSkins = stats.equippedSkins || {};

		// Generate a random username on first ever access
		if (!stats.username) {
			stats.username = generateRandomUsername();
			// Register it globally
			const uid = url.searchParams.get('uid');
			if (uid) {
				try {
					let regId = this.env.USERNAME_REGISTRY.idFromName('global');
					let registry = this.env.USERNAME_REGISTRY.get(regId);
					await registry.fetch(new Request(`http://internal/claim?name=${encodeURIComponent(stats.username)}&uid=${uid}`));
				} catch(e) { /* best-effort registration for auto-generated names */ }
			}
			await this.state.storage.put('stats', stats);
		}

		if (url.pathname === '/get-stats') {
			let dirty = false;
			if (syncAccountLevelFromClasses(stats)) dirty = true;
			if (ensureQuestBuckets(stats)) dirty = true;
			stats.lumens = Math.max(0, Number(stats.lumens) || 0);
			stats.luminaryPassXp = Math.max(0, Number(stats.luminaryPassXp) || 0);
			if (stats.bpPremiumUnlocked === undefined) stats.bpPremiumUnlocked = false;
			if (dirty) await this.state.storage.put('stats', stats);
			const out = { ...stats, questCatalog: QUEST_CATALOG };
			return new Response(JSON.stringify(out), { headers: corsHeaders(request) });
		}

		if (url.pathname === '/set-name') {
			stats.username = decodeURIComponent(url.searchParams.get('name'));
			await this.state.storage.put('stats', stats);
			return new Response('OK');
		}

		if (url.pathname === '/add-xp') {
			let isWin = false;
			let classId = 'aegisKnight';
			let uid = url.searchParams.get('uid') || 'unknown';
			let matchSnap = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };

			if (request.method === 'POST') {
				try {
					const j = await request.json();
					isWin = !!j.win;
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
			stats.luminaryPassXp += xpGained;

			ensureQuestBuckets(stats);
			const questCompleted = [];
			const lumensPerQuest = 5;
			const daily = stats.questMetrics.daily;
			const weekly = stats.questMetrics.weekly;
			const prevD = { wins: daily.wins, matches: daily.matches };
			const prevW = { wins: weekly.wins, matches: weekly.matches };
			daily.matches += 1;
			weekly.matches += 1;
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
					bucket.claimed[q.id] = true;
					questCompleted.push({ id: q.id, label: q.label });
					stats.lumens += lumensPerQuest;
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
					lastMatchClassId: classId,
					xpGained,
					leveledUp,
					questCompleted,
					matchStats: matchSnap
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

		if (url.pathname === '/duel-invite-add') {
			const { fromUid, roomId, code } = await request.json();
			if (!fromUid || !roomId || !code) return new Response(JSON.stringify({ ok: false }), { status: 400 });
			stats.duelInvites = stats.duelInvites || [];
			const now = Date.now();
			stats.duelInvites = stats.duelInvites.filter((i) => now - (i.ts || 0) < DUEL_INVITE_TTL_MS && i.fromUid !== fromUid);
			stats.duelInvites.push({ fromUid, roomId, code, ts: now });
			if (stats.duelInvites.length > 8) stats.duelInvites = stats.duelInvites.slice(-8);
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/duel-invite-remove') {
			const body = await request.json();
			const fromUid = body.fromUid;
			if (!fromUid) return new Response(JSON.stringify({ ok: false }), { status: 400 });
			stats.duelInvites = (stats.duelInvites || []).filter((i) => i.fromUid !== fromUid);
			await this.state.storage.put('stats', stats);
			return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/duel-invite-take') {
			const body = await request.json();
			const fromUid = body.fromUid;
			if (!fromUid) return new Response(JSON.stringify({ ok: false, error: 'Missing fromUid' }), { status: 400 });
			const now = Date.now();
			stats.duelInvites = stats.duelInvites || [];
			const inv = stats.duelInvites.find((i) => i.fromUid === fromUid && now - (i.ts || 0) < DUEL_INVITE_TTL_MS);
			if (!inv) return new Response(JSON.stringify({ ok: false, error: 'Invite expired or not found' }), { status: 404 });
			stats.duelInvites = stats.duelInvites.filter((i) => i.fromUid !== fromUid);
			await this.state.storage.put('stats', stats);
			return new Response(
				JSON.stringify({ ok: true, roomId: inv.roomId, code: inv.code }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
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
			const cost = 100;
			stats.lumens = Math.max(0, Number(stats.lumens) || 0);
			if (stats.bpPremiumUnlocked) {
				const out = { ...stats, questCatalog: QUEST_CATALOG };
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
			const out = { ...stats, questCatalog: QUEST_CATALOG };
			return new Response(JSON.stringify({ ok: true, stats: out }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/wipe') {
			await this.state.storage.deleteAll();
			return new Response('OK');
		}

		if (url.pathname === '/get-lobby-data') {
			stats.friends = stats.friends || [];
			stats.friendRequests = stats.friendRequests || [];
			
			const ONLINE_GRACE_MS = 90000;

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
			stats.duelInvites = stats.duelInvites || [];
			const freshDuels = stats.duelInvites.filter((i) => now - (i.ts || 0) < DUEL_INVITE_TTL_MS);
			if (freshDuels.length !== stats.duelInvites.length) {
				stats.duelInvites = freshDuels;
				await this.state.storage.put('stats', stats);
			}

			const duelInvitesResolved = [];
			for (const inv of freshDuels) {
				try {
					const fp = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(inv.fromUid));
					const fr = await fp.fetch(new Request(`http://internal/get-stats`));
					const fd = await fr.json();
					duelInvitesResolved.push({
						fromUid: inv.fromUid,
						fromUsername: fd.username || 'Player',
						roomId: inv.roomId,
						code: inv.code,
						ts: inv.ts
					});
				} catch (e) {}
			}
			
			const [friendsArr, requestsArr] = await Promise.all([
				fetchDetails(stats.friends),
				fetchDetails(stats.friendRequests)
			]);

			return new Response(JSON.stringify({ 
				profile: stats,
				social: {
					friends: friendsArr,
					requests: requestsArr,
					duelInvites: duelInvitesResolved
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

		if (url.pathname === '/release') {
			const name = decodeURIComponent(url.searchParams.get('name')).toLowerCase();
			const uid = url.searchParams.get('uid');
			await this.state.storage.delete(`name:${name}`);
			await this.state.storage.delete(`uid:${uid}`);
			return new Response('OK');
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
		const charId = url.searchParams.get('char');
		const playerId = url.searchParams.get('uid');
		const skinId = url.searchParams.get('skin') || 'Default';

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

		let pId = null;
		if (!this.gameState.players['p1']) {
			pId = 'p1';
		} else if (!this.gameState.players['p2']) {
			pId = 'p2';
		}

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

		if (this.sessions.length === 2) {
			this.gameState.status = 'IN_PROGRESS';
			this.gameState.turn = 0;
			this.startTurnTimer();
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
			
			if (this.gameState.status !== 'IN_PROGRESS') return;

			const isTurn = (playerId === 'p1' && this.gameState.turn === 0) || (playerId === 'p2' && this.gameState.turn === 1);
			if (!isTurn) return;

			const opponentId = playerId === 'p1' ? 'p2' : 'p1';
			const player = this.gameState.players[playerId];
			const opponent = this.gameState.players[opponentId];

			if (data.action === 'ability') {
				const idx = data.abilityIndex;
				if (idx < 0 || idx >= player.abilities.length) return;

				const ability = player.abilities[idx];
				if (ability.currentCd > 0) return; // Still on cooldown

				if (!player.matchStats) {
					player.matchStats = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };
				}
				if (!opponent.matchStats) {
					opponent.matchStats = { damageDealt: 0, damageTaken: 0, abilitiesUsed: 0, turnSwaps: 0 };
				}
				player.matchStats.abilitiesUsed += 1;

				// Apply ability effects
				if (ability.type === 'damage') {
					let dmg = ability.dmg + (player.atkBonus || 0);
					if (opponent.dodge) {
						dmg = 0; // Dodged!
						opponent.dodge = false;
					} else if (opponent.shield.active) {
						dmg = Math.floor(dmg * (1 - opponent.shield.percent / 100));
						opponent.shield = { active: false, percent: 0 };
					}
					opponent.health -= dmg;
					if (dmg > 0) {
						player.matchStats.damageDealt += dmg;
						opponent.matchStats.damageTaken += dmg;
					}
				} else if (ability.type === 'drain') {
					let dmg = ability.dmg + (player.atkBonus || 0);
					if (opponent.dodge) {
						dmg = 0;
						opponent.dodge = false;
					} else if (opponent.shield.active) {
						dmg = Math.floor(dmg * (1 - opponent.shield.percent / 100));
						opponent.shield = { active: false, percent: 0 };
					}
					opponent.health -= dmg;
					if (dmg > 0) {
						player.matchStats.damageDealt += dmg;
						opponent.matchStats.damageTaken += dmg;
					}
					player.health = Math.min(player.maxHealth, player.health + (ability.healAmt || 0));
				} else if (ability.type === 'heal') {
					player.health = Math.min(player.maxHealth, player.health + (ability.healAmt || 0));
				} else if (ability.type === 'shield') {
					player.shield = { active: true, percent: ability.shieldPct || 50 };
				} else if (ability.type === 'dodge') {
					player.dodge = true;
				}

				// Set cooldown
				if (ability.cooldown > 0) {
					ability.currentCd = ability.cooldown;
				}

				// Check Game Over
				let p1 = this.gameState.players['p1'];
				let p2 = this.gameState.players['p2'];
				if (p1.health <= 0 || p2.health <= 0) {
					this.gameState.status = 'GAME_OVER';
					this.clearTurnTimer();

					const ser = this.gameState.series;
					if (ser && !ser.complete) {
						if (p1.health > 0) ser.p1Wins = Math.min(ser.needed, ser.p1Wins + 1);
						else if (p2.health > 0) ser.p2Wins = Math.min(ser.needed, ser.p2Wins + 1);
						if (ser.p1Wins >= ser.needed || ser.p2Wins >= ser.needed) ser.complete = true;
					}
					
					const awardXP = async (p, isWin) => {
						if (!p || !p.uid) return null;
						try {
							let xpDO = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(p.uid));
							const ms = p.matchStats || {};
							const res = await xpDO.fetch(
								new Request("http://internal/add-xp", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										win: isWin,
										uid: p.uid,
										classId: p.classId,
										matchStats: {
											damageDealt: ms.damageDealt || 0,
											damageTaken: ms.damageTaken || 0,
											abilitiesUsed: ms.abilitiesUsed || 0,
											turnSwaps: ms.turnSwaps || 0
										}
									})
								})
							);
							const updatedStats = await res.json();
							return {
								xpGained: isWin ? 50 : 10,
								...updatedStats
							};
						} catch (e) {
							console.error("Failed assigning XP:", e);
							return null;
						}
					};
					const [p1Results, p2Results] = await Promise.all([
						awardXP(p1, p1.health > 0),
						awardXP(p2, p2.health > 0)
					]);

					if (p1Results) p1.postGame = p1Results;
					if (p2Results) p2.postGame = p2Results;

					this.broadcastState();
				} else {
					// Pass turn and tick the next player's cooldowns
					player.matchStats.turnSwaps += 1;
					this.gameState.turn = this.gameState.turn === 0 ? 1 : 0;
					const nextPlayerId = this.gameState.turn === 0 ? 'p1' : 'p2';
					for (let ab of this.gameState.players[nextPlayerId].abilities) {
						if (ab.currentCd > 0) ab.currentCd--;
					}
					this.startTurnTimer();
				}
			}

			this.broadcastState();
		} catch (e) {
			console.error("Error parsing message", e);
		}
	}

	startTurnTimer() {
		this.clearTurnTimer();
		this.gameState.turnDeadline = Date.now() + 15000;
		this.turnTimer = setTimeout(() => {
			if (this.gameState.status !== 'IN_PROGRESS') return;
			// Auto-pass turn
			this.gameState.turn = this.gameState.turn === 0 ? 1 : 0;
			const nextPlayerId = this.gameState.turn === 0 ? 'p1' : 'p2';
			for (let ab of this.gameState.players[nextPlayerId].abilities) {
				if (ab.currentCd > 0) ab.currentCd--;
			}
			this.startTurnTimer();
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
			let openRoomId = this.memoryRoomId || await this.state.storage.get('openRoomId');
			if (openRoomId) {
				this.memoryRoomId = null;
				await this.state.storage.delete('openRoomId');
				return new Response(JSON.stringify({ roomId: openRoomId, isNew: false }));
			} else {
				const newRoomId = 'room-' + crypto.randomUUID();
				this.memoryRoomId = newRoomId;
				await this.state.storage.put('openRoomId', newRoomId);
				return new Response(JSON.stringify({ roomId: newRoomId, isNew: true }));
			}
		}

		if (url.pathname === '/relist') {
			let roomId = url.searchParams.get('roomId');
			let openRoomId = this.memoryRoomId || await this.state.storage.get('openRoomId');
			if (!openRoomId) {
				this.memoryRoomId = roomId;
				await this.state.storage.put('openRoomId', roomId);
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
		return new Response("Not found", { status: 404 });
	}
}


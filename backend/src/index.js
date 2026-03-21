export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === '/play') {
			let charId = url.searchParams.get('char') || 'voidWeaver';
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
			return room.fetch(new Request(`http://internal/play?roomId=${roomId}&isNew=${isNew}&char=${charId}&uid=${playerId}`, request));
		}

		if (url.pathname === '/profile') {
			let uid = url.searchParams.get('uid');
			if (!uid) return new Response('Missing UID', { status: 400 });
			let id = env.PLAYER_PROFILE.idFromName(uid);
			let profile = env.PLAYER_PROFILE.get(id);
			return profile.fetch(new Request(`http://internal/get-stats?uid=${uid}`));
		}

		if (url.pathname === '/set-username') {
			if (request.method === 'OPTIONS') {
				return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
			}
			try {
				const body = await request.json();
				const uid = body.uid;
				const newName = (body.username || '').trim();
				if (!uid || !newName) return new Response(JSON.stringify({ ok: false, error: 'Missing fields' }), { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
				if (newName.length < 3 || newName.length > 16) return new Response(JSON.stringify({ ok: false, error: 'Username must be 3-16 characters' }), { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
				if (!/^[a-zA-Z0-9_]+$/.test(newName)) return new Response(JSON.stringify({ ok: false, error: 'Letters, numbers, and underscores only' }), { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });

				// Check uniqueness via global registry
				let regId = env.USERNAME_REGISTRY.idFromName('global');
				let registry = env.USERNAME_REGISTRY.get(regId);
				let regRes = await registry.fetch(new Request(`http://internal/claim?name=${encodeURIComponent(newName)}&uid=${uid}`));
				let regData = await regRes.json();
				if (!regData.ok) return new Response(JSON.stringify(regData), { status: 409, headers: { 'Access-Control-Allow-Origin': '*' } });

				// Save in profile
				let profileId = env.PLAYER_PROFILE.idFromName(uid);
				let profile = env.PLAYER_PROFILE.get(profileId);
				await profile.fetch(new Request(`http://internal/set-name?name=${encodeURIComponent(newName)}`));

				return new Response(JSON.stringify({ ok: true, username: newName }), { headers: { 'Access-Control-Allow-Origin': '*' } });
			} catch(e) {
				return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
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

		return new Response('Lumen Clash API Server', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
	},
};

// Random username generator
const ADJECTIVES = ['Swift','Bold','Dark','Neon','Iron','Void','Frost','Storm','Shadow','Blaze','Cyber','Ember','Lunar','Phantom','Crimson','Crystal','Thunder','Silver','Atomic','Stellar'];
const NOUNS = ['Weaver','Knight','Sage','Hunter','Striker','Falcon','Wolf','Viper','Titan','Reaper','Ghost','Blade','Raven','Phoenix','Dragon','Spark','Saber','Hawk','Fox','Lynx'];
function generateRandomUsername() {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	const num = Math.floor(Math.random() * 999);
	return `${adj}${noun}${num}`;
}

export class PlayerProfile {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);

		// Initialize default schema if missing
		let stats = await this.state.storage.get('stats') || { level: 1, xp: 0, wins: 0, losses: 0, username: null, matchHistory: [] };
		stats.matchHistory = stats.matchHistory || [];

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
			return new Response(JSON.stringify(stats), { headers: { 'Access-Control-Allow-Origin': '*' } });
		}

		if (url.pathname === '/set-name') {
			stats.username = decodeURIComponent(url.searchParams.get('name'));
			await this.state.storage.put('stats', stats);
			return new Response('OK');
		}

		if (url.pathname === '/add-xp') {
			let isWin = url.searchParams.get('win') === 'true';
			let xpGained = isWin ? 50 : 10;
			if (isWin) {
				stats.wins += 1;
				stats.xp += xpGained;
			} else {
				stats.losses += 1;
				stats.xp += xpGained;
			}

			stats.matchHistory.push({
				result: isWin ? 'Win' : 'Loss',
				xpEarned: xpGained,
				timestamp: Date.now()
			});
			if (stats.matchHistory.length > 10) {
				stats.matchHistory = stats.matchHistory.slice(-10);
			}

		// Simple leveling curve: Level up every 100 XP
		let neededXP = stats.level * 100;
		while (stats.xp >= neededXP) {
			stats.xp -= neededXP;
			stats.level += 1;
			neededXP = stats.level * 100;
		}

		stats.lastSeen = Date.now();
		await this.state.storage.put('stats', stats);

			// PUSH TO LEADERBOARD asynchronously (non-blocking)
			if (isWin && stats.username) {
				const uid = url.searchParams.get('uid') || 'unknown';
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
				).catch(e => console.error('Leaderboard update failed', e));
			}

			return new Response('OK', { status: 200 });
		}

		if (url.pathname === '/update-presence') {
			stats.lastSeen = Date.now();
			await this.state.storage.put('stats', stats);
			return new Response('OK');
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

		if (url.pathname === '/get-lobby-data') {
			stats.friends = stats.friends || [];
			stats.friendRequests = stats.friendRequests || [];
			
			const fetchDetails = async (uids) => {
				const results = [];
				for (const fUid of uids) {
					try {
						let fProfile = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(fUid));
						let fRes = await fProfile.fetch(new Request(`http://internal/get-stats`));
						let fData = await fRes.json();
						results.push({
							uid: fUid,
							username: fData.username,
							level: fData.level,
							status: (Date.now() - (fData.lastSeen || 0) < 60000) ? 'Online' : 'Offline'
						});
					} catch(e) {}
				}
				return results;
			};
			
			const [friendsArr, requestsArr] = await Promise.all([
				fetchDetails(stats.friends),
				fetchDetails(stats.friendRequests)
			]);

			return new Response(JSON.stringify({ 
				profile: stats,
				social: {
					friends: friendsArr,
					requests: requestsArr
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

		return new Response('Not found', { status: 404 });
	}
}

export class GameRoom {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.sessions = [];
		this.turnTimer = null;
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

		// Handle initialization and abandoned queue check
		const isPrivate = this.myRoomId && this.myRoomId.includes('private');
		
		if (!this.gameState.status || this.sessions.length === 0) {
			// Initialize state if first player (Host in private, or Seeker in public)
			if (this.sessions.length === 0) {
				// Safety: If matchmaker thought this was an old room but it's empty, and it's NOT private, reject.
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
			class: classData.name,
			classId: charId,
			uid: playerId,
			username: 'Player',
			abilities: classData.abilities.map(a => ({...a})),
			shield: { active: false, percent: 0 },
			dodge: false
		};
		this.sessions.push({ ws: server, id: pId, uid: playerId });

		// Fetch username asynchronously (non-blocking)
		const self = this;
		(async () => {
			try {
				let profileDO = self.env.PLAYER_PROFILE.get(self.env.PLAYER_PROFILE.idFromName(playerId));
				let profileRes = await profileDO.fetch(new Request(`http://internal/get-stats?uid=${playerId}`));
				let profileData = await profileRes.json();
				if (profileData.username && self.gameState.players[pId]) {
					self.gameState.players[pId].username = profileData.username;
					self.broadcastState();
				}
			} catch(e) { console.error('Username fetch error:', e); }
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

				// Apply ability effects
				if (ability.type === 'damage') {
					let dmg = ability.dmg;
					if (opponent.dodge) {
						dmg = 0; // Dodged!
						opponent.dodge = false;
					} else if (opponent.shield.active) {
						dmg = Math.floor(dmg * (1 - opponent.shield.percent / 100));
						opponent.shield = { active: false, percent: 0 };
					}
					opponent.health -= dmg;
				} else if (ability.type === 'drain') {
					let dmg = ability.dmg;
					if (opponent.dodge) {
						dmg = 0;
						opponent.dodge = false;
					} else if (opponent.shield.active) {
						dmg = Math.floor(dmg * (1 - opponent.shield.percent / 100));
						opponent.shield = { active: false, percent: 0 };
					}
					opponent.health -= dmg;
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
					
					const awardXP = async (uid, isWin) => {
						if (!uid) return;
						try {
							let xpDO = this.env.PLAYER_PROFILE.get(this.env.PLAYER_PROFILE.idFromName(uid));
							await xpDO.fetch(new Request(`http://internal/add-xp?win=${isWin}`));
						} catch (e) {
							console.error("Failed assigning XP:", e);
						}
					};

					if (p1.health > 0 && p2.health <= 0) {
						await awardXP(p1.uid, true);
						await awardXP(p2.uid, false);
					} else if (p2.health > 0 && p1.health <= 0) {
						await awardXP(p1.uid, false);
						await awardXP(p2.uid, true);
					}

					this.broadcastState();
				} else {
					// Pass turn and tick the next player's cooldowns
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
			this.sessions.forEach(s => {
				try { s.ws.close(1011, "Opponent disconnected"); } catch(e) {}
			});
			this.sessions = [];
			
			// If it's a private room, we KILL it entirely on disconnect.
			// Private matches shouldn't be "re-listed".
			if (this.myRoomId) {
				let mmId = this.env.MATCHMAKER.idFromName('global-matchmaker');
				let mm = env.MATCHMAKER.get(mmId);
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
			return new Response(JSON.stringify(top50), { headers: { 'Access-Control-Allow-Origin': '*' } });
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

		return new Response('Not found', { status: 404 });
	}
}

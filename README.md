# Lumen Clash ⚔️

A real-time, high-stakes multiplayer battle game built with **Phaser 3** and **Cloudflare Durable Objects**. 

## 🚀 Quick Start (Local Development)

The project requires two servers to run locally: the **Cloudflare Workers Backend** (for game logic) and the **Node.js Frontend Proxy** (to handle assets and WebSocket forwarding).

### 1. Start the Backend
```bash
cd backend
npm install
npm run dev
```
*This starts the backend on `http://localhost:8790` with local persistent storage in `backend/clean-state/`.*

### 2. Start the Frontend Proxy
Open a new terminal in the project root:
```bash
npm install
node frontend/server.js
```
*This starts the game server at `http://localhost:8083`.*

### 3. Play the Game
Open [http://localhost:8083](http://localhost:8083) in your browser. To test multiplayer, open the same URL in an Incognito window or a different browser.

---

## 🎮 Game Features

### ⚔️ Real-Time Battles
- Fluid, WebSocket-based combat using the **GameRoom** Durable Object.
- Turn-based ability system with cooldowns and status effects (Shield, Dodge, Life Drain).
- 3 Unique Character Classes: **Void Weaver** (Assassin), **Aegis Knight** (Tank), **Lumen Sage** (Glass Cannon).

### 🏆 Global Ranking
- Persistent leaderboard powered by the **Leaderboard** Durable Object.
- XP and Leveling system: Earn XP from matches to climb the ranks.
- Match history tracking (Last 10 games).

### 👥 Social & Private Matches
- **Request-Based Friending**: Add players by username and manage pending requests.
- **Online Presence**: See which friends are currently online in the social tab.
- **Private Battles**: Generate 6-digit codes to host matches for specific friends.

---

## 🛠️ Technical Stack

- **Game Engine**: [Phaser 3](https://phaser.io/)
- **Backend Architecture**: [Cloudflare Workers](https://workers.cloudflare.com/) + [Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects/)
- **Infrastructure**: [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- **Local Dev Proxy**: Node.js (Standard `http` and `net` modules)
- **Styling**: Vanilla CSS with modern Glassmorphism aesthetics

## 📂 Project Structure

- `/frontend`: HTML, CSS, and Phaser game logic.
- `/backend`: Cloudflare Worker source code and Durable Object definitions.
- `wrangler.toml`: Infrastructure configuration for Cloudflare.
- `CHANGELOG.md`: Detailed history of all versions and updates.

---

## 📜 License
MIT

# Lumen Clash

## v1.0.0 — Luminary Pass & Customization (2026-03-21)
### Added
- **Luminary Pass**: A global account progression system with 20 ranks of rewards.
- **Character Levels**: Per-character XP/leveling (Max Level 100) with permanent stat bonuses (+10 HP, +2 ATK per level).
- **Customization System**: Equip unlocked Skins and Titles via the new Character Preview menu.
- **New Skin**: "Verdant" variant for Void Weaver unlocked at Rank 3.
- **Dynamic Sprites**: In-game characters now reflect your equipped skin variants.
- **UI Overhaul**: New premium modals for Battle Pass and Character Previews.

### Fixed
- **Global UI Interactions**: Fixed unresponsive "X" close buttons across all menus by improving z-index and pointer-event layering.
- **ID Synchronization**: Aligned character metadata between frontend and backend to ensure consistent stat application.


## v0.9.0 — Social & Private Matches (2026-03-21)
### Added
- **Social System**: Mutual friends list with online status tracking.
- **Private Matches**: Create a room with a 6-digit code to play with specific friends.
- **Presence Tracking**: Automatic "Online" status updates while the game is open.
- **API Proxying**: Unified backend traffic through port 8083 for better mobile connectivity.

## v0.8.0 — Emotes & Sound System (2026-03-21)
### Added
- **Quick Emotes**: Send one of 4 preset emotes during matches — visible as a floating speech bubble over your character for both players.
- **Emote Presets**: Choose your 4 quick-use emotes from a pool of 16 via Settings → Emote Presets. Selection is persisted in localStorage.
- **3-second emote cooldown** prevents spam while keeping communication fluid.
- **Procedural Sound System**: Retro synthesized sound effects via `AudioContext` — no audio files required.
  - UI click blip on all menu buttons
  - Descending frequency "pew" on ability use
  - Noise burst + bass thud on taking damage
  - Ascending arpeggio on heals
  - Metallic sweep on shields/dodge
  - Dual-tone chirp on emote send/receive
  - Victory fanfare or defeat dirge on game over
- **Sound Toggle**: Enable/disable all sound effects from Settings → Sound: ON/OFF.

### Changed
- Settings buttons for Sound and Emote Presets are now fully functional (previously "Coming Soon").

## v0.7.0 — Settings & UI Polish (2026-03-21)
### Added
- **Profile Modal** with an all-new Match History tracking your last 10 games.
- **Settings Modal** featuring a "Delete Save Data" button and an in-game Changelog viewer.
- **Custom Disconnect Modal** replacing jarring browser alerts when opponents leave.
- **Upgraded Typography**: Replaced system fonts with high-quality Google Fonts (`Outfit` for readable text, `Rajdhani` for sci-fi headers).
- **Glassmorphism UI**: Added a sleek background blur (`backdrop-filter`) and energetic pop-in animations to all menus.
- **Improved Navigation**: Menus can now be closed by clicking the dark background, and "Close/Confirm" buttons were standardized to "Back ↩".

## v0.6.0 — Global Leaderboard (2026-03-21)
### Added
- **Global Top 50 Leaderboard** accessible from the main menu.
- **Leaderboard Server Infrastructure**: New `Leaderboard` Durable Object securely ranks players by wins, using Level and XP as tie-breakers.

## v0.5.0 — Abilities & Combat Overhaul (2026-03-21)
### Added
- **4 unique abilities per class** with cooldown timers
  - Void Weaver: Shadow Strike, Void Burst, Shadow Step (dodge), Drain (damage + heal)
  - Aegis Knight: Shield Bash, Fortify (50% shield), Holy Smite, Iron Wall (100% shield)
  - Lumen Sage: Arcane Bolt, Radiant Burst, Heal Light, Supernova
- **Shield mechanic** — blocks a percentage of the next incoming hit, then breaks
- **Dodge mechanic** — completely avoids the next attack
- **15-second turn timer** with visual countdown bar; auto-passes turn on expiry
- **4-slot ability bar** replaces old Attack/Special buttons
- Cooldown counters displayed on each ability button
- Shield/Dodge status badges shown under health bars

## v0.4.0 — Username System (2026-03-21)
### Added
- **Random username generation** on first visit (e.g. `SwiftFalcon42`, `VoidReaper817`)
- **Editable usernames** via profile card with inline editor
- **Username uniqueness** enforced by global `UsernameRegistry` Durable Object
- Usernames shown in combat HUD instead of generic "You" / "Opponent"
- `/set-username` API route with validation (3-16 chars, alphanumeric + underscores)

## v0.3.0 — Mobile Responsive Layout (2026-03-21)
### Added
- **"Rotate Device" overlay** for portrait mode on mobile
- Mobile landscape CSS media queries at two breakpoints (500px, 400px)
- Dynamic sprite scaling based on screen height
- Viewport meta prevents pinch-to-zoom

### Changed
- Sprites repositioned from 60% to 50% screen height
- Player Profile card restyled from absolute-positioned to inline layout
- Combat HUD padding reduced for mobile fit

## v0.2.0 — Player Profiles & Progression (2026-03-21)
### Added
- **Persistent player profiles** using `localStorage` UUID + `PlayerProfile` Durable Object
- XP and leveling system (100 XP per level, 50 XP for wins, 10 XP for losses)
- Player Profile card on main menu showing level, XP bar, and win/loss record
- XP awarded automatically on match completion

### Fixed
- `crypto.randomUUID()` crash on non-secure HTTP origins (LAN IPs)
- Node.js proxy incorrectly serving binary assets (PNGs) as UTF-8
- Undeclared `prevTurn` variable crash in return-to-menu handler

## v0.1.0 — Initial Release (2026-03-20)
### Added
- 3 character classes: Void Weaver, Aegis Knight, Lumen Sage
- Real-time 1v1 multiplayer via WebSocket + Cloudflare Durable Objects
- Matchmaking system with automatic room assignment
- Phaser.js game canvas with custom character sprites
- Character selection roster
- Health bar HUD with hit animations
- Main menu with character preview

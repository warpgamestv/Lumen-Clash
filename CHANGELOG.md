y# Lumen Clash

## v1.3.0 — Menu readability & social polish (2026-03-22)
### Added
- **Friend challenges**: **Challenge** on a friend creates a private match and sends a **duel invite** they can accept or decline under Social; challenger waits in the matchmaking overlay.
- **Friend presence**: Friends can show richer status (**In menu**, **In match**, **Private lobby**, **Away**, **Offline**) using a lightweight presence heartbeat to the server.
- **Last chosen character**: The roster class you last picked (or saved customization for) is stored in `localStorage` and drives the **main menu hero** and default queue class after reload.
- **Best of 3 (post-match)**: XP splash adds **Best of 3** beside **Challenge Again**; when both players pick it, subsequent games count toward **first to 2** with a live series line on the splash. Between rounds, only **Next round** is shown until the set is decided.
- **Rematch feedback**: Opponent choice is surfaced (**One more game**, **Best of 3**, **Next round**); if choices conflict, a short message asks you to match.
- **Duel invite toast**: Pending duel invites show a main-menu **banner** with **Open Social** so invites are harder to miss.
- **Main menu header (top right)**: **Pilot** strip shows **username** and **account rank**; **Activity** (bell) opens a small inbox for **friend requests** and **duel invites** (with a footnote that quests, seasonal rewards, and events can land here later).

### Changed
- **Main menu left rail**: Larger typography for **nav labels**, **hints**, the **Luminary Pass** row, and rank badge so sidebar actions are easier to read (including stacked mobile layouts).
- **Accessibility “Larger UI text”**: Sidebar sizes scale up a bit further when that setting is enabled.

### Fixed
- **Local dev API proxy**: Node static server now matches API paths reliably (normalized URL path, proxy-before-files) so POST routes like **`/friend-duel-invite`** reach wrangler instead of returning a filesystem 404; clearer JSON errors when the backend is unreachable.
- **Private room cleanup**: `GameRoom` WebSocket teardown now uses **`this.env`** for the matchmaker client (was a stray `env` reference).
- **XP / rank display**: Account **rank** is derived from class levels, but the UI was pairing it with **lifetime `stats.xp`** and a `rank × 100` curve (wrong). Profile and splash bars now use **sum of class XP / sum of (level×100)** (“roster XP”). Roster class cards use **xp / (level×100)** for their fill. **`/profile`** recomputes rank from stored class levels to fix drift. Default **`add-xp`** class id is **`aegisKnight`** (not `knight`) so XP isn’t stored under a dead key.

## v1.2.0 — Responsive Polish & Character Rendering (2026-03-22)
### Added
- **Settings → Performance overlay**: Optional FPS readout plus approximate **HTTP ping** to `/profile` (round-trip latency), persisted in `localStorage`.
- **Settings → Accessibility**: **Larger UI text**, **high contrast** shell for menus/HUD, **high-visibility HP bar** colors (blue vs amber), and **reduce motion** (cuts CSS animations/transitions).
- **Settings → Combat feedback tuning**: Added user-selectable **Camera shake** and **Hit-stop** intensity levels (`Off`, `Medium`, `High`) that apply during damage reactions.
- **Post-match breakdown**: XP splash now includes match stats (**damage dealt**, **damage taken**, **abilities used**, **turn swaps**) for quick self-review.
- **Settings tabs**: Options are now organized into **Gameplay**, **Accessibility**, and **System** sections for faster navigation.
- **Menu VFX toggle**: Added a gameplay setting to disable animated menu effects for cleaner visuals and lower distraction on mobile.
- **Pretty changelog viewer**: In-game changelog now renders with readable formatting (headings, sections, bullets, emphasis) instead of plain raw text.

### Changed
- **Main menu responsiveness**: Improved behavior across different aspect ratios, including mobile-friendly layout adjustments and better stacking/spacing for narrow viewports.
- **Mobile visual pass (global)**: Refined phone/tablet layout for menu, combat HUD, roster, modals, and splash screens; improved touch target sizing, spacing, and portrait readability.
- **Mobile compact pass**: Reduced button footprint and reorganized portrait HUD flow to minimize overlap (health cards, status/timer, abilities, and emotes now fit with less collision on small screens).
- **UI polish**: Added custom themed scrollbars across scrollable panels and lists.
- **Selected hero presentation**: Active chosen character now appears behind the main menu UI layer for stronger visual identity while preserving menu readability.
- **Void Weaver skin parity**: Fixed **Verdant Void Weaver** scale inconsistencies so it matches standard Void Weaver sizing in menu and battle scenes.
- **Connection resilience**: Added temporary disconnect recovery with automatic reconnect attempts (up to 3) before falling back to manual return.

### Fixed
- **Sprite background artifacts**: Removed visible dark/black matte backgrounds from character sprites when rendered in Phaser and preview contexts.

## v1.1.0 — Main Menu & Presentation (2026-03-22)
### Added
- **Animated menu backdrop**: Linked `background.css` and added the `#menu-background-layer` markup (nebula, particles, scanlines, vignette) so the main menu shows the intended background.
- **Header tagline** under the game title on the main menu.

### Changed
- **Main menu layout**: Professional shell with a **left navigation rail** (Luminary Pass, Team, Rankings, Profile, Social, Settings) and a **primary Play** action anchored **bottom-right** in the main area.
- **Combatant panel**: Right-aligned **glass-style card** (“Active combatant”) with refined typography; Play button uses a dedicated **primary CTA** style (title + “Find a match” subtitle).
- **Responsive behavior**: Main menu **stacks** on narrow or short viewports (`max-width: 720px` or `max-height: 500px`) using rules scoped to the menu so **combat HUD** compact styles still apply only when the viewport is **short**, not merely narrow.
- **Post-match overlay**: `#xp-splash-overlay` moved to the **top of `<body>`** for more reliable stacking and input behavior; splash flow also hides **`#ui-container`** so the HUD does not sit above the results screen.
- **Splash actions**: Rematch and Main Menu on the splash use dedicated handlers with guarded listeners; **Social** included in the global menu **click** sound list.

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

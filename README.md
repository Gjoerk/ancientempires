# Kingsfall

An original medieval real-time strategy game for the browser, played with friends.
First game mode: protect your king — you lose when your king dies.

## How multiplayer works

There is no game server. The player who hosts runs the game in their browser and
the others connect to it directly over WebRTC with a room code. Only the first
handshake goes through the public PeerJS broker. The site itself is static, so
it runs on GitHub Pages.

## Layout

- `packages/shared` — the simulation (map, pathfinding, units, commands), the room host logic and the message types.
- `packages/client` — isometric canvas client (Vite) and the WebRTC networking.

## Run locally

    npm install
    npm run dev

Open the printed URL in two tabs: host in one, join with the room code in the other.

- `npm test` — simulation tests
- `npm run typecheck`
- `npm run build` — static site in `packages/client/dist`

The game is published by copying `packages/client/dist` into the `ancientempires/` folder of the `Gjoerk/gjoerk.github.io` site repository.

## Custom sprites

All art is drawn by code, but any unit, building or resource can be replaced with an image by listing it in
`packages/client/public/sprites/manifest.json`. See `packages/client/public/sprites/README.md`.

## Status

Done:
- Waiting room with teams, computer opponents, a quick-start option and a test opponent the host plays themselves.
- Seeded map in three sizes (64, 80 or 112 tiles across) with wood, berries, gold and stone near every start; fog of war shared between allies.
- Economy with four resources (food, wood, gold, stone): gathering, farms that need re-sowing, mill, lumber camp and mining camp as drop-off points, houses, population limit, market.
- Three ages; economy upgrades at the town centre and storehouse; army-wide and per-unit upgrades at the blacksmith.
- Buildings placed and built by villagers, repair, rally points, walls dragged out as lines, gates for the owner's team.
- Combat: spearman, swordsman, archer, rider, battering ram, watchtower and castle, with counters; attack-move, stop, control groups.
- Protect the king: he can shelter in the castle; a player whose king dies is out and the last team with a king wins.
- Chat, resign, a game clock and villager counts per resource.
- Carved-oak interface with icon buttons, zoom, and touch controls for phones.
- Synthesised sound effects; any sprite can be replaced through the sprite pack.

Deliberately left out to keep the game quick to learn: ships, monks, trade carts, hunting, civilizations,
diplomacy, formations and unit collision.

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
- Waiting room; the host starts and ends games and can add a test opponent they play themselves.
- Seeded 64×64 map with wood, berries, gold and stone near every start; fog of war with explored and unexplored areas.
- Economy: gathering and delivering, farms, storehouses, houses, population limit, market trading.
- Three ages and ten technologies (town centre, storehouse, blacksmith) that unlock and improve units and buildings.
- Buildings placed and built by villagers, repair, rally points, stone walls dragged out as lines.
- Combat: spearman, swordsman, archer, rider, battering ram, watchtower and castle, with counters; attack-move, stop, control groups.
- Protect the king: he can shelter in the castle; a player whose king dies is out and the last king standing wins.
- Any sprite can be replaced through the sprite pack.

Not yet: gates, a computer opponent, healing and conversion, ships and water, trade routes, teams and diplomacy,
unit formations and real collision, sound, game settings (map size, starting resources).

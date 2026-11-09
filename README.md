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

## Status

Done:
- Rooms for up to 4 players, seeded 64×64 map with wood, berries, gold and stone near every start.
- Economy: villagers gather and deliver resources, farms, storehouses, houses and a population limit.
- Buildings are placed and constructed by villagers; town centre, barracks, archery range and stable train units.
- Combat: swordsman, spearman, archer, rider and watchtower, with counters (spear beats rider, rider beats archer, archer and sword beat spear).
- Protect the king: a player whose king dies is out; the last king standing wins.

Not yet: fog of war, unit collision, walls and gates, garrisoning, ages and technologies, a pre-game lobby, sound.

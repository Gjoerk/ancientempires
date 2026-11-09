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

Pushing to `main` deploys to GitHub Pages (set Pages source to "GitHub Actions" in the repo settings).

## Status

Done: rooms for up to 4 players, seeded map, king and villagers, selection, group movement with pathfinding, minimap.

Next: resources and gathering, buildings, training, combat, king defeat condition.

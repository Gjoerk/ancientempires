# Kingsfall

An original medieval real-time strategy game for the browser, played with friends.
First game mode: protect your king — you lose when your king dies.

## Layout

- `packages/shared` — the simulation (map, pathfinding, units, commands) and the network protocol. Used by both sides.
- `packages/server` — Node WebSocket server. Runs the simulation at 10 ticks/s per room and sends snapshots.
- `packages/client` — isometric canvas client (Vite).

## Run locally

    npm install
    npm run dev

Open the printed Vite URL in two tabs and join the same room code.

- `npm test` — simulation tests
- `npm run typecheck`
- `npm run build` — static client in `packages/client/dist`; set `VITE_SERVER_URL` (e.g. `wss://example.com`) to point it at the deployed server
- `npm start` — server on `$PORT` (default 8080)

## Status

Done: rooms for up to 4 players, seeded map, king and villagers, selection, group movement with pathfinding, minimap.

Next: resources and gathering, buildings, training, combat, king defeat condition.

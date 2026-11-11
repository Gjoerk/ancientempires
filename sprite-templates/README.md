# Unit sprite templates

Each unit's built-in sprite, exported at the size the game draws it, so you can paint over it.
For every unit there is:

- `<kind>.png`: the sprite itself, facing **right** (the game mirrors it for left).
- `<kind>_mask.png`: the pixels that take the **team colour**. Paint these in grey (lighter for
  highlights, darker for shade); the game tints them blue, red, green or yellow per player.

| Unit | Key | Size (px) | Feet / anchor |
| --- | --- | --- | --- |
| Villager | `unit.villager` | 24 × 26 | [12, 26] |
| King | `unit.king` | 24 × 26 | [12, 26] |
| Swordsman | `unit.swordsman` | 24 × 26 | [12, 26] |
| Spearman | `unit.spearman` | 24 × 30 | [12, 30] |
| Archer | `unit.archer` | 24 × 26 | [12, 26] |
| Monk | `unit.monk` | 24 × 26 | [12, 26] |
| Scout | `unit.scout` | 32 × 28 | [16, 28] |
| Rider (knight) | `unit.rider` | 36 × 30 | [18, 30] |
| Battering ram | `unit.ram` | 36 × 22 | [18, 22] |

## Format

- PNG with a transparent background.
- Any size works. To draw in more detail, make it 2× or 4× bigger and set `"scale": 0.5` or `0.25`;
  the anchor is then given in your image's own pixels.
- The anchor is the point between the feet that stands on the ground.
- Animations: put the frames side by side in one image, same size each, and set `"frames"` and `"fps"`.
  Optional separate images per activity: `unit.<kind>.idle`, `.walk`, `.attack`, `.work`;
  villagers also `.work.wood`, `.work.berries`, `.work.gold`, `.work.stone`, `.work.farm`, `.work.build`.
  Anything missing falls back to `unit.<kind>`.

## Using them

Copy the finished files into `packages/client/public/sprites/` and list them in its `manifest.json`;
`manifest.example.json` here lists all nine with the right anchors. Full options are in
`packages/client/public/sprites/README.md`.

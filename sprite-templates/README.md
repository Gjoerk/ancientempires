# Unit sprite templates

Each unit's and resource's built-in sprite, exported at the size the game draws it, so you can paint over it.
For every unit there is:

- `<kind>.png`: the sprite itself, facing **right** (the game mirrors it for left).
- `<kind>_mask.png`: the pixels that take the **team colour**. Paint these in grey (lighter for
  highlights, darker for shade); the game tints them blue, red, green or yellow per player.

| Unit | Key | Size (px) | Feet / anchor |
| --- | --- | --- | --- |
| Villager | `unit.villager` | 16 × 28 | [8, 28] |
| King | `unit.king` | 20 × 33 | [10, 33] |
| Swordsman | `unit.swordsman` | 14 × 28 | [7, 28] |
| Spearman | `unit.spearman` | 22 × 38 | [11, 38] |
| Archer | `unit.archer` | 22 × 28 | [11, 28] |
| Monk | `unit.monk` | 16 × 32 | [8, 32] |
| Scout | `unit.scout` | 30 × 34 | [15, 34] |
| Rider (knight) | `unit.rider` | 38 × 33 | [19, 33] |
| Battering ram | `unit.ram` | 40 × 21 | [20, 21] |

Resources come as three looks each (`tree_0.png` … `stone_2.png`, keys `resource.<name>.0` to `.2`).
Their anchor is the centre of the tile, a few pixels above the base of the image.

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
`manifest.example.json` here lists them all with the right anchors. Full options are in
`packages/client/public/sprites/README.md`.

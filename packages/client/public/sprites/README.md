# Sprite pack

Every unit, building and resource in the game has a built-in drawing. To replace one
with your own art, put the image in this folder and list it in `manifest.json`.
Anything not listed keeps its built-in drawing, so you can swap sprites one at a time.
No code changes are needed; rebuild (or in development just reload the page).

## Example

```json
{
  "unit.villager": { "src": "villager.png", "anchor": [16, 30], "teamMask": "villager_mask.png" },
  "unit.villager.walk": { "src": "villager_walk.png", "frames": 6, "fps": 10, "anchor": [16, 30] },
  "building.house": { "src": "house.png", "anchor": [64, 70] },
  "building.castle": { "src": "castle.png", "anchor": [128, 150], "flag": [128, 20] },
  "resource.tree": { "src": "tree.png", "anchor": [20, 52] }
}
```

## Options per sprite

| Option | Meaning | Default |
| --- | --- | --- |
| `src` | Image file in this folder (PNG with transparency recommended). | required |
| `anchor` | `[x, y]` pixel inside one frame that is placed on the ground point (see below). | bottom centre |
| `scale` | Size multiplier, e.g. `0.5` for art drawn at double resolution. | `1` |
| `frames` | Number of animation frames, laid out left to right in one image. | `1` |
| `fps` | Animation speed. | `8` |
| `teamMask` | Greyscale image of the same size. Its opaque pixels are recoloured to the owner's colour and drawn over the sprite, keeping the shading. | none |
| `shadow` | Keep the built-in oval ground shadow (units and resources only). Set `false` if your art has its own. | `true` |
| `smooth` | Smooth the image when scaled instead of keeping hard pixels. | `false` |
| `flag` | Castles only: `[x, y]` pixel where the royal flag pole stands while a king is inside. | no flag |

## Ground point and sizes

The map is isometric. One tile is a diamond 64 px wide and 32 px high.

- **Units:** the anchor is the point between the feet. Built-in units are about 20 × 26 px.
- **Resources:** the anchor is the centre of the tile.
- **Buildings:** the anchor is the centre of the footprint on the ground. A building
  covering N × N tiles has a ground diamond N × 64 px wide and N × 32 px high.
  Custom building sprites get no automatic shadow, so paint it into the image.

Footprints: house, farm, mill, lumber camp, mining camp, blacksmith 2 × 2 · town centre, barracks, archery range, stable,
market, siege workshop, monastery 3 × 3 · watchtower, wall, gate 1 × 1 · castle 4 × 4.

## Keys

The most specific key that exists is used.

**Units** — `unit.<kind>` with kind one of `villager`, `king`, `swordsman`, `spearman`, `archer`, `rider`, `scout`, `monk`, `ram`.
Optional per activity: `unit.<kind>.idle`, `.walk`, `.attack`, `.work`, and for villagers
`.work.wood`, `.work.berries`, `.work.gold`, `.work.stone`, `.work.farm`, `.work.build`.
All unit sprites should face right; they are mirrored when the unit faces left.
If a villager has no `.work` sprite, the built-in tool animation is drawn over the sprite.

**Buildings** — `building.<kind>` with kind one of `towncenter`, `house`, `mill`, `lumbercamp`, `miningcamp`, `farm`,
`barracks`, `range`, `stable`, `tower`, `castle`, `blacksmith`, `market`, `workshop`, `wall`, `gate`, `monastery`.
Optional: `building.<kind>.site` (under construction), `building.site` (any building under
construction), `building.castle.king` (castle with a king inside; replaces the `flag` option).
Town centres and castles fly a flag while someone shelters inside; with a custom sprite set `flag` for where its pole stands.
Without a site sprite the finished sprite fades in as construction progresses.

**Resources** — `resource.tree`, `resource.berries`, `resource.gold`, `resource.stone`.
Optional variants `resource.tree.0`, `.1`, `.2` are picked per tile for variety.

Terrain tiles, the minimap, health bars and the interface are not part of the sprite pack yet.

## Icons

The pictures on buttons, in the top bar and next to costs are icons. Each has a built-in drawing and
can be replaced the same way, with the key `icon.<id>`. Icons are shown square; 48 × 48 px or a multiple works best.

- **Resources:** `icon.food`, `icon.wood`, `icon.gold`, `icon.stone`
- **Units and buildings:** `icon.<kind>`, for example `icon.villager`, `icon.barracks` (used on build and train buttons and as the portrait)
- **Upgrades:** `icon.<id>` with id one of `age2`, `age3`, `loom`, `handcart`, `ploughs`, `axes`, `picks`, `weapons`, `armour`,
  `pikes`, `jacks`, `blades`, `shields`, `longbows`, `quickdraw`, `lances`, `barding`, `ironhead`, `arrowslits`
- **Actions:** `icon.cancel`, `icon.eject`, `icon.stance.aggressive`, `icon.stance.defensive`, `icon.sell.food`, `icon.sell.wood`, `icon.sell.stone`, `icon.buy.food`, `icon.buy.wood`, `icon.buy.stone`

Example: `"icon.gold": { "src": "icons/gold.png" }`

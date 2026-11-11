# Sounds and music

## Background music

`music.mp3` and `music2.mp3` play in the background on the menus and in games, one after the
other, starting with a random one. Replace the files to change the songs (MP3 or OGG at
128–192 kbps keeps them light). Players set its volume with the slider at the
top right (50 % by default) and switch it off with the note button; both are remembered.

## Sound effects

Every effect has a built-in sound made by the game itself. To use your own, put the file in this
folder and list it in `manifest.json`; anything not listed keeps its built-in sound.

```json
{
  "hit": "sword-hit.ogg",
  "built": "building-done.mp3"
}
```

| Name | When it plays | Built-in sound | Suggested length |
| --- | --- | --- | --- |
| `order` | You give an order: move, gather, build, attack, place a building | short click | 0.05–0.15 s |
| `hit` | A melee blow lands on something you can see | thud | 0.1–0.2 s |
| `arrow` | An arrow is shot where you can see it | falling whistle | 0.1–0.3 s |
| `death` | A unit dies | low falling groan | 0.2–0.5 s |
| `collapse` | A building is destroyed | rumble | 0.5–1 s |
| `built` | One of your buildings is finished | two rising notes | 0.3–0.6 s |
| `trained` | One of your units comes out of a building | single chime | 0.1–0.3 s |
| `research` | You finish an upgrade | three rising notes | 0.3–0.6 s |
| `age` | You advance to a new age | rising fanfare | 0.6–1.5 s |
| `alarm` | Something of yours is attacked off screen | three warning beeps | 0.5–1 s |
| `chat` | A chat message arrives | soft two-note ping | 0.1–0.3 s |
| `victory` | Your team wins | victory fanfare | 1–3 s |
| `defeat` | You are defeated | falling notes | 1–3 s |

## Several takes

List several files for one name and one is picked at random each time, so a sound heard often
does not repeat: `"built.mill": ["mill-a.ogg", "mill-b.ogg"]`. One file can serve several names.

## Detailed sounds (optional)

Any sound can be made more specific by adding details after a dot. The most detailed file that
exists is played, otherwise the general one, otherwise the built-in sound, so you only make the
ones you want. `select` sounds are new: they stay silent unless you give a file.

| Name | When it plays |
| --- | --- |
| `select`, `select.<kind>` | You click one of your own units or buildings, e.g. `select.house`, `select.villager`, `select.king`. A building without its own select sound plays its `built.<kind>` sound (or `built`) |
| `order.move` | Units sent somewhere |
| `order.attack` | Attack order or attack-move |
| `order.gather.wood` / `.berries` / `.gold` / `.stone` | Villagers sent to gather |
| `order.build` | Villagers sent to help build or repair |
| `order.farm` | Villager sent to a farm |
| `order.enter` | Units sent into one of your buildings |
| `order.place.<kind>` | You place a building, e.g. `order.place.house` |
| `order.copy` | T: copy the last villager's job |
| `built.<kind>` | That building is finished, e.g. `built.farm`, `built.castle` |
| `trained.<kind>` | That unit comes out, e.g. `trained.archer`, `trained.monk` |
| `death.<kind>` | That unit dies, e.g. `death.villager`, `death.rider` |
| `collapse.<kind>` | That building is destroyed, e.g. `collapse.house`, `collapse.wall` |
| `research.<id>` | That upgrade finishes, e.g. `research.loom`, `research.blades` |
| `age.2`, `age.3` | Town Age, Kingdom Age reached |

Kinds: villager, king, swordsman, spearman, archer, rider, scout, monk, ram, towncenter, house,
mill, lumbercamp, miningcamp, farm, barracks, range, stable, tower, castle, blacksmith, market,
workshop, wall, gate, monastery. Upgrade ids: loom, handcart, ploughs, axes, picks, weapons,
armour, pikes, jacks, blades, shields, longbows, quickdraw, lances, barding, ironhead, arrowslits.

Tips: keep files short and trim silence at the start. Every file is measured when it loads and
turned up or down so that all sounds play about equally loud; players set the overall level with
the sound slider (70 % by default). Very frequent sounds (`hit`, `arrow`, `order`) are limited to a
few per second, so big battles do not turn into noise. OGG, MP3 and WAV all work.

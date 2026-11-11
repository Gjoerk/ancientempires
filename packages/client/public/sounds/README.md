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

Tips: keep files short and normalised to about −3 dB peak; the game plays them at 60 % volume.
Very frequent sounds (`hit`, `arrow`, `order`) are limited to a few per second, so big battles
do not turn into noise. OGG, MP3 and WAV all work.

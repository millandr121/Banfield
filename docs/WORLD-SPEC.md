# Banfield World Spec — the block grid, art sizes, and the plan

This is the single source of truth for how art, tiles, and entities fit
together. If a number here disagrees with code, the code is wrong.

---

## 1. The core idea (and what it is NOT)

Banfield is a **top-down tile world**, like Stardew Valley / Eastward /
old Zelda — not like Minecraft. The difference matters:

- **Minecraft**: everything (trees, houses) is literally built out of
  uniform blocks. A tree IS six wood blocks and a blob of leaf blocks.
- **Top-down tile games (us)**: the world has two layers.
  1. **Terrain layer** — a grid of tiles (grass, dirt, sand, water,
     pavement…). Each tile type is one repeatable square sprite.
  2. **Object layer** — multi-tile sprites (a tree, a house, a dock
     post) that sit ON the grid, anchored to one base tile, and can
     overhang neighbouring tiles. A tree is ONE sprite that occupies a
     2×3-tile footprint, not 6 separate blocks.

This is the professional pattern for this genre. Characters/creatures
are a third kind of thing: free-moving sprites that aren't snapped to
the grid at all (they already work this way).

So: "everything is editable blocks" translates to —
- every **terrain type** = one paintable tile sprite (cut grass, long
  grass, weeds, dirt, pavement, …)
- every **object** = one paintable multi-tile sprite (tree, boulder,
  campfire, house, dock…)
- every **character/creature/clothing item** = a paintable animated
  sprite on the shared character grid.

All of them open in the same editor, same tools, same save pipeline.

---

## 2. The master grid: pixel sizes (USE THESE IN PIXELLAB)

**One world tile = 32 × 32 art pixels.** Everything is authored in
multiples of that. (Pros use 16 or 32 px/tile; 16 is too coarse for
the detail level you've been generating, 96 is overkill — file sizes
and hand-editing pain explode and you can't see the pixels anymore.)

| Thing                  | Tiles (w×h) | PixelLab canvas | Notes |
|------------------------|-------------|-----------------|-------|
| Terrain tile           | 1×1         | **32×32**       | Must tile seamlessly left/right/up/down |
| Character (human)      | 1×2         | **64×64**       | Body ~40–56 px tall inside the canvas, feet at bottom-centre |
| Small creature (crab)  | 1×1         | 32×32           | |
| Medium creature (deer) | 2×1         | 64×32 (or 64×64)| |
| Large creature (orca)  | 4×2         | 128×64          | |
| Bush / rock / campfire | 1×1 or 2×2  | 32×32 / 64×64   | |
| Tree                   | 2×3         | **64×96**       | Trunk base anchored to bottom-centre tile; canopy overhangs |
| Big tree (old growth)  | 3×4         | 96×128          | |
| Small house            | 4×3         | 128×96          | Door on the bottom edge |
| Large house / shop     | 5×4         | 160×128         | |
| Dock segment           | 1×1         | 32×32           | Tileable like terrain |
| Boat (small)           | 2×1         | 64×32           | |
| Item icon (inventory)  | —           | 16×16           | UI only, not in the world (already works) |

Rules that keep everything consistent:

1. **Same pixel density everywhere.** A pixel on a tree is the same
   size as a pixel on a character. Mixing densities (a 92px-tall
   character next to 24px tiles) is the #1 amateur tell — the art
   looks "off" and nobody can say why. This is the single most
   important rule.
2. **Feet/base at bottom-centre.** Every character, creature, and
   object sprite anchors at the bottom-centre of its canvas. The game
   places that anchor on the world position.
3. **Objects can overhang, terrain cannot.** Terrain tiles never draw
   outside their 32×32. Objects (tree canopy) may.
4. **Characters are exactly 1×2 tiles.** No exceptions for humans —
   see the clothing section for why.

### Can PixelLab "break a tree into sections"?

No — and it doesn't need to. PixelLab generates one image. We import
the whole 64×96 tree as ONE object sprite. The game anchors it to a
tile and draws it with proper depth-sorting (things behind it draw
first). You only slice things into tiles when they're terrain
(walkable ground) — and those you design as single repeating 32×32
tiles in the first place.

---

## 3. Clothing & armour: will the overlay actually work?

**Yes — on one condition: every human shares the same rig.**

The rig is: same 64×64 canvas, same anchor, same body proportions
(within a pixel or two), same animation frame counts and timing. Then
a shirt is just a 64×64 sprite where only the fabric pixels are
painted and everything else is transparent. At render time:

```
draw body frame  →  draw pants layer  →  draw shirt layer  →  draw hat layer
```

Pixel-for-pixel on top. Because the bodies match, the shirt fits
everyone. This is exactly how Stardew Valley, Terraria and every
paper-doll RPG does it. Our SpriteDoc layer system was built for this
— the editor even onion-skins the body under you while you paint
clothing.

**Where does uniqueness come from, if all bodies are identical?**
- skin tone, hair style/colour, face — painted on the body's own
  layers, unique per character
- dye system — a shirt is painted once with shading, then re-tinted
  to any colour at runtime (this already works, `tintPixel` in
  shared/sprite.ts)
- the clothing combinations themselves

**What if you want fat/thin/tall body types?** Then every clothing
item needs one variant per body type. Pros cap this at 2–3 body types
max, or skip it. Recommendation: ship with ONE body rig, add a second
later only if it really matters.

**PixelLab workflow for clothing:** generate the character WEARING the
outfit on the same base body, import it, then in the editor erase the
body pixels so only the garment remains on the clothing layer. (Or
paint garments directly in the editor over the onion-skin reference —
for simple shirts that's honestly faster.)

---

## 4. Audit: current inconsistencies (found 2026-06-13)

### A. Broken / dead-end pipelines
1. **`clothing-sprites.json` is never loaded by the game.** Editor
   paints & saves it; game.ts never imports it. Worn items only ever
   change the procedural character's colours.
2. **`object-sprites.json` is never loaded by the game.** Same story.
   The editor's object list (tree_oak, campfire, …) corresponds to
   nothing — trees/campfires in-game are drawn by code.

### B. No shared pixel density ("mixels")
3. Characters 20×26, creatures 32×24, objects 32×32, items 16×16,
   PixelLab imports 92×92 — all scaled by different non-integer
   factors at render time. Result: visibly mismatched pixel sizes.

### C. Procedural/painted duality
4. **Terrain is code, not art**: `drawGrassTexture` etc. live in
   game.ts AND are duplicated in editor/main.ts (two copies that can
   drift). Terrain editing = colour pickers only.
5. **Trees, rocks, bushes, buildings are 100 % procedural** — not
   editable at all.
6. **`anim-settings.json` (the in-game "TUNING")** only affects the
   procedural character. Painted sprites ignore it.
7. **`drawSpriteDoc` ignores the clip's fps** (hardcodes 150 ms/frame),
   ignores idle-clip frame advance when standing, ignores dye tints,
   and drops gameplay visuals the procedural char has (water
   submersion, weapon in hand, attack/jump poses).

### D. Performance & storage time-bombs
8. **Per-pixel `fillRect` every frame.** Each painted entity redraws
   w×h rects per frame. Fine for 5 sprites; will crawl with a town of
   NPCs + painted terrain. Fix: pre-render each (doc, clip, facing,
   frame) to an offscreen canvas once, then `drawImage`.
9. **JSON pixel arrays will outgrow localStorage.** Pixels are stored
   as `"#rrggbb"` strings (~10 bytes each). One 64×64 character with
   5 layers × 8 facings × 4 frames ≈ 6.5 MB. localStorage caps at
   5–10 MB total. Fix: palette-indexed + run-length encoding (each doc
   stores a colour palette and compact index runs). 10–30× smaller.

### E. Missing features you asked for
10. No version slots (save a block, change your mind, roll back).
11. No way to give player characters roles/stats (cosmetic only today).

---

## 5. The plan (ordered, each phase playable)

**Phase 0 — adopt this spec.** New art follows §2 sizes. Existing
20×26 art keeps working (it's scaled), gets redrawn at 64×64
opportunistically.

**Phase 1 — close the dead ends.**
- Game loads `clothing-sprites.json`; worn items composite their
  painted layers over the painted body (dye-tinted).
- Game loads `object-sprites.json`; campfire/furnace/trees check for a
  painted doc first, procedural fallback second (same pattern
  creatures already use).

**Phase 2 — paintable terrain tiles.**
- Each terrain type becomes a 32×32 SpriteDoc (1 frame, or 2–4 frames
  for animated water). Editor: same pixel canvas as everything else.
- Game: pre-render each tile doc to an offscreen canvas, blit with
  `drawImage` per tile. Procedural texture code becomes the fallback
  for unpainted types, and the editor's duplicate copy is deleted.
- Add the new tile types you want (cut grass, long grass, weeds, dirt,
  pavement) as variants paintable in the editor and placeable with the
  paint wand.

**Phase 3 — object world-hookup.**
- Map every in-game resource/structure kind (tree varieties, berry
  bushes, boulders, buildings, dock pieces) to an object-doc key.
- Multi-tile footprints + bottom-centre anchor + depth sort (depth
  sorting already exists).

**Phase 4 — version slots.**
- Every subject gets "Save as version…" and a version dropdown
  (v1, v2, …) stored alongside the doc; one version is marked live.
  Cycle, compare, promote, delete. No more overwrite anxiety.

**Phase 5 — sprite renderer upgrade.**
- Offscreen-canvas caching (kills the per-pixel fillRect cost).
- `drawSpriteDoc` honours clip fps/loop, plays idle when standing,
  walk when moving, punch/jump/swim clips when the state demands,
  applies dye tints, clips for water submersion.
- Palette+RLE storage format (kills the localStorage bomb), with
  automatic migration from the current format.

**Phase 6 — roles & character system.**
- Player characters get optional role metadata (name, role, stat
  nudges) defined in the editor, sent to the server on spawn/switch.

Phases 1–2 give you the world you described: every visible thing in
the game openable and repaintable in the editor. 3–6 make it scale.

# Building regions from the real Bamfield & Anacla geography

You have three ways to get the real landscape into the game, easiest first. All
of them end by producing a **region JSON** that the engine loads.

> ⚠️ **Legal note on Google Earth / Google Maps:** their satellite imagery is
> licensed and you may **not** rip Earth/Maps tiles into a game. Use it only to
> *look*. For data you can actually ship, use **OpenStreetMap** (roads, water,
> building footprints, place names) and **open elevation** (Natural Resources
> Canada CDEM/HRDEM, or Copernicus/SRTM). ESRI "World Imagery" and Bing both
> permit *tracing*, so they're fine as a visual reference to draw over.

The world is a set of **regions** that share one tide clock. Today there are
two, linked by bus / car / boat travel:

- `bamfield` — West & East Bamfield + Grappler Inlet, open to Barkley Sound
- `anacla` — Lower Anacla + Pachena Bay & the Pachena River (~5 km down the road)

Both currently use handcrafted maps in `shared/map.ts`. Here's how to replace
them with the real thing.

---

## Option 1 — Trace it into an image (recommended to start)

This reuses the importer at `tools/import-image-map.mjs`. Each pixel = one tile.

1. Open a top-down reference: a **screenshot of your Minecraft build**, or
   satellite imagery of the area (ESRI/Bing) at a fixed zoom.
2. In any pixel editor (Photoshop, GIMP, Aseprite, even Paint), make an image
   sized to your tile grid (e.g. **120×80** for a bigger world) and paint over
   the reference using this palette:

   | Paint color | Tile |
   |---|---|
   | `#1C5F86` (blue) | Water |
   | `#D8C98C` (tan) | Sand / beach |
   | `#4F7D3A` (green) | Grass |
   | `#2F5A28` (dark green) | Forest |
   | `#6B6F57` | Hill |
   | `#7D7D7D` (grey) | Rock |
   | `#5B524A` | Road |
   | `#7A5A36` | Dock |
   | `#FF00FF` (magenta) | **Building** (any blob → one building) |

3. (Optional) Export a **grayscale heightmap** the same size (white = high) to
   auto-promote steep grass into hills/rock.
4. Convert:

   ```bash
   npm run import-map -- \
     --image maps/bamfield.png \
     --id bamfield --name "Bamfield" \
     --out shared/regions/bamfield.json \
     --elevation maps/bamfield_height.png   # optional
   ```

5. Open the JSON, set a sensible `spawn`, and add `travelNodes` (see below).
6. Register it (next section).

---

## Option 2 — Real OSM data, automatically (most authentic)

`tools/import-osm.mjs` pulls real OpenStreetMap geometry (coastline, inlet,
rivers, roads, building footprints) and rasterizes it straight into a region
JSON. Bamfield core (West/East/Grappler) is roughly **48.815–48.85 N,
125.16–125.11 W** — about 2 km, as you said. Anacla/Pachena Bay is ~5 km
southeast.

**Run it live** (needs internet — run on your own machine, not the web sandbox
whose network is locked down):

```bash
npm run import-osm -- \
  --bbox 48.815,-125.16,48.85,-125.11 \
  --width 90 --id bamfield --name "Bamfield" \
  --sea-seed 0,89 \
  --out shared/regions/bamfield.json
```

`--sea-seed X,Y` is a tile in the **open ocean**; the sea is flood-filled from
there up to the coastline (bottom-left works for Bamfield). Height is derived
automatically from the bbox so tiles stay roughly square.

**Run it offline** (e.g. inside the web sandbox): first save the Overpass JSON
to a file — paste the query from the script into <https://overpass-turbo.eu/>,
export as raw JSON — then point the importer at it:

```bash
npm run import-osm -- --osm-json maps/bamfield.osm.json \
  --bbox 48.815,-125.16,48.85,-125.11 --width 90 \
  --id bamfield --name "Bamfield" --sea-seed 0,89 \
  --out shared/regions/bamfield.json
```

Then set `spawn` + `travelNodes` in the JSON and register it (next section).
Elevation: the tile **elevations** in `shared/protocol.ts` (`TILE_ELEVATION`)
decide how high the tide climbs each cycle — tune them to match the terrain.

---

## Registering a region

Imported regions plug in via a helper already in the code:

```ts
// shared/map.ts
import bamfieldData from "./regions/bamfield.json";       // bundled at build time
import { regionFromData } from "./map";

export function buildRegions(): RegionDef[] {
  const bamfield = regionFromData(bamfieldData as RegionData);
  // ...add travelNodes to bamfield, build anacla similarly, return [bamfield, anacla];
}
```

(JSON imports are bundled by Vite/wrangler, so this works on Cloudflare.)

---

## Travel nodes (bus / car / boat)

Each region lists the pads that move you elsewhere. From the current Bamfield:

```ts
travelNodes: [
  { id: "bf-bus",  kind: "bus",  x: 19, y: 21, w: 2, h: 1,
    label: "Catch the bus at the market to Anacla",
    toRegion: "anacla", toSpawn: { x: 38, y: 24 } },
  { id: "bf-car",  kind: "car",  x: 39, y: 2,  w: 2, h: 1,
    label: "Drive up Bamfield Main to Anacla",
    toRegion: "anacla", toSpawn: { x: 40, y: 1 } },
  { id: "bf-boat", kind: "boat", x: 30, y: 37, w: 3, h: 2,
    label: "Boat out the inlet to Pachena Bay",
    toRegion: "anacla", toSpawn: { x: 30, y: 33 } },
]
```

Stand on a pad and press **T**. Put the matching return pads in the destination
region so travel is two-way. `toSpawn` must land on a walkable (non-submerged)
tile in the destination.

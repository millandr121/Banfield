# Bamfield Tides

A top-down, tile-based coastal **survival game** set in a recreation of
Bamfield, BC. Survive the rhythm of **low tide and high tide** on the edge of
Barkley Sound:

- **Low tide** exposes the flats — **crabs** and small critters swarm and chew
  on your structures.
- **High tide** floods the shore — **dogfish, six-gill sharks, and orcas** prowl
  the deep water. **Humpback and grey whales** drift through, harmless.
  **Octopuses** show up at either tide.
- Rare **king tides** and (very rare) **tsunamis** surge the waterline far past
  normal — get to high ground.

Structures are **semi-permanent**: they can be smashed into rubble, but you can
always rebuild them. **Driveable cars and boats** sit around the regions — walk
up and press **F** to board, then steer with WASD (cars are quick on roads,
boats ride the water). Leave a boat in the water and the tide can carry it off.

Combat rewards timing: swings cost **stamina**, holding **Space** charges a
heavier hit, and **Shift** is a dodge with brief invulnerability. **Crabs**
swarm at low tide but scuttle back to the sea as the tide comes in.

It runs in the browser and is **online by default** — one shared world, a few
players at a time — using an authoritative server.

The world spans two **regions** that share one tide clock, linked by travel:
**Bamfield** (West & East Bamfield + Grappler Inlet) and **Anacla / Pachena
Bay** (~5 km down the road). Travel between them **on foot** — catch the **bus**
at the market or hike the **gate** at the road's end up Bamfield Main; stand on
a pad and press **T**. Vehicles stay in their own region.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Client | HTML5 Canvas + TypeScript (Vite) | No heavy engine; cross-platform; instant updates |
| Realtime | WebSockets | Live tide/creature sync |
| Server | Cloudflare **Worker** + **Durable Object** | The single game world is one stateful object everyone connects to |
| Hosting | Cloudflare | Cheap/free at this scale; can later wrap in Tauri/Electron for a Steam build |

The server is **authoritative**: it owns the true state (tide, creatures,
building HP) so clients can't cheat. Shared types live in `shared/` so the wire
format never drifts.

```
shared/      protocol.ts (types, tide model)   map.ts (regions, maps, travel nodes)
server/      index.ts (Worker)                 GameRoom.ts (Durable Object = the world)
client/      index.html (character creator)    src/main.ts  src/game.ts  src/net.ts
tools/       import-image-map.mjs (real-map importer)
```

## Run it locally

Requires Node 18+.

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**. Vite serves the client and proxies the
WebSocket (`/ws`) to `wrangler dev` running the Worker + Durable Object.

- Move: **WASD** / arrow keys
- Attack: **Space**
- Repair a nearby building: **E**
- Travel (on a bus/car/boat pad): **T**

Open the page in two tabs (or two devices on your network) to see multiplayer.

## Deploy (publish online)

```bash
npm run deploy
```

This builds the client and runs `wrangler deploy`, which publishes the Worker,
creates the Durable Object, and serves the built client — one shared world at
your `*.workers.dev` URL. (Run `npx wrangler login` once first.)

## Controls / mechanics summary

- You **can't walk into water** (no boats yet), so a rising tide can strand you.
- Creatures path toward the nearest player, otherwise the nearest standing
  building, and attack on contact.
- A building at 0 HP becomes **rubble**; stand next to it and hold **E** to
  rebuild it.

## Getting the *real* Bamfield & Anacla into the game

Right now both regions use handcrafted, recognizable approximations in
`shared/map.ts`. To use the real geography, **see [REGION_IMPORT.md](REGION_IMPORT.md)**.
In short: trace a top-down image (your Minecraft screenshot, or satellite
imagery you're allowed to trace) and convert it with the importer:

```bash
npm run import-map -- --image maps/bamfield.png --id bamfield \
  --name "Bamfield" --out shared/regions/bamfield.json
```

For maximum authenticity, REGION_IMPORT.md also covers pulling real data from
**OpenStreetMap** (roads/water/buildings) + **open elevation** (NRCan DEM).
**Note:** Google Earth/Maps imagery is licensed and can't be shipped — use OSM
+ open DEM instead (details in that doc).

Tile elevations in `shared/protocol.ts` (`TILE_ELEVATION`) drive what floods at
each tide — tune them to match your terrain.

## Roadmap ideas

- Crafting vehicles at the boat shop / mechanic (build your own car or boat)
- Resource gathering + a real build/crafting system
- Food/hunger (eat at the market or restaurants), fishing rods, fire-building
- Persistent world + player accounts (Cloudflare D1 / Durable Object storage)
- Photo-ish avatars via a richer part-based character creator
- Day/night on top of the tide cycle

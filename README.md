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
always rebuild them. Boats and vehicles (coming) let you move and shelter, but
high water can sweep vehicles away.

It runs in the browser and is **online by default** — one shared world, a few
players at a time — using an authoritative server.

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
shared/      protocol.ts (types, tide model)   map.ts (Bamfield map + buildings)
server/      index.ts (Worker)                 GameRoom.ts (Durable Object = the world)
client/      index.html (character creator)    src/main.ts  src/game.ts  src/net.ts
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

## Getting the *real* Bamfield into the game

Right now the map is a handcrafted, Bamfield-inspired layout in
`shared/map.ts` (`generateBamfieldMap()`). To use the town you built, replace
that function — its only contract is "return a `WorldMap` of tiles". Options,
easiest first:

1. **Trace your Minecraft build.** Take a top-down screenshot, load it into the
   [Tiled](https://www.mapeditor.org/) map editor, and paint tiles over it.
2. **Color → tile script.** Export a top-down image and map each pixel color to
   a tile type (blue→water, green→hill, grey→road).
3. **Real geographic data.** Bamfield is ~48.83°N, 125.13°W. Pull elevation
   (DEM) from Natural Resources Canada and roads/buildings from OpenStreetMap,
   then bucket elevation into tiles.

Tile elevations in `shared/protocol.ts` (`TILE_ELEVATION`) drive what floods at
each tide — tune them to match your terrain.

## Roadmap ideas

- Boats/vehicles (cross water; can be swept away at high tide)
- Resource gathering + a real build/crafting system
- Persistent world + player accounts (Cloudflare D1 / Durable Object storage)
- Photo-ish avatars via a richer part-based character creator
- Day/night on top of the tide cycle

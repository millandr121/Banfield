# Banfield, The Game — Roadmap & Vision

Living checklist. We work top-down: **Map → Art → Combat → Systems**. Check
items off as they ship. (Captured from playtest notes so nothing gets lost.)

---

## 0. Guiding principles
- **Real Bamfield, technically accurate.** Wildlife, plants, geography, names —
  all true to the real place. "OMG it's Ostrom's!" / "that's the seal rock by
  Diana Island!"
- Aesthetic target: Eastward / Hyper Light Drifter / Kynseed — oblique 3/4 view,
  jewel tones, everything stands up off the ground.
- Licensing: OSM + open elevation only. **Never** rip Google/Earth/Maps tiles.

---

## 1. MAP
- [x] Real OSM geography for Bamfield + Anacla (from openstreetmap.org export)
- [x] Fix water/land flood (ocean floods in from map edges; coastline barrier)
- [x] **Tide stays within the mapped water** — land tiles now sit at/above the
      high-tide line, so only king tides & tsunamis spill onto land.
- [x] Ostrom's Gas Bar named correctly (was "Pachena Bay / Anacla Gas Bar").
- [x] **Flood leak fixed for good** — the ocean flood now seals hairline gaps in
      the coastline *before* flooding, so it can't pour through a 1-3 tile crack
      and drown a whole bay. Pachena Bay / Anacla read as land again.
- [x] Grappler Bay east shore — fixed by the gap-sealing flood above.
- [x] **Bigger scale** — one big world at `--width 3300` (13.2 M tiles).
- [x] **ONE WORLD** — Anacla & Pachena Bay are the SE corner of the Bamfield map
      now (no separate region). Pressing **M** anywhere shows the whole world.
- [x] Scale up so the townsite isn't cluttered (Bamfield 480 wide)
- [x] Real building names on sign plaques (all 20 BMSC buildings, Flora's, etc.)
- [ ] **Roads two tiles wide** (two-lane, realistic)
- [x] **$3 in-world bus** — pads at the market and Anacla; press **T** to ride
      across the world (charges $3, for when the walk's too long & you've no car).
- [x] **Whole-area map**: Bamfield now covers the islands (Diana, Helby, Edward
      King, Dixon, Seppings, Wizard, Bordelais) + open ocean you can sail.
- [x] **Chunked / buffered loading** + interest management so the 480k-tile map
      runs in HTML5 (chunks stream around the player; far entities aren't sent).
- [ ] Better building footprints — rasterize the actual OSM polygon shape, not
      just a bounding box, for more detailed/accurate buildings.
- [x] Travel: walk/drive/sail across the one world to Anacla, or catch the $3 bus.
- [x] **Performance** — resource nodes use a spatial bucket index + a depleted-set
      so the per-tick snapshot/respawn cost stays flat even with 62k trees.
- [ ] **Trunk collision** — make just the trunk tile solid so you weave through
      dense forest (canopy never blocks). Deferred: needs careful nav testing.

## 2. ART / VISUALS
- [x] Oblique 3/4 characters (head/body/arms/legs, walk cycle)
- [x] Oblique buildings (wall facade, pitched roof, windows, door)
- [x] Taller trees with trunks; Y-sorting (depth overlap)
- [x] Marine depth-reveal (fin/blow/ripple; faint body under the surface)
- [x] **Flood grace period extended** (180 s → was 60 s). Also bumped to 3 min
      so crossing the inlet doesn't silently drown you mid-swim.
- [ ] **BUG: fish shows full body AND fin at once** (double-render glitch) —
      deep water should show ONLY the fin, no full body.
- [ ] **BUG: character faces the wrong way walking left/right** (hair on the
      wrong side).
- [ ] **Water-depth body height**: ankle-deep in shallow, waist-deep in mid,
      head-only in deep. You walk in waist-high and lower; swim in deep.
- [ ] **Drowning animation** — float by default; if you float too long (~1 min)
      you start to drown and must swim. Not too easy to drown.
- [ ] **Swim stamina** — tire out swimming like running/sprinting (throttle).
- [ ] Kelp beds: grow along waist-high water, mostly **out in the ocean**, NOT
      really in the inlet (the odd one). Sea otters live in kelp beds.
- [x] **Real NW-coast tree species** — western redcedar & Sitka spruce
      old-growth giants, Douglas fir, western hemlock (young), shore pine, red
      alder & bigleaf maple (broadleaf), rare **Pacific yew**, and super-rare
      **arbutus** (only ~7 on the whole coast, on rocky bluffs — and once felled
      it's gone for GOOD). Each drawn to its own silhouette; per-tree size varies
      so old-growth towers over saplings. Placed in organic clumps (dense stands
      + open glades), never a grid.
- [ ] Shoreline foam, water gradient polish, palette tuning (Eastward tones).
- [ ] **Nova Harvest** (oysters/shell creatures) shop just south of Buchanan
      Lodge + Seaside Dormitory; **shovel** for clam digging (buy at hardware);
      dive for oysters later. (Queued for the next session — items + shop need
      wiring; deferred to keep this build stable.)

## 3. COMBAT (skill-based)
- [x] Weapon system: stick, hunting knife (melee); bow, crossbow, speargun,
      rifle (ranged, hitscan + ammo). Per-weapon damage/range/cooldown/stamina;
      combat-skill scaling; charged melee swings; speargun bonus vs marine life.
      Weapons/ammo sold at Breaker's Marine & Ostrom's. Slots 1-6 + 0 (fists).
- [x] PvP damage (melee + ranged, respects dodge i-frames) — foundation for the
      wanted/cops system.
- [x] Ranged tracer effects + HUD weapon/ammo readout.
- [ ] Projectile travel (currently hitscan) + arcing arrows, later.
- [ ] Equip from a proper hotbar UI; weapon sprites in-hand on the character.

## 4. WILDLIFE & NATURE (technical accuracy)
- [ ] Rarity tiers (OSRS-style rarity feel):
  - Sea otters — **super rare**, only in kelp forest beds, out in the ocean
  - White-tail deer — **very rare** (≈2 sightings in 6 yrs: town + an island)
  - Cougars — **very rare**; if seen they vanish fast, often just lurking,
    watching, never quite seen. A real event.
  - Orcas — occasional; sometimes sweep into the inlet = **spectacle** →
    public announcement shouted by a local NPC
- [ ] Seals always sunbathing on **the rock by Diana Island**
- [ ] Sea lion species accuracy: **California vs Steller**, big bull males
- [x] **Inspection tool** (X) — minimalist field-guide card for the nearest
      creature/plant/resource: common + scientific name, rarity, fact, use.
- [x] **Logbook** (L) — BMSC field logbook, grouped by type with encounter
      counts + "X / total logged" tally; persists to D1.
- [x] **Discovery radius** (R) — animated ring logs every species in range.
      (Still to add: per-find location + time-of-day stamping.)

## 5. SYSTEMS / META
- [~] **NPCs** — placed at real landmarks (BMSC, Mercantile, Breaker's, gov)
      with dialogue + talk prompt; orca arrival shout done. Still to do: proper
      roles (responders/nurse/chief/president), movement, richer dialogue.
- [x] **Persistence** — Cloudflare D1 (`banfieldthegame`). Players save/load by
      name with a per-device claim secret; autosave every 30s + on disconnect.
      Schema in `server/schema.sql`.
- [ ] **Login screen** + **recovery emails** (needs an email provider). The
      `secret`/`email` columns + claim flow are already in place to build on.
- [ ] **Intro / character creation** — pick a unique (untaken) name + design
      your look. Change name every 30 days; change look at your own house.
- [ ] **OSRS-style UI**: visible backpack/inventory, skill progression & stats,
      a menu/tab bar, a controls helper you can toggle on/off.
- [ ] **Community leaderboard** menu — current unofficial mayor, BMSC President
      (most species logged), fire chief, top first responders, etc.
- [ ] Diving skill — **scuba + snorkeling** mechanics (later).
- [ ] **Claim-a-house** — claim any residential house as your own; enter it,
      redesign your look, store items, decorate the interior (later).
- [ ] **Interior spaces** — market, BMSC, houses you can walk into (later).

## 6. ECONOMY, VEHICLES & ROLES
- [x] **Roles & ranks** (live, recomputed like the mayor system):
  - **Mayor** (top Banfielder pts), **BMSC President** (most species logged),
    **Fire Chief** (most building repairs), **Nurse** (top first responder),
    **First Responders** (next 5 by heals given). Titles shown on the HUD and
    above the player; unseated by whoever tops the metric.
- [x] **Healing** (H) — patch up the nearest hurt player using cooked food;
      earns Banfielder pts and feeds the responder rank.
- [x] **Community leaderboard** (K) — all current title-holders + top Banfielders.
- [x] **Death rework** — now costs 35% Banfielder pts + randomized skill XP.
- [x] **Admin / test commands** — `/give [qty] [item|skill]`, `/money [n]`, `/tp [x] [y]`,
      `/god` (invincible), `/tide [tsunami|king|none]`, `/spawn [creature]`,
      `/heal`, `/kill`, `/where`. Open to everyone for now (lock down later).
- [ ] **Scrapyard** (up Bamfield Main Rd) — buy **vehicles/cars**.
- [ ] **Breaker's Marine** — buy **boats**.
- [ ] **Vehicle ownership** + sell/trade via "pinkslips"; **locking**.
- [ ] **GTA-style theft** → report stolen → driver becomes **wanted**.
- [ ] **Cops** — NPCs from Port Alberni that hunt wanted players.
- [ ] Mayor / chief / responders can tag players **wanted** without cause.
- [ ] **Wildfires** + fire-fighting (feeds the Fire Chief role) — part of the
      natural-disaster system alongside tsunami / king tides.
- [x] **Natural-disaster rarity rework** — king tides now seeded by real calendar
      day (~1/15 days = ~2×/month); tsunamis ~1/365 days = OSRS 3rd-age rare.
      Surviving either awards Banfielder pts (king tide +10, tsunami +50).
- [ ] **Disaster logbook achievement** — log the specific date + event when
      a player survives a king tide or tsunami; visible in the field logbook.
- [x] **East/NE land un-flooded** — the ocean flood had leaked past the map
      edges into land that runs beyond the bbox (Pachena/Anacla read as water
      under their own roads). `tools/repair-flood.mjs` reclaims it on the baked
      grid since the `.osm` export isn't recoverable in-container. 425k tiles
      back to forest/shore; harbour, inlet & islands untouched.
- [x] **Fresh vs salt water** — inland lakes are now `Tile.FreshWater` (teal-
      green, never tidal). **Press E by a lake to drink** — takes the edge off
      hunger (to ~60%) but won't fill you; the ocean is salt and undrinkable.
      NOTE: the Pachena River can't be tagged fresh without a re-import (it
      drains to the ocean and merged with it) — revisit when the `.osm` is back.
- [ ] **BUG LOG: "dragged under" random death** — player dies with "dragged under"
      message after swimming and returning to shore. Root cause: FLOAT_GRACE_MS
      was only 60 s; at 3300-tile scale the inlet takes ~90 s to cross when
      tired. Fixed grace to 180 s. Suspect also flares during king tides when
      shore tiles briefly become swimming depth. Monitor for recurrence.

## 7. FUTURE — BIG RESEARCH PUSH (species catalog)
All of the below is a future multi-session effort. Not started.
- [ ] **Full NW Vancouver Island species encyclopedia** — catalog every species
      present near Bamfield: trees, shrubs, berries, kelp types (bull kelp,
      giant kelp, etc.), flowers, mosses, lichens, mushrooms, intertidal
      invertebrates (barnacles, mussels, chitons, sea stars, urchins, nudibranchs,
      anemones, limpets, hermit crabs, purple sea urchin, ochre star, turban
      snail, sea cucumber), fish (coho, chinook, steelhead, rockfish, cabezon,
      wolf eel, halibut, dungeness crab, Tanner crab, prawn), marine mammals
      (harbour seal, Steller sea lion, California sea lion, harbour porpoise,
      Dall's porpoise, Pacific white-sided dolphin, grey whale, humpback,
      minke, orca), land mammals (black-tailed deer, elk, black bear, cougar,
      wolf, river otter, mink, marten, raccoon, beaver, muskrat, Douglas
      squirrel), birds (bald eagle, great blue heron, osprey, kingfisher,
      marbled murrelet, rhinoceros auklet, tufted puffin, common murre, pigeon
      guillemot, western grebe, loon, scoter, surf bird, black oystercatcher,
      dunlin, turnstone, cedar waxwing, Steller's jay, raven, crow, varied
      thrush, winter wren, golden-crowned kinglet), insects (Faun swallowtail,
      common wood nymph, bumblebee, dragonfly).
- [ ] Each species: common name + scientific name, real rarity, one-sentence
      field fact, OSRS-style rarity label, distinct art sprite true to life.
- [ ] **Art redesign backend** — admin UI to edit existing tile/creature sprites,
      create new art assets, patch map tiles, and push live without redeployment.
      (Significant implementation effort — a future session.)

---

## Done log (high level)
- OSM import pipeline (XML), reefs, POI nodes, stable shop IDs, entity decode
- Oblique character/world renderer + Y-sort
- Orca curious (not aggressive), plants can't be submerged, sea-spawn fixes
- Water/land flood fix, 2.4× scale, real building names, 2-lane roads
- Art bug fixes: L/R facing, fish double-render, water-depth body height
- Chunked map streaming (32×32 chunks + downsampled overview minimap)
- Cloudflare D1 persistence (accounts/skills/money/inventory autosave)

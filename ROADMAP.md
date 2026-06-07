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
- [x] Scale up so the townsite isn't cluttered (Bamfield 480 wide)
- [x] Real building names on sign plaques (all 20 BMSC buildings, Flora's, etc.)
- [ ] **Roads two tiles wide** (two-lane, realistic)
- [ ] **Bus stop on the road right in front of the market** (real West Coast
      Trail bus pickup spot). Catching the bus = instant travel to Anacla.
- [ ] **Whole-area map**: use the full OSM bbox — open ocean + islands
      (Diana, Helby — both have houses), seal rocks, reefs out to sea.
- [ ] **Chunked / buffered loading** so the big map works in HTML5 (load the
      map in tiles/zones around the player; stream as you move/sail).
- [ ] Better building footprints — rasterize the actual OSM polygon shape, not
      just a bounding box, for more detailed/accurate buildings.
- [ ] Travel: walk/sail the ocean to Anacla, or catch the bus (instant).

## 2. ART / VISUALS
- [x] Oblique 3/4 characters (head/body/arms/legs, walk cycle)
- [x] Oblique buildings (wall facade, pitched roof, windows, door)
- [x] Taller trees with trunks; Y-sorting (depth overlap)
- [x] Marine depth-reveal (fin/blow/ripple; faint body under the surface)
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
- [ ] Shoreline foam, water gradient polish, palette tuning (Eastward tones).

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

## 6. ECONOMY, VEHICLES & ROLES (later — captured from notes)
- [ ] **Scrapyard** (up Bamfield Main Rd) — buy **vehicles/cars** here.
- [ ] **Breaker's Marine** — buy **boats** here.
- [ ] **Sell/trade big items** (cars, boats) between players via "pinkslips";
      ownership transfers and the vehicle keeps its new owner wherever it sits.
- [ ] **Vehicle locking** so they don't get stolen.
- [ ] **GTA-style theft** — if someone drives your car/boat you can report it
      stolen; they become **wanted**.
- [ ] **Cops** — NPCs that come from Port Alberni to town to catch wanted
      players.
- [ ] **Roles & ranks** (like the unofficial mayor system):
  - **First responders** (max 6) — earned by healing people (heal via food /
    bandaid option we add). Highest-ranked first responder becomes the **Nurse**.
  - **Fire Chief** — highest-ranked person who repairs buildings / puts out
    fires. (Needs wildfires + fire-fighting first.)
  - **BMSC President** — whoever has logged the most species.
  - Mayor / chief / responders can tag players **wanted** without cause.
  - Demotion works like the mayor: someone higher can rank you out.
- [ ] **Healing** — heal others via food or bandaid (feeds the responder rank).
- [ ] **Natural disaster system** — wildfires (+ fighting them), expand beyond
      tsunami / king tides.
- [ ] **Death rework** — dying should cost a lot of Banfielder pts **and** some
      skill XP (randomized reduction across skills?). (Currently: -25% raw XP.)

---

## Done log (high level)
- OSM import pipeline (XML), reefs, POI nodes, stable shop IDs, entity decode
- Oblique character/world renderer + Y-sort
- Orca curious (not aggressive), plants can't be submerged, sea-spawn fixes
- Water/land flood fix, 2.4× scale, real building names, 2-lane roads
- Art bug fixes: L/R facing, fish double-render, water-depth body height
- Chunked map streaming (32×32 chunks + downsampled overview minimap)
- Cloudflare D1 persistence (accounts/skills/money/inventory autosave)

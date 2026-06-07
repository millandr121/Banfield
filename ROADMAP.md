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

## 3. COMBAT (skill-based, after art)
- [ ] Rework combat to be skill-based (research top-down combat feel)
- [ ] Weapons: rifle, hunting knife, bow & arrow, speargun, stick, crossbow
- [ ] Each weapon: range, windup, ammo, skill scaling

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
- [ ] **Inspection tool** — inspect any creature/plant/etc → minimalist,
      interactive popup: common + scientific name, uses, facts
- [ ] **Logbook** — free from the BMSC office. Logs every discovery: species,
      count, location, time of day / date. Track what you've found.
- [ ] **Discovery radius** — press a button, a radius animates out from you,
      auto-logs everything in range (so you can ID dangerous/hard-to-reach
      things at a safe distance) into the logbook.

## 5. SYSTEMS / META
- [ ] **NPCs** — implement the locals properly (dialogue, roles, the orca-shout)
- [ ] **Persistence** — everyone's data must save. Plan: **Cloudflare D1**
      (SQL, native to the Worker we already run). Store players, discoveries,
      house claims, inventory, skills.
- [ ] **Login screen** at start, with **recovery emails** (so accounts recover).
- [ ] **Intro / character creation** — pick a unique (untaken) name + design
      your look. Change name every 30 days; change look at your own house.
- [ ] **OSRS-style UI**: visible backpack/inventory, skill progression & stats,
      a menu/tab bar, a controls helper you can toggle on/off.
- [ ] Diving skill — **scuba + snorkeling** mechanics (later).
- [ ] **Claim-a-house** — claim any residential house as your own; enter it,
      redesign your look, store items, decorate the interior (later).
- [ ] **Interior spaces** — market, BMSC, houses you can walk into (later).

---

## Done log (high level)
- OSM import pipeline (XML), reefs, POI nodes, stable shop IDs, entity decode
- Oblique character/world renderer + Y-sort
- Orca curious (not aggressive), plants can't be submerged, sea-spawn fixes

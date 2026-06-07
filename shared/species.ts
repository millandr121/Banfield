// Field-guide data for everything you can inspect or log in the world.
// Kept accurate to real Bamfield / Barkley Sound wildlife & flora.

export interface SpeciesInfo {
  common: string;        // common name shown in the logbook
  scientific: string;    // italicised scientific name
  group: "marine" | "land" | "bird" | "plant" | "tree" | "mineral";
  blurb: string;         // a short, true fact
  uses?: string;         // what it's good for in-game / in life
  rarity?: "common" | "uncommon" | "rare" | "very rare" | "legendary";
}

// Keyed by creature kind, plant kind, resource kind, or "<resource>:<variety>".
export const SPECIES: Record<string, SpeciesInfo> = {
  // --- marine ---
  crab:      { common: "Dungeness Crab", scientific: "Metacarcinus magister", group: "marine", rarity: "common",
               blurb: "Prized eating crab of the Pacific coast; males must measure 165 mm to keep.", uses: "Cook the meat for a hearty meal." },
  octopus:   { common: "Giant Pacific Octopus", scientific: "Enteroctopus dofleini", group: "marine", rarity: "uncommon",
               blurb: "The world's largest octopus species — intelligent and den-dwelling.", uses: "Valued catch; sells well." },
  dogfish:   { common: "Pacific Spiny Dogfish", scientific: "Squalus suckleyi", group: "marine", rarity: "common",
               blurb: "A small schooling shark with mildly venomous spines; can live 80+ years.", uses: "Caution near deep water at high tide." },
  sixgill:   { common: "Bluntnose Sixgill Shark", scientific: "Hexanchus griseus", group: "marine", rarity: "rare",
               blurb: "A deep-water relic shark that rises shallower at night.", uses: "Dangerous — keep out of the deep when it's near." },
  orca:      { common: "Killer Whale (Orca)", scientific: "Orcinus orca", group: "marine", rarity: "rare",
               blurb: "Barkley Sound sees transient (Bigg's) and resident pods; they sometimes sweep the inlets.", uses: "A spectacle — watch, don't crowd them." },
  humpback:  { common: "Humpback Whale", scientific: "Megaptera novaeangliae", group: "marine", rarity: "uncommon",
               blurb: "Returned to these waters in numbers; famous for bubble-net feeding.", uses: "Keep 100 m distance by law." },
  greywhale: { common: "Gray Whale", scientific: "Eschrichtius robustus", group: "marine", rarity: "uncommon",
               blurb: "Migrates past Bamfield each spring, grubbing the sea floor for amphipods.", uses: "Keep 100 m distance by law." },
  seal:      { common: "Harbour Seal", scientific: "Phoca vitulina", group: "marine", rarity: "common",
               blurb: "Curious and abundant; hauls out on rocks like the one off Diana Island.", uses: "Harmless; follows slow swimmers." },
  sealLion:  { common: "Steller Sea Lion", scientific: "Eumetopias jubatus", group: "marine", rarity: "uncommon",
               blurb: "Huge golden bulls boom from the haul-outs; California sea lions (Zalophus californianus) visit too.", uses: "Give big males a wide berth." },
  seaOtter:  { common: "Sea Otter", scientific: "Enhydra lutris", group: "marine", rarity: "very rare",
               blurb: "Once extirpated locally; a keystone species that shelters in kelp forests.", uses: "Extremely rare here — a real find." },

  // --- land mammals ---
  deer:   { common: "Columbian Black-tailed Deer", scientific: "Odocoileus hemionus columbianus", group: "land", rarity: "common",
            blurb: "The everyday deer of the coast — they wander right through town.", uses: "Hunt for venison." },
  elk:    { common: "Roosevelt Elk", scientific: "Cervus canadensis roosevelti", group: "land", rarity: "uncommon",
            blurb: "The largest elk subspecies, at home in old-growth rainforest.", uses: "Hunt for plenty of venison." },
  bear:   { common: "American Black Bear", scientific: "Ursus americanus", group: "land", rarity: "uncommon",
            blurb: "Coastal blacks fish the creeks in fall; never feed or corner one.", uses: "Dangerous if provoked." },
  cougar: { common: "Cougar", scientific: "Puma concolor", group: "land", rarity: "very rare",
            blurb: "Vancouver Island has North America's densest cougar population, yet sightings are fleeting — they watch unseen.", uses: "If you see one, it's already leaving." },
  wolf:   { common: "Coastal Gray Wolf", scientific: "Canis lupus", group: "land", rarity: "rare",
            blurb: "Island 'sea wolves' swim between islands and forage the shoreline.", uses: "Travels in packs — stay wary." },

  // --- birds ---
  grouse: { common: "Sooty Grouse", scientific: "Dendragapus fuliginosus", group: "bird", rarity: "common",
            blurb: "Males give a deep hooting from the conifers each spring.", uses: "Hunt for poultry." },

  // --- invasive plants ---
  scotchBroom:         { common: "Scotch Broom", scientific: "Cytisus scoparius", group: "plant", rarity: "common",
                         blurb: "Aggressive invader; pull it WHEN FLOWERING to kill the root.", uses: "Removing it earns Banfielder points." },
  himalayanBlackberry: { common: "Himalayan Blackberry", scientific: "Rubus armeniacus", group: "plant", rarity: "common",
                         blurb: "Thicket-forming invasive that smothers native shrubs.", uses: "Removing it earns Banfielder points." },
  foxglove:            { common: "Foxglove", scientific: "Digitalis purpurea", group: "plant", rarity: "common",
                         blurb: "Pretty but toxic invasive; source of the heart drug digitalis.", uses: "Removing it earns Banfielder points." },

  // --- trees & berries ---
  tree:               { common: "Sitka Spruce", scientific: "Picea sitchensis", group: "tree", rarity: "common",
                        blurb: "Backbone of the coastal temperate rainforest.", uses: "Fell for wood." },
  "tree:arbutus":     { common: "Arbutus (Pacific Madrone)", scientific: "Arbutus menziesii", group: "tree", rarity: "rare",
                        blurb: "Canada's only native broadleaf evergreen; peeling cinnamon bark, rocky shores only.", uses: "Slow-growing — fell sparingly." },
  "berryBush:salmonberry":        { common: "Salmonberry", scientific: "Rubus spectabilis", group: "plant", rarity: "common", blurb: "First berry of spring; the flowers feed hummingbirds.", uses: "Forage to eat or sell." },
  "berryBush:salal":              { common: "Salal", scientific: "Gaultheria shallon", group: "plant", rarity: "common", blurb: "A Coast Salish staple berry; dense evergreen understory.", uses: "Forage to eat or sell." },
  "berryBush:huckleberry":        { common: "Red Huckleberry", scientific: "Vaccinium parvifolium", group: "plant", rarity: "common", blurb: "Tart red berries on bright-green twigs.", uses: "Forage to eat or sell." },
  "berryBush:thimbleberry":       { common: "Thimbleberry", scientific: "Rubus parviflorus", group: "plant", rarity: "common", blurb: "Soft red berries and big maple-like leaves.", uses: "Forage to eat or sell." },
  "berryBush:trailing blackberry":{ common: "Trailing Blackberry", scientific: "Rubus ursinus", group: "plant", rarity: "common", blurb: "The only blackberry native to BC.", uses: "Forage to eat or sell." },

  // --- minerals ---
  ironOre:  { common: "Iron Ore", scientific: "Fe-bearing rock", group: "mineral", rarity: "common", blurb: "Smelts into iron bars at a forge.", uses: "Mine, then smelt." },
  stoneOre: { common: "Stone", scientific: "Sedimentary rock", group: "mineral", rarity: "common", blurb: "Plain building stone.", uses: "Mine for stone." },
};

// Resolve the species key for a resource node (handles berry/tree varieties).
export function resourceSpeciesKey(kind: string, variety?: string): string {
  if (variety && SPECIES[`${kind}:${variety}`]) return `${kind}:${variety}`;
  return kind;
}

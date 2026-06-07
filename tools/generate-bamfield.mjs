#!/usr/bin/env node
// tools/generate-bamfield.mjs
// Offline precise-geography map generator for Bamfield + Anacla.
// Encodes real-world coastlines, inlets, roads, docks, and buildings from
// geographic coordinates — no network required.
//
// Run:  node tools/generate-bamfield.mjs
// Out:  shared/regions/bamfield.json
//       shared/regions/anacla.json
//       shared/regions/index.ts  (updated to import both)

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = resolve(__dirname, "../shared/regions");

const T = { Water:0, Sand:1, Grass:2, Forest:3, Hill:4, Rock:5, Road:6, Dock:7 };

// ─────────────────────────────────────────────────────────────────────────────
// Grid primitives
// ─────────────────────────────────────────────────────────────────────────────
function makeGrid(W, H) { return { W, H, t: new Uint8Array(W * H).fill(T.Grass) }; }
const get = (g, x, y) => (x<0||y<0||x>=g.W||y>=g.H) ? -1 : g.t[y*g.W+x];
const set = (g, x, y, v) => { if (x>=0&&y>=0&&x<g.W&&y<g.H) g.t[y*g.W+x]=v; };

function rect(g, x0,y0,x1,y1, tile) {
  for (let y=Math.round(y0);y<=Math.round(y1);y++)
    for (let x=Math.round(x0);x<=Math.round(x1);x++) set(g,x,y,tile);
}
function hLine(g,x0,x1,y,tile) { rect(g,x0,y,x1,y,tile); }
function vLine(g,x,y0,y1,tile) { rect(g,x,y0,x,y1,tile); }

// Bresenham line with thickness (pts as {x,y} objects)
function drawLine(g, pts, tile, thickness=1) {
  const r = Math.max(0, Math.floor((thickness-1)/2));
  for (let i=0;i+1<pts.length;i++) {
    let x0=Math.round(pts[i].x), y0=Math.round(pts[i].y);
    let x1=Math.round(pts[i+1].x), y1=Math.round(pts[i+1].y);
    const dx=Math.abs(x1-x0), dy=-Math.abs(y1-y0);
    const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
    let err=dx+dy;
    while (true) {
      for (let ty=-r;ty<=r;ty++) for (let tx=-r;tx<=r;tx++) set(g,x0+tx,y0+ty,tile);
      if (x0===x1&&y0===y1) break;
      const e2=2*err;
      if (e2>=dy) { err+=dy; x0+=sx; }
      if (e2<=dx) { err+=dx; y0+=sy; }
    }
  }
}

// Scanline polygon fill (pts as {x,y} objects)
function fillPoly(g, pts, tile) {
  if (pts.length<3) return;
  let minY=Infinity, maxY=-Infinity;
  for (const p of pts) { minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); }
  minY=Math.max(0,Math.floor(minY)); maxY=Math.min(g.H-1,Math.ceil(maxY));
  for (let y=minY;y<=maxY;y++) {
    const xs=[];
    for (let i=0;i<pts.length;i++) {
      const a=pts[i], b=pts[(i+1)%pts.length];
      if ((a.y<=y&&b.y>y)||(b.y<=y&&a.y>y))
        xs.push(a.x+(y-a.y)/(b.y-a.y)*(b.x-a.x));
    }
    xs.sort((a,b)=>a-b);
    for (let i=0;i+1<xs.length;i+=2) {
      const xa=Math.max(0,Math.round(xs[i])), xb=Math.min(g.W-1,Math.round(xs[i+1]));
      for (let x=xa;x<=xb;x++) set(g,x,y,tile);
    }
  }
}

// Stack-based flood fill
function floodFill(g, sx,sy, from, to) {
  sx=Math.max(0,Math.min(g.W-1,Math.round(sx)));
  sy=Math.max(0,Math.min(g.H-1,Math.round(sy)));
  if (get(g,sx,sy)!==from) return;
  const stack=[[sx,sy]];
  while (stack.length) {
    const [x,y]=stack.pop();
    if (x<0||y<0||x>=g.W||y>=g.H||g.t[y*g.W+x]!==from) continue;
    g.t[y*g.W+x]=to;
    stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
  }
}

// Ring of sand on any grass tile touching water
function beachify(g) {
  const out=Uint8Array.from(g.t);
  for (let y=0;y<g.H;y++) for (let x=0;x<g.W;x++) {
    if (g.t[y*g.W+x]!==T.Water) continue;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
      const nx=x+dx, ny=y+dy;
      if (nx<0||ny<0||nx>=g.W||ny>=g.H) continue;
      if (out[ny*g.W+nx]===T.Grass) out[ny*g.W+nx]=T.Sand;
    }
  }
  g.t=out;
}

// BFS landcover: forest near coasts, hills further in, rock on ridges.
// Sources: water, road, dock, sand — distance from those drives vegetation tier.
function applyLandcover(g) {
  const d=new Int32Array(g.W*g.H).fill(-1);
  const q=[];
  for (let i=0;i<g.W*g.H;i++) {
    const t=g.t[i];
    if (t===T.Water||t===T.Road||t===T.Dock||t===T.Sand) { d[i]=0; q.push(i); }
  }
  for (let h=0;h<q.length;h++) {
    const i=q[h], x=i%g.W, y=(i/g.W)|0;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx=x+dx, ny=y+dy;
      if (nx<0||ny<0||nx>=g.W||ny>=g.H) continue;
      const ni=ny*g.W+nx;
      if (d[ni]===-1) { d[ni]=d[i]+1; q.push(ni); }
    }
  }
  // Vancouver-Island rainforest: forest is the dominant cover. Hills appear on
  // higher inland shoulders; bare rock only on the highest, farthest ridges and
  // is kept sparse (with organic noise) so it never forms ugly solid walls.
  for (let i=0;i<g.W*g.H;i++) {
    if (g.t[i]!==T.Grass) continue;
    const x=i%g.W, y=(i/g.W)|0;
    const di=d[i]<0?999:d[i];
    // Smooth pseudo-noise in [-4,4] to break up tier boundaries.
    const n=(Math.sin(x*0.21+y*0.13)+Math.sin(x*0.07-y*0.17)+Math.sin(x*0.31+y*0.05))*1.6;
    const dd=di+n;
    if      (dd>62 && ((x*7+y*13)%5===0)) g.t[i]=T.Rock;  // sparse ridge crags
    else if (dd>34) g.t[i]=T.Hill;
    else if (dd> 4) g.t[i]=T.Forest;
  }
}

// Find the nearest tile of a given type to (cx,cy), spiralling outward.
function nearestTile(g, cx,cy, tile) {
  cx=Math.round(cx); cy=Math.round(cy);
  for (let r=0;r<Math.max(g.W,g.H);r++) {
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      if (Math.max(Math.abs(dx),Math.abs(dy))!==r) continue;
      const x=cx+dx, y=cy+dy;
      if (get(g,x,y)===tile) return {x,y};
    }
  }
  return null;
}

// Clear a box back to Grass (e.g. for settled community areas)
function clearBox(g, x0,y0,x1,y1) {
  for (let y=Math.round(y0);y<=Math.round(y1);y++)
    for (let x=Math.round(x0);x<=Math.round(x1);x++)
      if (g.t[y*g.W+x]!==T.Water&&g.t[y*g.W+x]!==T.Road&&g.t[y*g.W+x]!==T.Dock)
        set(g,x,y,T.Grass);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource / plant auto-placement
// ─────────────────────────────────────────────────────────────────────────────
const BERRY_V = ["huckleberry","salmonberry","salal","thimbleberry","trailing blackberry"];
const INV_K   = ["scotchBroom","himalayanBlackberry","foxglove"];

function autoResources(g, id) {
  const nodes=[], plants=[];
  let ni=0, pi=0;
  const {W,H,t}=g;
  for (let y=4;y<H-4;y+=11) for (let x=4;x<W-4;x+=11) {
    const tile=t[y*W+x];
    if (tile===T.Forest) {
      nodes.push({id:`${id}-t${ni++}`,kind:"tree",x,y});
      if ((x+y)%21===0) nodes.push({id:`${id}-b${ni++}`,kind:"berryBush",x:x+2,y:y+1,variety:BERRY_V[(x*3+y)%BERRY_V.length]});
    } else if (tile===T.Hill||tile===T.Rock) {
      if ((x+y)%18===0) nodes.push({id:`${id}-i${ni++}`,kind:"ironOre",x,y});
      if ((x+y)%18===9) nodes.push({id:`${id}-s${ni++}`,kind:"stoneOre",x,y});
    } else if (tile===T.Grass) {
      if ((x+y)%28===4) {
        const hasF=[-1,0,1].some(dx=>[-1,0,1].some(dy=>{const ni2=(y+dy)*W+(x+dx);return ni2>=0&&ni2<W*H&&t[ni2]===T.Forest;}));
        if (hasF) nodes.push({id:`${id}-b${ni++}`,kind:"berryBush",x,y,variety:BERRY_V[(x+y*2)%BERRY_V.length]});
      }
    }
  }
  let pc=0;
  for (let y=4;y<H-4&&pc<5;y+=15) for (let x=4;x<W-4&&pc<5;x+=20) {
    if (t[y*W+x]===T.Sand||t[y*W+x]===T.Grass)
      plants.push({id:`${id}-inv${pi++}`,kind:INV_K[pc++%INV_K.length],x,y});
  }
  return {nodes,plants};
}

// ─────────────────────────────────────────────────────────────────────────────
// BAMFIELD   grid 200×173   bbox 48.815 S, -125.16 W → 48.855 N, -125.09 E
// ─────────────────────────────────────────────────────────────────────────────
// Scale: 1 tile ≈ 25.7 m wide, 25.8 m tall
//
//   tx(-125.16) = 0    tx(-125.09) = 199
//   ty(48.855)  = 0    ty(48.815)  = 172
//
// Key tiles (verified):
//   Main inlet centre   (lon-125.133) → x  77
//   East Bamfield road  (lon-125.127) → x  88  ← road runs here N↓S
//   BMSC / Grappler end (lon-125.107) → x 151
//   Road NE entry       (lon-125.092) → x 193, lat 48.852 → y 13
//   Grappler lat 48.832 → y  99
//   Barkley Sound open  (lat 48.818) → y 161
//   Brady's Beach water (lon-125.155) → x  14   (lat 48.822) → y 142
// ─────────────────────────────────────────────────────────────────────────────
function generateBamfield() {
  const W=200, H=173;
  const lonMin=-125.16, latMax=48.855, lonSpan=0.07, latSpan=0.040;
  const tx = lon => Math.min(W-1,Math.max(0,Math.round((lon-lonMin)/lonSpan*(W-1))));
  const ty = lat => Math.min(H-1,Math.max(0,Math.round((latMax-lat)/latSpan*(H-1))));
  const p  = (lon,lat)=>({x:tx(lon),y:ty(lat)});

  const g = makeGrid(W,H);

  // ── Main Bamfield Inlet ──────────────────────────────────────────────────
  // A narrow tidal fjord.  West bank lon ≈ -125.136, east bank ≈ -125.129.
  // Widens at south end where it opens into Barkley Sound.
  fillPoly(g, [
    p(-125.136,48.855), p(-125.129,48.855),  // top
    p(-125.128,48.843),                       // east bank curves slightly E
    p(-125.127,48.833),                       // near Grappler junction
    p(-125.125,48.824),                       // Port Desire shoulder
    p(-125.122,48.818),                       // opening into Barkley Sound
    p(-125.140,48.818),                       // SW shore, Barkley Sound
    p(-125.140,48.824),                       // west bank widens
    p(-125.138,48.833),                       // west bank near Grappler
    p(-125.137,48.843),                       // west bank
  ], T.Water);

  // ── Grappler Inlet (branches E from main inlet at lat 48.832) ────────────
  // Real width ≈ 120 m = 5 tiles; length ≈ 1.4 km = 55 tiles.
  rect(g, tx(-125.138),97, tx(-125.107),103, T.Water);

  // ── Port Desire (small sheltered bay, east side) ─────────────────────────
  fillPoly(g, [
    p(-125.127,48.830), p(-125.116,48.829), p(-125.114,48.824),
    p(-125.120,48.822), p(-125.126,48.824),
  ], T.Water);

  // ── Brady's Beach & Pacific coast (west) ────────────────────────────────
  // The entire west coast is Pacific Ocean south of about lat 48.840.
  // Brady's Beach is a half-moon bay facing SW (lat 48.820-48.827).
  rect(g, 0,0, tx(-125.153),ty(48.820), T.Water);     // open Pacific west coast
  fillPoly(g, [
    p(-125.160,48.828), p(-125.147,48.827), p(-125.146,48.820),
    p(-125.160,48.820),
  ], T.Water);
  // Sandy backing behind Brady's beach:
  rect(g, tx(-125.150),ty(48.830), tx(-125.142),ty(48.820), T.Sand);

  // ── Barkley Sound / Trevor Channel (open ocean, south) ──────────────────
  rect(g, 0,ty(48.818), W-1,H-1, T.Water);

  // ── Connect all ocean via flood-fill from SW corner ──────────────────────
  floodFill(g, 0,H-1, T.Grass,T.Water);

  // ── Shoreline sand ───────────────────────────────────────────────────────
  beachify(g);

  // ── Preliminary roads (for landcover BFS) ────────────────────────────────
  const roadX = tx(-125.127); // Bamfield Main (N-S, East bank)
  hLine(g, tx(-125.092),roadX,  ty(48.852), T.Road);  // highway from NE
  vLine(g, roadX, ty(48.852), ty(48.820),   T.Road);  // main road S
  hLine(g, roadX,tx(-125.116), ty(48.838),  T.Road);  // Gov't Wharf spur
  hLine(g, roadX,roadX+5,      ty(48.831),  T.Road);  // gas bar spur

  // ── Landcover (forest/hill/rock by BFS distance from water/roads) ────────
  // Pre-clear community strips so they stay grassland after BFS.
  clearBox(g, tx(-125.149),ty(48.851), tx(-125.136),ty(48.819)); // W.Bamfield strip
  clearBox(g, tx(-125.133),ty(48.854), tx(-125.112),ty(48.818)); // E.Bamfield strip
  // Trail linking the two communities (grassy, single-track through forest):
  for (let x=tx(-125.149);x<=tx(-125.133);x++) {
    const y=ty(48.851)+Math.round(2*Math.sin(x*0.4));
    set(g,x,y,T.Grass); set(g,x,y+1,T.Grass);
  }

  applyLandcover(g);

  // ── Roads (on top of landcover) ──────────────────────────────────────────
  hLine(g, tx(-125.092),roadX,  ty(48.852), T.Road);
  vLine(g, roadX, ty(48.852), ty(48.820),   T.Road);
  hLine(g, roadX,tx(-125.116), ty(48.838),  T.Road);
  hLine(g, roadX,roadX+5,      ty(48.831),  T.Road);
  hLine(g, roadX,roadX+4,      ty(48.826),  T.Road);  // Port Desire spur

  // ── Docks ────────────────────────────────────────────────────────────────
  // West Bamfield boardwalk: finger piers from x≈65 east into the inlet.
  const wbX = tx(-125.137);
  for (const lat of [48.847,48.842,48.837,48.832,48.827]) {
    const y=ty(lat); hLine(g, wbX-6,wbX, y, T.Dock);
  }
  // Government Wharf (extends W from road):
  const wharfY=ty(48.838);
  rect(g, tx(-125.121),wharfY-1, tx(-125.117),wharfY+2, T.Dock);
  // BMSC dock at east end of Grappler:
  rect(g, tx(-125.111),100, tx(-125.108),103, T.Dock);

  // ── Buildings ────────────────────────────────────────────────────────────
  const blds=[];
  let bi=0;
  const bld=(kind,lon,lat,w,h,hp=100,id=null)=>
    blds.push({id:id??`bf-${bi++}`,kind,x:tx(lon),y:ty(lat),w,h,hp,maxHp:hp});

  // East Bamfield, N→S along the road:
  bld("house",   -125.122,48.849, 4,3);
  bld("house",   -125.121,48.845, 4,3);
  bld("house",   -125.120,48.841, 4,3);
  bld("shop",    -125.119,48.837, 6,4, 250, "bf-shop-market"); // general store
  bld("house",   -125.120,48.833, 4,3);
  bld("shop",    -125.119,48.831, 4,3, 200, "bf-shop-ostroms"); // gas bar/metal
  bld("house",   -125.118,48.825, 4,3);
  bld("dock",    -125.120,48.839, 5,3);       // Gov't Wharf terminal
  // BMSC (research centre — shop so players can sell/buy):
  bld("shop",    -125.111,48.833, 12,7, 500, "bf-shop-bmsc");
  bld("boathouse",-125.107,48.832,  6,4, 200);
  // West Bamfield boardwalk houses:
  bld("house",   -125.143,48.847, 3,3);
  bld("house",   -125.143,48.842, 3,3);
  bld("house",   -125.143,48.837, 3,3);
  bld("house",   -125.143,48.832, 3,3);
  bld("shop",    -125.143,48.827, 4,3, 160, "bf-shop-breakers"); // Breakers

  // ── Spawn: East Bamfield near market ────────────────────────────────────
  const spawn={x:roadX+2, y:ty(48.837)};

  // ── Vehicles ─────────────────────────────────────────────────────────────
  const vehicles=[];
  const carN=nearestTile(g, roadX, ty(48.848), T.Road);
  const carS=nearestTile(g, roadX, ty(48.826), T.Road);
  const boatInlet=nearestTile(g, tx(-125.132), ty(48.840), T.Water);
  const boatWharf=nearestTile(g, tx(-125.122), ty(48.838), T.Water);
  const boatGrap =nearestTile(g, tx(-125.111), 101,        T.Water);
  if (carN)      vehicles.push({id:"bf-car-1", kind:"car",  x:carN.x,      y:carN.y});
  if (carS)      vehicles.push({id:"bf-car-2", kind:"car",  x:carS.x,      y:carS.y});
  if (boatInlet) vehicles.push({id:"bf-boat-1",kind:"boat", x:boatInlet.x, y:boatInlet.y});
  if (boatWharf) vehicles.push({id:"bf-boat-2",kind:"boat", x:boatWharf.x, y:boatWharf.y});
  if (boatGrap)  vehicles.push({id:"bf-boat-3",kind:"boat", x:boatGrap.x,  y:boatGrap.y});

  // ── Resources + invasives ───────────────────────────────────────────────
  const {nodes:resourceNodes,plants}=autoResources(g,"bamfield");
  // Arbutus trees on rocky west-coast headlands:
  resourceNodes.push(
    {id:"bf-arb1",kind:"tree",x:tx(-125.155),y:ty(48.830),variety:"arbutus"},
    {id:"bf-arb2",kind:"tree",x:tx(-125.154),y:ty(48.824),variety:"arbutus"},
    {id:"bf-arb3",kind:"tree",x:tx(-125.148),y:ty(48.850),variety:"arbutus"},
  );

  return {
    id:"bamfield", name:"Bamfield",
    width:W, height:H,
    tiles:Array.from(g.t),
    buildings:blds, spawn,
    travelNodes:[],   // derived at runtime by applyImported → deriveTravelNodes
    vehicles, resourceNodes, plants,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANACLA / PACHENA BAY   grid 200×177   bbox 48.785 S, -125.13 W → 48.820 N, -125.07 E
// ─────────────────────────────────────────────────────────────────────────────
// Scale: 1 tile ≈ 22.2 m wide, 22.0 m tall
//
//   tx(-125.13) = 0    tx(-125.07) = 199
//   ty(48.820)  = 0    ty(48.785)  = 176
//
// Key tiles:
//   Bay head beach (lat 48.808)       → y  89
//   River mouth (lon -125.099)        → x 103   y  89
//   Bay mouth / ocean (lat 48.786)    → y 171
//   Road NE entry (lon -125.073,lat 48.818) → x 190  y  15
//   Lower Anacla village              → x 100-135  y  55-90
//   Upper Anacla bench (lon -125.087 to -125.076, lat 48.815-48.820) → x 143-180  y 0-35
// ─────────────────────────────────────────────────────────────────────────────
function generateAnacla() {
  const W=200, H=177;
  const lonMin=-125.13, latMax=48.820, lonSpan=0.06, latSpan=0.035;
  const tx = lon => Math.min(W-1,Math.max(0,Math.round((lon-lonMin)/lonSpan*(W-1))));
  const ty = lat => Math.min(H-1,Math.max(0,Math.round((latMax-lat)/latSpan*(H-1))));
  const p  = (lon,lat)=>({x:tx(lon),y:ty(lat)});

  const g = makeGrid(W,H);

  // ── Pachena Bay ───────────────────────────────────────────────────────────
  // A large south-facing bay.  Mouth opens roughly south.
  // Bay head is a broad sandy beach running E-W at lat ≈ 48.808.
  // East coast curves gently from NE; west coast from NW.
  fillPoly(g, [
    p(-125.120,48.815),   // NW beach end (where beach meets W coast)
    p(-125.108,48.808),   // W end of beach head
    p(-125.096,48.808),   // E end of beach head
    p(-125.090,48.812),   // NE bay corner (coast curves NE here)
    p(-125.086,48.787),   // SE bay mouth
    p(-125.130,48.787),   // SW bay mouth
    p(-125.126,48.810),   // W coast curving N
  ], T.Water);

  // ── Open Pacific west coast & south ocean ────────────────────────────────
  rect(g, 0,0, tx(-125.126),H-1, T.Water);          // west Pacific
  rect(g, 0,ty(48.788), W-1,H-1, T.Water);          // south open ocean
  floodFill(g, 0,H-1, T.Grass,T.Water);             // connect ocean

  // ── Pachena River (flows N→S into NE bay head) ───────────────────────────
  // Real river enters bay at approx lat 48.808, lon -125.099.
  const rxMouth=tx(-125.099), ryMouth=ty(48.808);
  for (let y=0; y<=ryMouth; y++) {
    const xc=rxMouth+Math.round(1.5*Math.sin(y*0.18));
    rect(g, xc-1,y, xc+1,y, T.Water);
  }

  // ── Shoreline sand ────────────────────────────────────────────────────────
  beachify(g);
  // Emphasise the long sandy bay-head beach:
  rect(g, tx(-125.120),ty(48.812), tx(-125.095),ty(48.806), T.Sand);

  // ── Upper Anacla bench (rocky Hill + Rock rim, no walking path up) ────────
  // The bench sits NE of the village, a steep cliff face.
  rect(g, tx(-125.088),ty(48.820), tx(-125.073),ty(48.812), T.Hill);
  // Rock outcrops rim the edge (makes it impassable as cliffs in gameplay):
  hLine(g, tx(-125.088),tx(-125.073), ty(48.812),  T.Rock); // south cliff edge
  vLine(g, tx(-125.088), ty(48.820), ty(48.812),   T.Rock); // west cliff edge

  // ── Community clearings (before landcover so BFS doesn't re-forest) ──────
  clearBox(g, tx(-125.108),ty(48.820), tx(-125.087),ty(48.808)); // Lower Anacla village
  clearBox(g, tx(-125.086),ty(48.820), tx(-125.073),ty(48.813)); // Upper Anacla bench top

  // ── Preliminary road for landcover BFS ────────────────────────────────────
  const roadX=tx(-125.099);
  // Road enters from NE (junction with Bamfield road) and runs into the village:
  drawLine(g, [p(-125.073,48.820),p(-125.099,48.815),p(-125.099,48.808)], T.Road, 1);

  applyLandcover(g);

  // ── Roads (final pass on top of landcover) ────────────────────────────────
  drawLine(g, [p(-125.073,48.820),p(-125.099,48.815),p(-125.099,48.808)], T.Road, 1);
  // Short spur west to gas bar:
  hLine(g, roadX-4,roadX, ty(48.812), T.Road);

  // ── Docks ─────────────────────────────────────────────────────────────────
  // Boat ramp / small pier at bay, south of village:
  rect(g, tx(-125.103),ty(48.810), tx(-125.100),ty(48.809), T.Dock);

  // ── Buildings ─────────────────────────────────────────────────────────────
  const blds=[];
  let bi=0;
  const bld=(kind,lon,lat,w,h,hp=100,id=null)=>
    blds.push({id:id??`an-${bi++}`,kind,x:tx(lon),y:ty(lat),w,h,hp,maxHp:hp});

  // Lower Anacla:
  bld("house",   -125.104,48.816, 4,3);
  bld("house",   -125.103,48.813, 4,3, 100, "an-house-food"); // sells home food
  bld("shop",    -125.101,48.812, 5,4, 150, "an-shop-gas");    // gas bar / food
  bld("house",   -125.096,48.814, 4,3);
  bld("house",   -125.094,48.811, 4,3);
  // Upper Anacla bench (Huu-ay-aht government centre + House of Huuayaht):
  bld("shop",    -125.083,48.817, 8,5, 300, "an-shop-gov");    // gov't/cultural

  // ── Spawn: top of road into Lower Anacla ─────────────────────────────────
  const spawn={x:roadX, y:ty(48.818)};

  // ── Vehicles ─────────────────────────────────────────────────────────────
  const vehicles=[];
  const anCar =nearestTile(g, roadX, ty(48.814), T.Road);
  const anBoat=nearestTile(g, tx(-125.101), ty(48.806), T.Water);  // in the bay
  const anBoat2=nearestTile(g, tx(-125.105), ty(48.800), T.Water);
  if (anCar)  vehicles.push({id:"an-car-1", kind:"car",  x:anCar.x,  y:anCar.y});
  if (anBoat) vehicles.push({id:"an-boat-1",kind:"boat", x:anBoat.x, y:anBoat.y});
  if (anBoat2)vehicles.push({id:"an-boat-2",kind:"boat", x:anBoat2.x,y:anBoat2.y});

  // ── Resources + invasives ─────────────────────────────────────────────────
  const {nodes:resourceNodes,plants}=autoResources(g,"anacla");
  resourceNodes.push(
    {id:"an-bench-s1",kind:"stoneOre",x:tx(-125.082),y:ty(48.816)},
    {id:"an-bench-i1",kind:"ironOre", x:tx(-125.080),y:ty(48.814)},
    {id:"an-arb1",    kind:"tree",    x:tx(-125.123),y:ty(48.814), variety:"arbutus"},
    {id:"an-arb2",    kind:"tree",    x:tx(-125.090),y:ty(48.812), variety:"arbutus"},
  );

  return {
    id:"anacla", name:"Anacla / Pachena Bay",
    width:W, height:H,
    tiles:Array.from(g.t),
    buildings:blds, spawn,
    travelNodes:[],
    vehicles, resourceNodes, plants,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write output
// ─────────────────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, {recursive:true});

const bf = generateBamfield();
const an = generateAnacla();

writeFileSync(join(OUT_DIR,"bamfield.json"), JSON.stringify(bf));
writeFileSync(join(OUT_DIR,"anacla.json"),   JSON.stringify(an));

console.log(`✓ bamfield.json  ${bf.width}×${bf.height}  ${bf.buildings.length} buildings  ${bf.resourceNodes.length} resources`);
console.log(`✓ anacla.json    ${an.width}×${an.height}  ${an.buildings.length} buildings  ${an.resourceNodes.length} resources`);

// Update shared/regions/index.ts
const idx = `// AUTO-GENERATED by tools/generate-bamfield.mjs — do not edit by hand.
import type { RegionData } from "../map";
import bamfieldData from "./bamfield.json";
import anaclaData   from "./anacla.json";

export const IMPORTED_REGIONS: RegionData[] = [
  bamfieldData as unknown as RegionData,
  anaclaData   as unknown as RegionData,
];
`;
writeFileSync(join(OUT_DIR,"index.ts"), idx);
console.log("✓ shared/regions/index.ts updated");
console.log("\nNext: npm run dev  — then walk around and note anything to tweak.");

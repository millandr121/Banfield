// Fix the eastern + northern flooding.
//
// PROBLEM: The entire north border row (y=0) is water, creating a water highway
// from the real Pacific (x=0) all the way to the east border. Any BFS from x=0
// floods across y=0 and then down into the eastern inland forest.
//
// SOLUTION:
//   1. Temporarily wall off the top 30 rows at x > 1300 (Cape Beale peninsula+)
//      and the entire east border column — breaking the water highway.
//   2. BFS true-ocean flood from x=0 (west border).
//   3. Restore the temporarily-walled tiles (now classified correctly as inland).
//   4. Reclaim inland water as land/FreshWater.
//   5. Restore Pachena Lake (lost by earlier over-zealous repair).
import fs from "fs";
const T = { Water:0, Sand:1, Grass:2, Forest:3, Hill:4, Rock:5, Road:6, Dock:7, FreshWater:8 };
const TEMP = 99; // sentinel — used only during computation, never written to file
const path = "shared/regions/bamfield.json";
const d = JSON.parse(fs.readFileSync(path));
const W = d.width, H = d.height, N = W*H;
const t = d.tiles;

// ─── Step 1. Temporarily seal the northern water highway east of Cape Beale
//             and the east border strip.
//  x > 1300 at y < 35:  open ocean transitions to Cape Beale land here
//  x > 3200:             east border is flooded inland
const NORTH_X_CUT = 1300; // east of here, north rows should be land
const NORTH_Y_CUT = 35;   // rows 0..34 form the highway
const EAST_X_CUT  = 3200; // columns 3200+ are edge-flooded land

const sealed = []; // [index, originalTile] to restore later
for (let y = 0; y < NORTH_Y_CUT; y++) {
  for (let x = NORTH_X_CUT; x < W; x++) {
    const i = y*W+x;
    if (t[i] === T.Water) { sealed.push([i, T.Water]); t[i] = TEMP; }
  }
}
for (let y = 0; y < H; y++) {
  for (let x = EAST_X_CUT; x < W; x++) {
    const i = y*W+x;
    if (t[i] === T.Water) { sealed.push([i, T.Water]); t[i] = TEMP; }
  }
}
console.log(`Sealed ${sealed.length} tiles for BFS isolation`);

// ─── Step 2. BFS true-ocean from the WEST border (x=0).
const ocean = new Uint8Array(N);
const stack = [];
for (let y = 0; y < H; y++) {
  const i = y*W;
  if (t[i] === T.Water && !ocean[i]) { ocean[i]=1; stack.push(i); }
}
let head = 0;
while (head < stack.length) {
  const i = stack[head++];
  const x = i%W, y = (i/W)|0;
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx=x+dx, ny=y+dy;
    if (nx<0||ny<0||nx>=W||ny>=H) continue;
    const ni = ny*W+nx;
    if (!ocean[ni] && t[ni]===T.Water) { ocean[ni]=1; stack.push(ni); }
  }
}
const trueOceanCount = stack.length;

// ─── Step 3. Restore the sealed tiles. Those reached by BFS = real ocean;
//             those not reached = inland flooded water (will be reclaimed).
for (const [i, orig] of sealed) t[i] = orig;

// ─── Step 4. Reclaim non-ocean enclosed water as land or FreshWater.
const seen = new Uint8Array(N);
let reclaimed=0, lakes=0;
for (let i = 0; i < N; i++) {
  if (t[i] !== T.Water || ocean[i] || seen[i]) continue;
  const comp = []; const st = [i]; seen[i]=1; let hasRoadAdj=false;
  while (st.length) {
    const j = st.pop(); comp.push(j);
    const x=j%W, y=(j/W)|0;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H) continue;
      const nj=ny*W+nx;
      if (t[nj]===T.Road) hasRoadAdj=true;
      if (t[nj]===T.Water && !ocean[nj] && !seen[nj]) { seen[nj]=1; st.push(nj); }
    }
  }
  if (comp.length < 12) {
    for (const j of comp) t[j] = T.Forest;
    reclaimed += comp.length;
  } else if (comp.length < 6000 && !hasRoadAdj) {
    // Genuine inland lake (no direct road-tile neighbour, reasonable size)
    for (const j of comp) t[j] = T.FreshWater;
    lakes += comp.length;
  } else {
    // Large or road-adjacent inland flood → land
    for (const j of comp) t[j] = T.Grass;
    reclaimed += comp.length;
  }
}

// ─── Step 5. Restore Pachena Lake.
// The real Pachena Lake is ~2 km long, positioned west of the Pachena Road.
// Approximate tile position: centred ~x=2220, y=2620, radius ~160×120 tiles.
const LAKE_CX=2220, LAKE_CY=2620, LAKE_RX=160, LAKE_RY=120;
let lakeRestored=0;
for (let y=LAKE_CY-LAKE_RY-5;y<=LAKE_CY+LAKE_RY+5;y++) {
  for (let x=LAKE_CX-LAKE_RX-5;x<=LAKE_CX+LAKE_RX+5;x++) {
    if (x<0||y<0||x>=W||y>=H) continue;
    const dx=(x-LAKE_CX)/LAKE_RX, dy=(y-LAKE_CY)/LAKE_RY;
    if (dx*dx+dy*dy>1.0) continue;
    const i=y*W+x;
    if (t[i]===T.Forest||t[i]===T.Grass||t[i]===T.Hill) {
      t[i]=T.FreshWater; lakeRestored++;
    }
  }
}

// ─── Step 6. Blend newly-Grass tiles → Forest in the back-country.
let forested=0;
const snapshot=t.slice();
function nearWater(x,y,r){
  for(let dy=-r;dy<=r;dy++){const yy=y+dy;if(yy<0||yy>=H)continue;
    for(let dx2=-r;dx2<=r;dx2++){const xx=x+dx2;if(xx<0||xx>=W)continue;
      const tt=snapshot[yy*W+xx];if(tt===T.Water||tt===T.FreshWater||tt===T.Sand)return true;}}
  return false;
}
for (let i=0;i<N;i++){
  if(snapshot[i]!==T.Grass)continue;
  const x=i%W,y=(i/W)|0;
  if(!nearWater(x,y,3)){t[i]=T.Forest;forested++;}
}

console.log(`True ocean tiles: ${trueOceanCount}`);
console.log(`Inland water reclaimed→land: ${reclaimed}`);
console.log(`Inland lakes kept as FreshWater: ${lakes}`);
console.log(`Pachena Lake restored: ${lakeRestored}`);
console.log(`Grass→Forest: ${forested}`);
fs.writeFileSync(path, JSON.stringify(d));
console.log("Written:", path);

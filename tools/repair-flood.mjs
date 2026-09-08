// One-off repair for shared/regions/bamfield.json:
// The ocean flood leaked past the map edges into land that extends beyond the
// bbox (the whole east side read as water though roads + sand coastline show).
// We can't re-import (the .osm export isn't in this container), so we repair the
// baked tile grid directly:
//   1. Seal hairline gaps in the sand coastline (mask only).
//   2. Flood the TRUE ocean from road-free border seeds, bounded by that sealed
//      coastline + the map border treated as a wall (so it can't crawl the edge
//      into a land basin).
//   3. Any water NOT in the ocean that carries the road network = flooded land
//      → reclaim to forest/grass. Small road-free pools stay as inland lakes.
import fs from "fs";
const T = { Water:0, Sand:1, Grass:2, Forest:3, Hill:4, Rock:5, Road:6, Dock:7, FreshWater:8 };
const path = "shared/regions/bamfield.json";
const d = JSON.parse(fs.readFileSync(path));
const W = d.width, H = d.height, N = W*H;
const t = d.tiles;
const idx = (x,y)=>y*W+x;

// --- 1. wall mask: solid coast/land, plus a grown halo into water to seal gaps.
const CLOSE = 4;
const wall = new Uint8Array(N);          // bounds the ocean flood
for (let i=0;i<N;i++) if (t[i]!==T.Water && t[i]!==T.Road) wall[i]=1;
// Grow the wall into adjacent water CLOSE times (closes ≤2*CLOSE-wide cracks).
let frontier=[];
for (let i=0;i<N;i++) if (wall[i]) frontier.push(i);
for (let s=0;s<CLOSE;s++){
  const next=[];
  for (const i of frontier){
    const x=i%W, y=(i/W)|0;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx=x+dx, ny=y+dy;
      if (nx<0||ny<0||nx>=W||ny>=H) continue;
      const ni=ny*W+nx;
      if (!wall[ni] && t[ni]===T.Water){ wall[ni]=2; next.push(ni); } // 2 = grown
    }
  }
  frontier=next;
}

// --- distance-to-nearest-road (cap small) so we can pick road-free ocean seeds.
const roadDist = new Int32Array(N).fill(-1);
let rq=[];
for (let i=0;i<N;i++) if (t[i]===T.Road){ roadDist[i]=0; rq.push(i); }
const CAP=60;
let head=0;
while(head<rq.length){
  const i=rq[head++]; const x=i%W,y=(i/W)|0; const dd=roadDist[i];
  if (dd>=CAP) continue;
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const nx=x+dx,ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H)continue;
    const ni=ny*W+nx; if(roadDist[ni]===-1){roadDist[ni]=dd+1; rq.push(ni);}
  }
}
const roadFree = (i)=> roadDist[i]===-1 || roadDist[i]>=40;

// --- 2. ocean basin: flood from road-free border water, bounded by wall.
//        Border is NOT a wall for ocean (Pacific sits on it), but a land basin's
//        border water is road-near so it's never chosen as a seed.
const ocean = new Uint8Array(N);
const stack=[];
const seed=(x,y)=>{ const i=idx(x,y); if(!ocean[i] && t[i]===T.Water && !wall[i] && roadFree(i)){ocean[i]=1; stack.push(i);} };
for (let x=0;x<W;x++){ seed(x,0); seed(x,H-1); }
for (let y=0;y<H;y++){ seed(0,y); seed(W-1,y); }
while(stack.length){
  const i=stack.pop(); const x=i%W,y=(i/W)|0;
  for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const nx=x+dx,ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H)continue;
    const ni=ny*W+nx;
    if(!ocean[ni] && t[ni]===T.Water && !wall[ni]){ ocean[ni]=1; stack.push(ni); }
  }
}

// --- 3. components of non-ocean water; reclaim those carrying roads.
const seen=new Uint8Array(N);
let reclaimed=0, lakes=0, oceanCount=0;
for (let i=0;i<N;i++) if (ocean[i]) oceanCount++;
for (let i=0;i<N;i++){
  if (t[i]!==T.Water || ocean[i] || seen[i]) continue;
  // BFS this enclosed water component
  const comp=[]; const st=[i]; seen[i]=1; let hasRoad=false;
  while(st.length){
    const j=st.pop(); comp.push(j); const x=j%W,y=(j/W)|0;
    for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx=x+dx,ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H)continue;
      const nj=ny*W+nx;
      if (t[nj]===T.Road) hasRoad=true;
      if (t[nj]===T.Water && !ocean[nj] && !seen[nj]){ seen[nj]=1; st.push(nj); }
    }
  }
  // Reclaim flooded land: a road-laced component, or a big one (>4000 tiles).
  if (hasRoad || comp.length>4000){
    for (const j of comp){ t[j]=T.Grass; reclaimed++; }
  } else {
    // A genuine enclosed, road-free water body = an inland FRESH-water lake.
    // (Tiny artifacts under ~12 tiles are just rasterizer speckle — drop them
    // back to land so we don't pepper the forest with puddles.)
    if (comp.length >= 12){ for (const j of comp){ t[j]=T.FreshWater; } lakes += comp.length; }
    else { for (const j of comp){ t[j]=T.Grass; } }
  }
}

// --- 4. Blend reclaimed land: a newly-Grass tile with no Water within ~3 tiles
//        becomes Forest (the back-country is rainforest); a grass/beach fringe
//        is left along the new shorelines. Original town grass hugs the water so
//        it's preserved.
let forested=0;
const snapshot = t.slice();
const waterNear = (x,y,r)=>{
  for (let dy=-r;dy<=r;dy++){ const yy=y+dy; if(yy<0||yy>=H) continue;
    for (let dx=-r;dx<=r;dx++){ const xx=x+dx; if(xx<0||xx>=W) continue;
      const tt=snapshot[yy*W+xx]; if(tt===T.Water||tt===T.FreshWater) return true; } }
  return false;
};
for (let i=0;i<N;i++){
  if (snapshot[i]!==T.Grass) continue;
  const x=i%W, y=(i/W)|0;
  if (!waterNear(x,y,3)){ t[i]=T.Forest; forested++; }
}

console.log(`ocean=${oceanCount}  reclaimed=${reclaimed}  forested=${forested}  inland-lake water kept=${lakes}`);
fs.writeFileSync(path, JSON.stringify(d));
console.log("wrote", path);

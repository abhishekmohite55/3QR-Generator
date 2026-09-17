function polyArea2D(pts){
  let a=0; for(let i=0;i<pts.length;i++){
    const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%pts.length];
    a += x1*y2 - x2*y1;
  }
  return a/2;
}
function ensureCCW(pts){ return polyArea2D(pts) < 0 ? pts.slice().reverse() : pts.slice(); }
function ensureCW(pts){ return polyArea2D(pts) > 0 ? pts.slice().reverse() : pts.slice(); }
function sign(p1,p2,p3){ return (p1[0]-p3[0])*(p2[1]-p3[1]) - (p2[0]-p3[0])*(p1[1]-p3[1]); }
function pointInTriangle(p,a,b,c){
  const d1=sign(p,a,b), d2=sign(p,b,c), d3=sign(p,c,a);
  const hasNeg=(d1<0)||(d2<0)||(d3<0), hasPos=(d1>0)||(d2>0)||(d3>0);
  return !(hasNeg && hasPos);
}
function earClip(pts){
  const n=pts.length; if(n<3) return [];
  const idx=pts.map((_,i)=>i); const tris=[]; let guard=0;
  while(idx.length>3 && guard<20000){
    guard++; let earFound=false;
    for(let i=0;i<idx.length;i++){
      const i0=idx[(i-1+idx.length)%idx.length], i1=idx[i], i2=idx[(i+1)%idx.length];
      const a=pts[i0], b=pts[i1], c=pts[i2];
      const cross=(b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
      if(cross<=1e-9) continue;
      let contains=false;
      for(const j of idx){
        if(j===i0||j===i1||j===i2) continue;
        if(pointInTriangle(pts[j],a,b,c)){ contains=true; break; }
      }
      if(contains) continue;
      tris.push([i0,i1,i2]); idx.splice(i,1); earFound=true; break;
    }
    if(!earFound) break;
  }
  if(idx.length===3) tris.push([idx[0],idx[1],idx[2]]);
  return tris;
}
function rectPoly(x0,y0,x1,y1){ return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]; }
function circlePoly(cx,cy,r,segments){
  const pts=[]; for(let i=0;i<segments;i++){ const a=(i/segments)*Math.PI*2; pts.push([cx+r*Math.cos(a), cy+r*Math.sin(a)]); }
  return pts;
}

function extrudeWalls(loop,z0,z1,outward){
  const verts=[], tris=[], n=loop.length;
  for(const [x,y] of loop) verts.push([x,y,z0]);
  for(const [x,y] of loop) verts.push([x,y,z1]);
  for(let i=0;i<n;i++){
    const a=i, b=(i+1)%n, aTop=i+n, bTop=((i+1)%n)+n;
    if(outward){ tris.push([a,b,bTop]); tris.push([a,bTop,aTop]); }
    else { tris.push([a,bTop,b]); tris.push([a,aTop,bTop]); }
  }
  return {verts,tris};
}

function capPolygon(loop,z,facingUp){
  const pts=loop.map(([x,y])=>[x,y]);
  const ccw=ensureCCW(pts); const idxTris=earClip(ccw);
  const verts=ccw.map(([x,y])=>[x,y,z]);
  const tris=idxTris.map(([a,b,c])=> facingUp?[a,b,c]:[a,c,b]);
  return {verts,tris};
}

function mergeMeshes(meshes){
  const verts=[], tris=[];
  for(const m of meshes){
    const offset=verts.length;
    for(const v of m.verts) verts.push(v);
    for(const t of m.tris) tris.push([t[0]+offset,t[1]+offset,t[2]+offset]);
  }
  return {verts,tris};
}

self.onmessage = function(e){
  const p = e.data;
  const startTime = performance.now();

  const outer = rectPoly(0,0,p.blockL,p.blockW);
  const cx = p.blockL/2, cy = p.blockW/2;
  let z = 0;

  // Calculate Heights & Levels
  const baseFloorZ = p.baseFloorH > 0 ? p.baseFloorH : 0;
  z = baseFloorZ;
  const magnetPauseZ = z;
  const magnetCapZ = z + p.magT;
  z = magnetCapZ + p.gap1;
  const nfcPauseZ = z;

  const nfcT = p.nfcShape==='circ' ? p.nfcT2 : p.nfcT;
  const nfcCapZ = z + nfcT;
  z = nfcCapZ + p.capFill;
  const qrSurfaceZ = z;

  // Pocket Geometries
  const mL = p.magL + p.clearance*2, mW = p.magW + p.clearance*2;
  const magHole = rectPoly(cx-mL/2, cy-mW/2, cx+mL/2, cy+mW/2);

  let nfcHole;
  if(p.nfcShape === 'circ'){
    const r = p.nfcR + p.clearance;
    nfcHole = circlePoly(cx, cy, r, 48);
  } else {
    const nL = p.nfcL + p.clearance*2, nW = p.nfcW + p.clearance*2;
    nfcHole = rectPoly(cx-nL/2, cy-nW/2, cx+nL/2, cy+nW/2);
  }

  // SEAMLESS SOLID BODY BUILDING (Continuous Outer Shell)
  const bodyComponents = [];

  // 1. Single Continuous Outer Vertical Wall (Z=0 to Z=qrSurfaceZ)
  bodyComponents.push(extrudeWalls(outer, 0, qrSurfaceZ, true));

  // 2. Bottom Cap Polygon (Z=0 facing down)
  bodyComponents.push(capPolygon(outer, 0, false));

  // 3. Top Surface Cap Polygon (Z=qrSurfaceZ facing up)
  bodyComponents.push(capPolygon(outer, qrSurfaceZ, true));

  // 4. Internal Magnet Pocket Surfaces
  bodyComponents.push(capPolygon(magHole, magnetPauseZ, true));  // Magnet Floor
  bodyComponents.push(capPolygon(magHole, magnetCapZ, false));   // Magnet Ceiling
  bodyComponents.push(extrudeWalls(magHole, magnetPauseZ, magnetCapZ, false)); // Magnet Inner Cavity Walls

  // 5. Internal NFC Pocket Surfaces
  bodyComponents.push(capPolygon(nfcHole, nfcPauseZ, true));   // NFC Floor
  bodyComponents.push(capPolygon(nfcHole, nfcCapZ, false));    // NFC Ceiling
  bodyComponents.push(extrudeWalls(nfcHole, nfcPauseZ, nfcCapZ, false)); // NFC Cavity Walls

  // Merge Body Mesh
  const mergedBlack = mergeMeshes(bodyComponents);

  // 6. Batched White QR Relief Pillars
  const qrGrid = p.qrGrid;
  let lightPillarCount = 0;
  if(qrGrid){
    for(let r=0; r<qrGrid.length; r++){
      for(let c=0; c<qrGrid[r].length; c++){
        if(!qrGrid[r][c]) lightPillarCount++;
      }
    }
  }

  const whiteVerts = new Float32Array(lightPillarCount * 8 * 3);
  const whiteTris = new Uint32Array(lightPillarCount * 12 * 3);

  let qrModuleSize = 0;
  if(qrGrid && lightPillarCount > 0){
    const n = qrGrid.length;
    const quiet = 4;
    const span = n + quiet*2;
    qrModuleSize = Math.min(p.blockL, p.blockW) / span;
    const qrPixels = qrModuleSize * span;
    const qrOriginX = cx - qrPixels/2 + quiet*qrModuleSize;
    const qrOriginY = cy - qrPixels/2 + quiet*qrModuleSize;
    const shrink = qrModuleSize * 0.04;

    let vIdx = 0, tIdx = 0, pillarIdx = 0;
    const z0 = qrSurfaceZ, z1 = qrSurfaceZ + p.qrReliefH;

    for(let r=0; r<n; r++){
      for(let c=0; c<n; c++){
        if(qrGrid[r][c]) continue;

        const x0 = qrOriginX + c*qrModuleSize + shrink/2;
        const y0 = qrOriginY + (n-1-r)*qrModuleSize + shrink/2;
        const x1 = x0 + qrModuleSize - shrink;
        const y1 = y0 + qrModuleSize - shrink;

        const baseV = pillarIdx * 8;
        whiteVerts[vIdx++]=x0; whiteVerts[vIdx++]=y0; whiteVerts[vIdx++]=z0;
        whiteVerts[vIdx++]=x1; whiteVerts[vIdx++]=y0; whiteVerts[vIdx++]=z0;
        whiteVerts[vIdx++]=x1; whiteVerts[vIdx++]=y1; whiteVerts[vIdx++]=z0;
        whiteVerts[vIdx++]=x0; whiteVerts[vIdx++]=y1; whiteVerts[vIdx++]=z0;
        whiteVerts[vIdx++]=x0; whiteVerts[vIdx++]=y0; whiteVerts[vIdx++]=z1;
        whiteVerts[vIdx++]=x1; whiteVerts[vIdx++]=y0; whiteVerts[vIdx++]=z1;
        whiteVerts[vIdx++]=x1; whiteVerts[vIdx++]=y1; whiteVerts[vIdx++]=z1;
        whiteVerts[vIdx++]=x0; whiteVerts[vIdx++]=y1; whiteVerts[vIdx++]=z1;

        const boxTris = [
          [0,2,1],[0,3,2],[4,5,6],[4,6,7],
          [0,1,5],[0,5,4],[1,2,6],[1,6,5],
          [2,3,7],[2,7,6],[3,0,4],[3,4,7]
        ];
        for(const [a,b,cIdx] of boxTris){
          whiteTris[tIdx++] = baseV + a;
          whiteTris[tIdx++] = baseV + b;
          whiteTris[tIdx++] = baseV + cIdx;
        }
        pillarIdx++;
      }
    }
  }

  const totalHeight = qrSurfaceZ + p.qrReliefH;

  const blackVerts = new Float32Array(mergedBlack.verts.length * 3);
  for(let i=0; i<mergedBlack.verts.length; i++){
    blackVerts[i*3] = mergedBlack.verts[i][0];
    blackVerts[i*3+1] = mergedBlack.verts[i][1];
    blackVerts[i*3+2] = mergedBlack.verts[i][2];
  }
  const blackTris = new Uint32Array(mergedBlack.tris.length * 3);
  for(let i=0; i<mergedBlack.tris.length; i++){
    blackTris[i*3] = mergedBlack.tris[i][0];
    blackTris[i*3+1] = mergedBlack.tris[i][1];
    blackTris[i*3+2] = mergedBlack.tris[i][2];
  }

  const buildTime = (performance.now() - startTime).toFixed(1);

  const schedule = [
    {z: magnetPauseZ, kind:'insert', label:'Pause — Insert Magnet Sheet', detail:`Pocket floor at Z=${magnetPauseZ.toFixed(2)}mm. Insert ${p.magL}×${p.magW}×${p.magT}mm sheet.`},
    {z: magnetCapZ, kind:'info', label:'Magnet Pocket Sealed', detail:`Print closes over magnet at Z=${magnetCapZ.toFixed(2)}mm.`},
    {z: nfcPauseZ, kind:'insert', label:'Pause — Insert NFC Tag', detail:`Pocket floor at Z=${nfcPauseZ.toFixed(2)}mm. Insert NFC tag.`},
    {z: nfcCapZ, kind:'info', label:'NFC Pocket Sealed', detail:`Print closes over NFC tag at Z=${nfcCapZ.toFixed(2)}mm.`},
    {z: qrSurfaceZ, kind:'filament', label:'Filament Change — Black → White', detail:`Swap to white filament for QR relief at Z=${qrSurfaceZ.toFixed(2)}mm.`},
  ];

  self.postMessage({
    blackVerts, blackTris,
    whiteVerts, whiteTris,
    totalHeight,
    magnetPauseZ, magnetCapZ, nfcPauseZ, nfcCapZ, qrSurfaceZ,
    schedule, buildTime
  }, [blackVerts.buffer, blackTris.buffer, whiteVerts.buffer, whiteTris.buffer]);
};

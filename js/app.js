let worker;
let scene, camera, renderer, blackMeshObj, whiteMeshObj, blackEdgesObj, whiteEdgesObj, topCapMeshObj, currentTarget=[0,0,0];
let clipPlane, slicerEnabled = true, showEdges = true, xrayEnabled = false;
let autoRotate = false, isPlayingAnimation = false, playInterval = null;

let camState = { theta: Math.PI*0.25, phi: Math.PI*0.35, dist: 160 };
let targetCamState = { theta: Math.PI*0.25, phi: Math.PI*0.35, dist: 160 };
let targetCurrentTarget = [0, 0, 0];

let lastStackData = null;
let currentLayer = 24, totalLayers = 24;

function workerFunction(){
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

    const bodyComponents = [];
    bodyComponents.push(extrudeWalls(outer, 0, qrSurfaceZ, true));
    bodyComponents.push(capPolygon(outer, 0, false));
    bodyComponents.push(capPolygon(outer, qrSurfaceZ, true));

    bodyComponents.push(capPolygon(magHole, magnetPauseZ, true));
    bodyComponents.push(capPolygon(magHole, magnetCapZ, false));
    bodyComponents.push(extrudeWalls(magHole, magnetPauseZ, magnetCapZ, false));

    bodyComponents.push(capPolygon(nfcHole, nfcPauseZ, true));
    bodyComponents.push(capPolygon(nfcHole, nfcCapZ, false));
    bodyComponents.push(extrudeWalls(nfcHole, nfcPauseZ, nfcCapZ, false));

    const mergedBlack = mergeMeshes(bodyComponents);

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
      {z: magnetPauseZ, kind:'insert', label:'Pause — Insert Magnet Sheet', detail:'Pocket floor at Z=' + magnetPauseZ.toFixed(2) + 'mm. Insert ' + p.magL + '×' + p.magW + '×' + p.magT + 'mm sheet.'},
      {z: magnetCapZ, kind:'info', label:'Magnet Pocket Sealed', detail:'Print closes over magnet at Z=' + magnetCapZ.toFixed(2) + 'mm.'},
      {z: nfcPauseZ, kind:'insert', label:'Pause — Insert NFC Tag', detail:'Pocket floor at Z=' + nfcPauseZ.toFixed(2) + 'mm. Insert NFC tag.'},
      {z: nfcCapZ, kind:'info', label:'NFC Pocket Sealed', detail:'Print closes over NFC tag at Z=' + nfcCapZ.toFixed(2) + 'mm.'},
      {z: qrSurfaceZ, kind:'filament', label:'Filament Change — Black → White', detail:'Swap to white filament for QR relief at Z=' + qrSurfaceZ.toFixed(2) + 'mm.'},
    ];

    self.postMessage({
      blackVerts, blackTris,
      whiteVerts, whiteTris,
      totalHeight,
      magnetPauseZ, magnetCapZ, nfcPauseZ, nfcCapZ, qrSurfaceZ,
      schedule, buildTime
    }, [blackVerts.buffer, blackTris.buffer, whiteVerts.buffer, whiteTris.buffer]);
  };
}

// Initialize Web Worker using Blob URL (Works 100% reliably under file:// and http://)
function initWorker(){
  const code = '(' + workerFunction.toString() + ')()';
  const blob = new Blob([code], {type: 'application/javascript'});
  worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = function(e){
    handleWorkerResult(e.data);
  };
}

// Synchronize Sliders and Inputs
function setupSynchronizedSliders(){
  const sliderPairs = [
    { num: 'blockL', range: 'blockL_slider' },
    { num: 'blockW', range: 'blockW_slider' },
    { num: 'wallMargin', range: 'wallMargin_slider' },
    { num: 'clearance', range: 'clearance_slider' },
    { num: 'baseFloorH', range: 'baseFloorH_slider' },
    { num: 'layerH', range: 'layerH_slider' },
    { num: 'magL', range: 'magL_slider' },
    { num: 'magW', range: 'magW_slider' },
    { num: 'magT', range: 'magT_slider' },
    { num: 'gap1', range: 'gap1_slider' },
    { num: 'nfcL', range: 'nfcL_slider' },
    { num: 'nfcW', range: 'nfcW_slider' },
    { num: 'nfcT', range: 'nfcT_slider' },
    { num: 'nfcR', range: 'nfcR_slider' },
    { num: 'nfcT2', range: 'nfcT2_slider' },
    { num: 'capFill', range: 'capFill_slider' },
    { num: 'qrReliefH', range: 'qrReliefH_slider' }
  ];

  sliderPairs.forEach(pair => {
    const numEl = document.getElementById(pair.num);
    const rangeEl = document.getElementById(pair.range);
    if(numEl && rangeEl){
      numEl.addEventListener('input', () => {
        rangeEl.value = numEl.value;
        triggerRegenerate();
      });
      rangeEl.addEventListener('input', () => {
        numEl.value = rangeEl.value;
        triggerRegenerate();
      });
    }
  });
}

// Initialize Three.js Engine with Studio Lighting & Grid Bed
function initViewer(){
  const wrap = document.getElementById('canvasWrap');
  if(!wrap) return;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, wrap.clientWidth/wrap.clientHeight, 0.1, 5000);
  
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  wrap.appendChild(renderer.domElement);

  // Prevent right-click context menu on 3D canvas
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

  clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 100);

  // STUDIO 3-POINT LIGHTING SETUP
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1); keyLight.position.set(80,120,100); keyLight.castShadow = true; scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xa5c5ff, 0.45); fillLight.position.set(-90,50,-80); scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.5); rimLight.position.set(0,80,-120); scene.add(rimLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  // TEXTURED BUILD PLATE GRID
  const grid = new THREE.GridHelper(300, 30, 0x0088ff, 0x2f3644);
  grid.position.y = -0.01; scene.add(grid);

  // RGB AXIS INDICATOR
  const axesHelper = new THREE.AxesHelper(30);
  axesHelper.position.set(-140, 0, -140);
  scene.add(axesHelper);

  // Smooth Orbit & Right-Click Panning Navigation
  let dragging = false, dragButton = 0, lastX = 0, lastY = 0;
  renderer.domElement.addEventListener('pointerdown', e => {
    dragging = true;
    dragButton = e.button;
    lastX = e.clientX;
    lastY = e.clientY;
    requestRender();
  });
  window.addEventListener('pointerup', () => dragging = false);
  window.addEventListener('pointermove', e => {
    if(!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;

    if(dragButton === 0){
      // Left Click -> Orbit Rotation
      targetCamState.theta -= dx * 0.007;
      targetCamState.phi = Math.max(0.05, Math.min(Math.PI - 0.05, targetCamState.phi - dy * 0.007));
      updateCubeRotation();
    } else if(dragButton === 2 || dragButton === 1){
      // Right Click or Middle Click -> Pan 3D Plane / Target
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();
      const panSpeed = camState.dist * 0.0012;

      targetCurrentTarget[0] -= (right.x * dx - up.x * dy) * panSpeed;
      targetCurrentTarget[1] -= (right.y * dx - up.y * dy) * panSpeed;
      targetCurrentTarget[2] -= (right.z * dx - up.z * dy) * panSpeed;
    }
    requestRender();
  });
  renderer.domElement.addEventListener('wheel', e => {
    e.preventDefault();
    targetCamState.dist = Math.max(20, Math.min(800, targetCamState.dist * (1 + e.deltaY * 0.001)));
    requestRender();
  }, { passive: false });

  window.addEventListener('resize', () => {
    camera.aspect = wrap.clientWidth / wrap.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    requestRender();
  });

  requestRender();
}

let isRendering = false;
function requestRender(){
  if(!isRendering){
    isRendering = true;
    requestAnimationFrame(renderLoop);
  }
}

function renderLoop(){
  let delta = 0;
  camState.theta += (targetCamState.theta - camState.theta) * 0.15;
  camState.phi += (targetCamState.phi - camState.phi) * 0.15;
  camState.dist += (targetCamState.dist - camState.dist) * 0.15;

  currentTarget[0] += (targetCurrentTarget[0] - currentTarget[0]) * 0.15;
  currentTarget[1] += (targetCurrentTarget[1] - currentTarget[1]) * 0.15;
  currentTarget[2] += (targetCurrentTarget[2] - currentTarget[2]) * 0.15;
  
  delta += Math.abs(targetCamState.theta - camState.theta);
  delta += Math.abs(targetCamState.phi - camState.phi);
  delta += Math.abs(targetCamState.dist - camState.dist);
  delta += Math.abs(targetCurrentTarget[0] - currentTarget[0]);
  delta += Math.abs(targetCurrentTarget[1] - currentTarget[1]);
  delta += Math.abs(targetCurrentTarget[2] - currentTarget[2]);

  if(autoRotate){
    targetCamState.theta += 0.004;
    delta += 0.01;
  }

  updateCameraPosition();
  updateCubeRotation();
  renderer.render(scene, camera);

  if(delta > 0.0002 || autoRotate){
    requestAnimationFrame(renderLoop);
  } else {
    isRendering = false;
  }
}

function updateCameraPosition(){
  const {theta, phi, dist} = camState;
  const x = currentTarget[0] + dist * Math.sin(phi) * Math.cos(theta);
  const y = currentTarget[1] + dist * Math.cos(phi);
  const z = currentTarget[2] + dist * Math.sin(phi) * Math.sin(theta);
  camera.position.set(x, y, z);
  camera.lookAt(currentTarget[0], currentTarget[1], currentTarget[2]);
}

// Update View Cube Orientation
function updateCubeRotation(){
  const cube = document.getElementById('viewCube');
  if(!cube) return;
  const degX = (camState.phi - Math.PI/2) * (180/Math.PI);
  const degY = -camState.theta * (180/Math.PI);
  cube.style.transform = `rotateX(${degX}deg) rotateY(${degY}deg)`;
}

// Snap Camera Angles from View Cube
function snapCamera(face){
  if(face === 'front')     { targetCamState.theta = Math.PI*0.5;  targetCamState.phi = Math.PI*0.5; }
  else if(face === 'back') { targetCamState.theta = -Math.PI*0.5; targetCamState.phi = Math.PI*0.5; }
  else if(face === 'right'){ targetCamState.theta = 0;           targetCamState.phi = Math.PI*0.5; }
  else if(face === 'left') { targetCamState.theta = Math.PI;     targetCamState.phi = Math.PI*0.5; }
  else if(face === 'top')  { targetCamState.theta = Math.PI*0.5;  targetCamState.phi = 0.05; }
  else if(face === 'bottom'){targetCamState.theta = Math.PI*0.5;  targetCamState.phi = Math.PI-0.05; }
  else if(face === 'iso')  { targetCamState.theta = Math.PI*0.25; targetCamState.phi = Math.PI*0.35; }
  requestRender();
}

function handleWorkerResult(data){
  lastStackData = data;

  const blackGeo = new THREE.BufferGeometry();
  blackGeo.setAttribute('position', new THREE.BufferAttribute(data.blackVerts, 3));
  blackGeo.setIndex(new THREE.BufferAttribute(data.blackTris, 1));
  applyYZSwap(blackGeo);
  blackGeo.computeVertexNormals();

  const whiteGeo = new THREE.BufferGeometry();
  whiteGeo.setAttribute('position', new THREE.BufferAttribute(data.whiteVerts, 3));
  whiteGeo.setIndex(new THREE.BufferAttribute(data.whiteTris, 1));
  applyYZSwap(whiteGeo);
  whiteGeo.computeVertexNormals();

  if(blackMeshObj) scene.remove(blackMeshObj);
  if(whiteMeshObj) scene.remove(whiteMeshObj);
  if(blackEdgesObj) scene.remove(blackEdgesObj);
  if(whiteEdgesObj) scene.remove(whiteEdgesObj);

  // Studio SATIN PBR Materials
  const blackMat = new THREE.MeshStandardMaterial({
    color: 0x1d2127, roughness: 0.35, metalness: 0.12,
    clippingPlanes: (slicerEnabled || xrayEnabled) ? [clipPlane] : [], clipShadows: true
  });
  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xf5f6f8, roughness: 0.45, metalness: 0.05,
    clippingPlanes: (slicerEnabled || xrayEnabled) ? [clipPlane] : [], clipShadows: true
  });

  blackMeshObj = new THREE.Mesh(blackGeo, blackMat);
  whiteMeshObj = new THREE.Mesh(whiteGeo, whiteMat);
  scene.add(blackMeshObj);
  scene.add(whiteMeshObj);

  // Crisp CAD Edge Lines
  if(showEdges){
    const blackEdges = new THREE.EdgesGeometry(blackGeo, 15);
    const whiteEdges = new THREE.EdgesGeometry(whiteGeo, 15);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x4a5568, linewidth: 1.5 });
    blackEdgesObj = new THREE.LineSegments(blackEdges, lineMat);
    whiteEdgesObj = new THREE.LineSegments(whiteEdges, lineMat);
    scene.add(blackEdgesObj);
    scene.add(whiteEdgesObj);
  }

  const p = readParams();
  if(!lastStackData) targetCurrentTarget = [0, data.totalHeight/2, 0];

  const layerH = p.baseFloorH > 0 ? (parseFloat(document.getElementById('layerH').value) || 0.2) : (parseFloat(document.getElementById('layerH').value) || 0.2);
  totalLayers = Math.max(1, Math.ceil(data.totalHeight / layerH));
  
  const layerSlider = document.getElementById('layerSlider');
  if(layerSlider){
    layerSlider.max = totalLayers;
    if(currentLayer > totalLayers || currentLayer === 24){
      currentLayer = totalLayers;
    }
    layerSlider.value = currentLayer;
  }

  updateSlicerState();

  // Model HUD Stats
  const vol_cm3 = (p.blockL * p.blockW * data.totalHeight / 1000).toFixed(1);
  const mass_g = (vol_cm3 * 1.24).toFixed(1);
  const hudDim = document.getElementById('hudDimensions');
  const hudVol = document.getElementById('hudVolume');
  const hudW = document.getElementById('hudWeight');
  if(hudDim) hudDim.textContent = `${p.blockL} × ${p.blockW} × ${data.totalHeight.toFixed(2)} mm`;
  if(hudVol) hudVol.textContent = `Volume: ~${vol_cm3} cm³`;
  if(hudW) hudW.textContent = `PLA Mass: ~${mass_g} g`;

  // Update Schedule & Schematic
  const schedEl = document.getElementById('scheduleList');
  if(schedEl){
    schedEl.innerHTML = data.schedule.map(s => `
      <div class="step-card ${s.kind==='insert'?'insert':''}">
        <div class="z">Z ${s.z.toFixed(2)} mm</div>
        <div class="title">${s.label}</div>
        <div class="desc">${s.detail}</div>
      </div>
    `).join('');
  }

  drawSchematic(p, data);

  const stlBtn = document.getElementById('dlStl');
  const mfBtn = document.getElementById('dl3mf');
  if(stlBtn) stlBtn.disabled = false;
  if(mfBtn) mfBtn.disabled = false;

  requestRender();
}

function applyYZSwap(geo){
  const pos = geo.attributes.position;
  for(let i=0; i<pos.count; i++){
    const y = pos.getY(i), z = pos.getZ(i);
    pos.setY(i, z);
    pos.setZ(i, y);
  }
}

/* ======================================================================
   3D PRINTER SLICER LAYER INSPECTOR ENGINE
   ====================================================================== */
function updateSlicerState(){
  if(!lastStackData) return;
  const p = readParams();
  const layerH = parseFloat(document.getElementById('layerH').value) || 0.2;
  const sliderEl = document.getElementById('layerSlider');
  currentLayer = sliderEl ? (parseInt(sliderEl.value) || totalLayers) : totalLayers;

  const currentZ = Math.min(lastStackData.totalHeight, currentLayer * layerH);

  clipPlane.constant = currentZ;

  let featureTag = "Solid Body Shell";
  if(currentZ <= p.baseFloorH && p.baseFloorH > 0){
    featureTag = "Base Floor Layers";
  } else if(currentZ > lastStackData.magnetPauseZ && currentZ <= lastStackData.magnetCapZ){
    featureTag = "Magnet Pocket Void (Pause & Insert)";
  } else if(currentZ > lastStackData.magnetCapZ && currentZ <= lastStackData.nfcPauseZ){
    featureTag = "Magnet-NFC Spacer Fill";
  } else if(currentZ > lastStackData.nfcPauseZ && currentZ <= lastStackData.nfcCapZ){
    featureTag = "NFC Pocket Void (Pause & Insert)";
  } else if(currentZ > lastStackData.nfcCapZ && currentZ <= lastStackData.qrSurfaceZ){
    featureTag = "Cap Fill (QR Background)";
  } else if(currentZ > lastStackData.qrSurfaceZ){
    featureTag = "QR Relief Pillars (White Filament)";
  }

  const sText = document.getElementById('slicerLayerText');
  const zText = document.getElementById('slicerZText');
  const fText = document.getElementById('slicerFeatureText');
  if(sText) sText.textContent = `Layer ${currentLayer} / ${totalLayers}`;
  if(zText) zText.textContent = `Z = ${currentZ.toFixed(2)} mm`;
  if(fText) fText.textContent = featureTag;

  renderTopSliceCap(currentZ, p);
  requestRender();
}

function renderTopSliceCap(zVal, p){
  if(topCapMeshObj){
    scene.remove(topCapMeshObj);
    topCapMeshObj = null;
  }
}

function togglePlaySlicer(){
  isPlayingAnimation = !isPlayingAnimation;
  const btn = document.getElementById('layerPlayBtn');
  if(btn){
    btn.textContent = isPlayingAnimation ? '⏸' : '▶';
    btn.classList.toggle('play', !isPlayingAnimation);
  }

  if(isPlayingAnimation){
    if(currentLayer >= totalLayers) currentLayer = 1;
    playInterval = setInterval(() => {
      currentLayer++;
      if(currentLayer > totalLayers){
        currentLayer = totalLayers;
        togglePlaySlicer();
      }
      const sliderEl = document.getElementById('layerSlider');
      if(sliderEl) sliderEl.value = currentLayer;
      updateSlicerState();
    }, 150);
  } else {
    clearInterval(playInterval);
  }
}

/* ======================================================================
   DYNAMIC 2D SCHEMATIC
   ====================================================================== */
function drawSchematic(p, data){
  const svg = document.getElementById('schematicSvg');
  if(!svg) return;

  const W = 340, H = 180;
  const padX = 40, padY = 25;
  const drawW = W - padX*2, drawH = H - padY*2;

  const totalH = data.totalHeight || 1;
  const scaleY = drawH / totalH;
  const scaleX = drawW / Math.max(p.blockL, p.blockW);

  const blockW_px = p.blockL * scaleX;
  const startX = (W - blockW_px)/2;

  function getSvgY(zVal){ return (H - padY) - (zVal * scaleY); }

  let html = `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;

  // Base Floor
  const baseFloorH_px = p.baseFloorH * scaleY;
  html += `<rect x="${startX}" y="${getSvgY(p.baseFloorH)}" width="${blockW_px}" height="${baseFloorH_px}" fill="#2a2f3d" stroke="#3b4252" stroke-width="1"/>`;

  // Magnet Pocket
  const magW_px = (p.magL + p.clearance*2) * scaleX;
  const magX = (W - magW_px)/2;
  const magTopY = getSvgY(data.magnetCapZ);
  const magHeight_px = p.magT * scaleY;
  html += `<rect x="${startX}" y="${magTopY}" width="${blockW_px}" height="${magHeight_px}" fill="#2a2f3d" stroke="#3b4252" stroke-width="1"/>`;
  html += `<rect x="${magX}" y="${magTopY}" width="${magW_px}" height="${magHeight_px}" fill="var(--insert-bg)" stroke="var(--insert-color)" stroke-width="1.5" stroke-dasharray="3,3"/>`;
  html += `<text x="${W/2}" y="${magTopY + magHeight_px/2 + 3}" fill="var(--insert-color)" font-size="9.5" font-family="var(--font-mono)" text-anchor="middle">Magnet Pocket</text>`;

  // Spacer
  const gap1TopY = getSvgY(data.nfcPauseZ);
  const gap1H_px = p.gap1 * scaleY;
  html += `<rect x="${startX}" y="${gap1TopY}" width="${blockW_px}" height="${gap1H_px}" fill="#1e222b" stroke="#3b4252" stroke-width="1"/>`;

  // NFC Pocket
  const nfcSpan = p.nfcShape==='circ' ? p.nfcR*2 : p.nfcL;
  const nfcT = p.nfcShape==='circ' ? p.nfcT2 : p.nfcT;
  const nfcW_px = (nfcSpan + p.clearance*2) * scaleX;
  const nfcX = (W - nfcW_px)/2;
  const nfcTopY = getSvgY(data.nfcCapZ);
  const nfcH_px = nfcT * scaleY;
  html += `<rect x="${startX}" y="${nfcTopY}" width="${blockW_px}" height="${nfcH_px}" fill="#2a2f3d" stroke="#3b4252" stroke-width="1"/>`;
  html += `<rect x="${nfcX}" y="${nfcTopY}" width="${nfcW_px}" height="${nfcH_px}" fill="var(--insert-bg)" stroke="var(--insert-color)" stroke-width="1.5" stroke-dasharray="3,3"/>`;
  html += `<text x="${W/2}" y="${nfcTopY + nfcH_px/2 + 3}" fill="var(--insert-color)" font-size="9" font-family="var(--font-mono)" text-anchor="middle">NFC Tag</text>`;

  // Cap Fill
  const capTopY = getSvgY(data.qrSurfaceZ);
  const capH_px = p.capFill * scaleY;
  html += `<rect x="${startX}" y="${capTopY}" width="${blockW_px}" height="${capH_px}" fill="#181b22" stroke="#3b4252" stroke-width="1"/>`;

  // QR Relief
  const qrTopY = getSvgY(data.totalHeight);
  const qrH_px = p.qrReliefH * scaleY;
  html += `<rect x="${startX}" y="${qrTopY}" width="${blockW_px}" height="${qrH_px}" fill="var(--text-main)" stroke="#fff" stroke-width="1"/>`;
  html += `<text x="${W/2}" y="${qrTopY - 4}" fill="var(--text-main)" font-size="9.5" font-family="var(--font-mono)" text-anchor="middle">QR Surface Z=${data.totalHeight.toFixed(2)}mm</text>`;

  // Slicer Active Line
  const slicerLineY = getSvgY(Math.min(data.totalHeight, currentLayer * (parseFloat(document.getElementById('layerH').value)||0.2)));
  html += `<line x1="${startX - 15}" y1="${slicerLineY}" x2="${startX + blockW_px + 15}" y2="${slicerLineY}" stroke="var(--accent-blue)" stroke-width="2" stroke-dasharray="4,2"/>`;

  svg.innerHTML = html;
}

// Collapsible Tree Sections
function toggleSection(secId){
  const el = document.getElementById(secId);
  const arrow = document.getElementById(secId + '_arrow');
  if(el){
    const isHidden = el.style.display === 'none';
    el.style.display = isHidden ? 'flex' : 'none';
    if(arrow) arrow.textContent = isHidden ? '▼' : '▶';
  }
}

/* ======================================================================
   UI EVENT WIRING & PRESETS
   ====================================================================== */
let baseFloorMode = '0';
let nfcShape = 'rect';

function setupSegs(){
  document.querySelectorAll('#baseFloorSeg button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#baseFloorSeg button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      baseFloorMode = btn.dataset.val;
      const customRow = document.getElementById('baseFloorCustomRow');
      if(customRow) customRow.style.display = baseFloorMode==='custom' ? 'grid' : 'none';
      triggerRegenerate();
    });
  });
  document.querySelectorAll('#nfcShapeSeg button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#nfcShapeSeg button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      nfcShape = btn.dataset.val;
      const rectRow = document.getElementById('nfcRectRow');
      const circRow = document.getElementById('nfcCircRow');
      if(rectRow) rectRow.style.display = nfcShape==='rect' ? 'grid' : 'none';
      if(circRow) circRow.style.display = nfcShape==='circ' ? 'grid' : 'none';
      triggerRegenerate();
    });
  });
}

function applyPreset(category, p1, p2, p3, p4){
  if(category === 'mag'){
    setFieldValue('magL', p1); setFieldValue('magW', p2); setFieldValue('magT', p3);
    showToast(`Applied Magnet Preset: ${p1}×${p2}×${p3}mm`);
  } else if(category === 'nfc'){
    nfcShape = p1;
    document.querySelectorAll('#nfcShapeSeg button').forEach(b => b.classList.toggle('active', b.dataset.val === p1));
    const rectRow = document.getElementById('nfcRectRow');
    const circRow = document.getElementById('nfcCircRow');
    if(rectRow) rectRow.style.display = p1==='rect' ? 'grid' : 'none';
    if(circRow) circRow.style.display = p1==='circ' ? 'grid' : 'none';
    if(p1 === 'rect'){
      setFieldValue('nfcL', p2); setFieldValue('nfcW', p3); setFieldValue('nfcT', p4);
      showToast(`Applied NFC Rect Preset: ${p2}×${p3}×${p4}mm`);
    } else {
      setFieldValue('nfcR', p2); setFieldValue('nfcT2', p3);
      showToast(`Applied NFC Round Preset: Ø${p2*2}×${p3}mm`);
    }
  }
  triggerRegenerate();
}

function setFieldValue(id, val){
  const numEl = document.getElementById(id);
  const rangeEl = document.getElementById(id + '_slider');
  if(numEl) numEl.value = val;
  if(rangeEl) rangeEl.value = val;
}

function readParams(){
  const num = id => {
    const el = document.getElementById(id);
    return el ? (parseFloat(el.value) || 0) : 0;
  };
  const baseFloorH = baseFloorMode==='custom' ? num('baseFloorH') : 0;
  const qrUrlEl = document.getElementById('qrUrl');
  const qrEccEl = document.getElementById('qrEcc');
  return {
    blockL: num('blockL'), blockW: num('blockW'),
    wallMargin: num('wallMargin'), clearance: num('clearance'),
    baseFloorH,
    magL: num('magL'), magW: num('magW'), magT: num('magT'),
    gap1: num('gap1'),
    nfcShape,
    nfcL: num('nfcL'), nfcW: num('nfcW'), nfcT: num('nfcT'),
    nfcR: num('nfcR'), nfcT2: num('nfcT2'),
    capFill: num('capFill'),
    qrReliefH: num('qrReliefH'),
    qrEcc: qrEccEl ? qrEccEl.value : 'M',
    url: qrUrlEl ? qrUrlEl.value.trim() : 'https://claude.ai'
  };
}

function validate(p){
  const errs = [];
  const nfcSpanL = p.nfcShape==='circ' ? p.nfcR*2 : p.nfcL;
  const nfcSpanW = p.nfcShape==='circ' ? p.nfcR*2 : p.nfcW;
  if(p.magL + p.clearance*2 + p.wallMargin*2 > p.blockL || p.magW + p.clearance*2 + p.wallMargin*2 > p.blockW)
    errs.push('Magnet pocket exceeds block footprint margin.');
  if(nfcSpanL + p.clearance*2 + p.wallMargin*2 > p.blockL || nfcSpanW + p.clearance*2 + p.wallMargin*2 > p.blockW)
    errs.push('NFC pocket exceeds block footprint margin.');
  if(p.gap1 < 0.4) errs.push('Spacer thickness is thin (suggest ≥ 0.4mm).');
  if(p.capFill < 0.4) errs.push('Cap fill thickness is thin (suggest ≥ 0.4mm).');
  if(!p.url) errs.push('Enter a URL or text string to encode.');
  return errs;
}

let debounceTimer = null;
function triggerRegenerate(){
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doRegenerate, 50);
}

function doRegenerate(){
  const p = readParams();
  const errs = validate(p);
  const vBox = document.getElementById('validation');
  if(vBox){
    vBox.innerHTML = errs.length ? errs.map(e => `<div class="err" style="color:var(--danger); font-size:11px;">⚠ ${e}</div>`).join('') : '';
  }

  const stlBtn = document.getElementById('dlStl');
  const mfBtn = document.getElementById('dl3mf');
  if(stlBtn) stlBtn.disabled = errs.length > 0;
  if(mfBtn) mfBtn.disabled = errs.length > 0;

  if(errs.length) return;

  let qrGrid = [];
  try {
    const qr = qrcode(0, p.qrEcc);
    qr.addData(p.url);
    qr.make();
    const n = qr.getModuleCount();
    for(let r=0; r<n; r++){
      const row = [];
      for(let c=0; c<n; c++) row.push(qr.isDark(r,c));
      qrGrid.push(row);
    }
  } catch(e){
    if(vBox) vBox.innerHTML += `<div class="err" style="color:var(--danger)">⚠ QR Encoding Error: ${e.message}</div>`;
    return;
  }

  p.qrGrid = qrGrid;
  worker.postMessage(p);
}

// Toast Notifications
function showToast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// Exporters
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportSTL(){
  if(!lastStackData) return;
  showToast('Generating STL Mesh...');
  setTimeout(() => {
    const {blackVerts, blackTris, whiteVerts, whiteTris} = lastStackData;
    const triCount = (blackTris.length + whiteTris.length) / 3;
    const buf = new ArrayBuffer(84 + triCount * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, triCount, true);
    let offset = 84;

    function writeMesh(verts, tris){
      for(let i=0; i<tris.length; i+=3){
        const a = tris[i]*3, b = tris[i+1]*3, c = tris[i+2]*3;
        const Ax = verts[a], Ay = verts[a+2], Az = verts[a+1];
        const Bx = verts[b], By = verts[b+2], Bz = verts[b+1];
        const Cx = verts[c], Cy = verts[c+2], Cz = verts[c+1];

        const ux = Bx-Ax, uy = By-Ay, uz = Bz-Az;
        const vx = Cx-Ax, vy = Cy-Ay, vz = Cz-Az;
        let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
        const len = Math.hypot(nx,ny,nz)||1; nx/=len; ny/=len; nz/=len;

        dv.setFloat32(offset, nx, true); dv.setFloat32(offset+4, ny, true); dv.setFloat32(offset+8, nz, true);
        const pts = [[Ax,Ay,Az], [Bx,By,Bz], [Cx,Cy,Cz]];
        for(let k=0; k<3; k++){
          dv.setFloat32(offset+12+k*12, pts[k][0], true);
          dv.setFloat32(offset+12+k*12+4, pts[k][1], true);
          dv.setFloat32(offset+12+k*12+8, pts[k][2], true);
        }
        dv.setUint16(offset+48, 0, true);
        offset += 50;
      }
    }
    writeMesh(blackVerts, blackTris);
    writeMesh(whiteVerts, whiteTris);

    const blob = new Blob([buf], {type: 'application/octet-stream'});
    downloadBlob(blob, '3qr-block.stl');
    showToast('STL Download Ready!');
  }, 50);
}

async function export3MF(){
  if(!lastStackData) return;
  showToast('Generating 3MF multi-color package...');
  setTimeout(async () => {
    const {blackVerts, blackTris, whiteVerts, whiteTris} = lastStackData;

    function meshXML(verts, tris){
      let v = '<vertices>';
      for(let i=0; i<verts.length; i+=3){
        v += `<vertex x="${verts[i].toFixed(4)}" y="${verts[i+2].toFixed(4)}" z="${verts[i+1].toFixed(4)}"/>`;
      }
      v += '</vertices><triangles>';
      for(let i=0; i<tris.length; i+=3){
        v += `<triangle v1="${tris[i]}" v2="${tris[i+1]}" v3="${tris[i+2]}"/>`;
      }
      v += '</triangles>';
      return v;
    }

    const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="1">
      <base name="Black" displaycolor="#1A1A1AFF"/>
      <base name="White" displaycolor="#F2F2F2FF"/>
    </basematerials>
    <object id="2" type="model" pid="1" pindex="0">
      <mesh>${meshXML(blackVerts, blackTris)}</mesh>
    </object>
    <object id="3" type="model" pid="1" pindex="1">
      <mesh>${meshXML(whiteVerts, whiteTris)}</mesh>
    </object>
  </resources>
  <build>
    <item objectid="2"/>
    <item objectid="3"/>
  </build>
</model>`;

    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`);
    zip.file('3D/3dmodel.model', model);

    const blob = await zip.generateAsync({type: 'blob', mimeType: 'application/vnd.ms-package.3dmanufacturing-3dmodel'});
    downloadBlob(blob, '3qr-block.3mf');
    showToast('3MF Download Ready!');
  }, 50);
}

// Initialization
function init(){
  initWorker();
  initViewer();
  setupSegs();
  setupSynchronizedSliders();

  const qrUrlEl = document.getElementById('qrUrl');
  const qrEccEl = document.getElementById('qrEcc');
  if(qrUrlEl) qrUrlEl.addEventListener('input', triggerRegenerate);
  if(qrEccEl) qrEccEl.addEventListener('change', triggerRegenerate);

  // Slicer Controls
  const layerSliderEl = document.getElementById('layerSlider');
  const layerUpBtnEl = document.getElementById('layerUpBtn');
  const layerDownBtnEl = document.getElementById('layerDownBtn');
  const layerPlayBtnEl = document.getElementById('layerPlayBtn');
  const slicerResetBtnEl = document.getElementById('slicerResetBtn');

  if(layerSliderEl) layerSliderEl.addEventListener('input', updateSlicerState);
  if(layerUpBtnEl) layerUpBtnEl.addEventListener('click', () => { if(currentLayer < totalLayers){ currentLayer++; layerSliderEl.value = currentLayer; updateSlicerState(); } });
  if(layerDownBtnEl) layerDownBtnEl.addEventListener('click', () => { if(currentLayer > 1){ currentLayer--; layerSliderEl.value = currentLayer; updateSlicerState(); } });
  if(layerPlayBtnEl) layerPlayBtnEl.addEventListener('click', togglePlaySlicer);
  if(slicerResetBtnEl) slicerResetBtnEl.addEventListener('click', () => { currentLayer = totalLayers; if(layerSliderEl) layerSliderEl.value = currentLayer; updateSlicerState(); });

  // Workspace Mode Tabs
  const tabPrepare = document.getElementById('tabPrepare');
  const tabSlicer = document.getElementById('tabSlicer');
  const slicerBar = document.getElementById('slicerBar');

  if(tabPrepare && tabSlicer){
    tabPrepare.addEventListener('click', () => {
      tabPrepare.classList.add('active');
      tabSlicer.classList.remove('active');
      if(slicerBar) slicerBar.style.display = 'none';
      blackMeshObj.material.clippingPlanes = [];
      whiteMeshObj.material.clippingPlanes = [];
      requestRender();
    });
    tabSlicer.addEventListener('click', () => {
      tabSlicer.classList.add('active');
      tabPrepare.classList.remove('active');
      if(slicerBar) slicerBar.style.display = 'flex';
      blackMeshObj.material.clippingPlanes = [clipPlane];
      whiteMeshObj.material.clippingPlanes = [clipPlane];
      updateSlicerState();
      requestRender();
    });
  }
  const modeEdgesBtn = document.getElementById('modeEdgesBtn');
  const modeXrayBtn = document.getElementById('modeXrayBtn');
  const resetCamBtn = document.getElementById('resetCamBtn');
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  if(modeEdgesBtn){
    modeEdgesBtn.addEventListener('click', () => {
      showEdges = !showEdges;
      modeEdgesBtn.classList.toggle('active', showEdges);
      if(blackEdgesObj) blackEdgesObj.visible = showEdges;
      if(whiteEdgesObj) whiteEdgesObj.visible = showEdges;
      requestRender();
    });
  }

  if(modeXrayBtn){
    modeXrayBtn.addEventListener('click', () => {
      xrayEnabled = !xrayEnabled;
      modeXrayBtn.classList.toggle('active', xrayEnabled);
      if(blackMeshObj){
        blackMeshObj.material.transparent = xrayEnabled;
        blackMeshObj.material.opacity = xrayEnabled ? 0.35 : 1.0;
        blackMeshObj.material.depthWrite = !xrayEnabled;
        blackMeshObj.material.needsUpdate = true;
      }
      if(whiteMeshObj){
        whiteMeshObj.material.transparent = xrayEnabled;
        whiteMeshObj.material.opacity = xrayEnabled ? 0.45 : 1.0;
        whiteMeshObj.material.depthWrite = !xrayEnabled;
        whiteMeshObj.material.needsUpdate = true;
      }
      requestRender();
    });
  }

  if(resetCamBtn){
    resetCamBtn.addEventListener('click', () => {
      if(lastStackData) targetCurrentTarget = [0, lastStackData.totalHeight/2, 0];
      snapCamera('iso');
    });
  }

  if(themeToggleBtn){
    themeToggleBtn.addEventListener('click', () => {
      const root = document.documentElement;
      const cur = root.getAttribute('data-theme');
      root.setAttribute('data-theme', cur==='light' ? 'dark' : 'light');
      requestRender();
    });
  }

  const stlBtn = document.getElementById('dlStl');
  const mfBtn = document.getElementById('dl3mf');
  if(stlBtn) stlBtn.addEventListener('click', exportSTL);
  if(mfBtn) mfBtn.addEventListener('click', export3MF);

  triggerRegenerate();
}

window.addEventListener('load', init);

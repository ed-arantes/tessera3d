/**
 * HueForge-Style Posterized 3MF Generator
 * Main Application Logic
 */


// Application State
const state = {
  image: null,
  rawLuminance: null, // Float32Array of raw normalized luminance [0, 1]
  colorSampleRGB: null, // Uint8Array of RGB data for color matching (full grid-res)
  colorSampleWidth: 0,
  colorSampleHeight: 0,
  imgWidth: 0,
  imgHeight: 0,

  // UI Parameters
  widthMm: 150,
  heightMm: 150,
  maxHeight: 3.0,
  baseThickness: 0.48,
  layerHeight: 0.08,
  gridResolution: 800,
  triangleQuality: 70,
  invertHeights: false,
  mirrorX: false,
  posterize: true,
  simulateTransmission: false,

  // Puzzle Settings
  puzzleEnabled: false,
  puzzleCols: 3,
  puzzleRows: 3,
  puzzleClearanceMm: 0.15,

  // Color Layers
  layersCount: 6,
  layers: [
    { hex: '#0a0a0a', startHeight: 0.0, td: 0.5 },  // Base layer (usually dark)
    { hex: '#3b82f6', startHeight: 0.8, td: 2.0 },  // Transition colors
    { hex: '#ef4444', startHeight: 1.6, td: 2.0 },
    { hex: '#ffffff', startHeight: 2.4, td: 3.0 }   // Top highlight (usually light)
  ],

  // Filament library from D1
  filaments: []
};

window.state = state;

// Preset palette colors for adding new layers
const PRESET_COLORS = [
  '#0a0a0a', // Dark Gray/Black
  '#3b82f6', // Blue
  '#ef4444', // Red
  '#ffffff', // White
  '#10b981', // Green
  '#f59e0b', // Yellow
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#f97316', // Orange
  '#06b6d4', // Cyan
  '#6b7280', // Gray
  '#78350f', // Brown
  '#a855f7', // Light Purple
  '#fb7185', // Rose
  '#84cc16', // Lime
  '#eab308'  // Gold
];

// Three.js variables
let scene, camera, renderer, controls;
let modelGroup;
let renderDebounceTimer = null;
let sceneNeedsRender = true; // dirty flag

// Cached heights to avoid recomputation
let _cachedHeights = null;
let _cachedHeightsKey = null;
let _modelVertexCount = 0;
let _modelTriangleCount = 0;

// Track color state for color-only fast path optimization
let _lastColorStateSignature = null;

// 2D layer viewer state
let current2DLayerIndex = 0;
let _2dRenderPending = false;
let _2dBaseCacheCanvas = null;
let _2dBaseCacheImageData = null;
let _2dBaseCacheKey = null;

function sync2DLayerIndex() {
  current2DLayerIndex = state.layers.length - 1;
}

function invalidate2DCache() {
  _2dBaseCacheKey = null;
}

function schedule2DRender() {
  if (_2dRenderPending) return;
  _2dRenderPending = true;
  requestAnimationFrame(() => {
    _2dRenderPending = false;
    draw2DSimulation();
  });
}

function get2DRenderCacheKey() {
  const layerState = state.layers.map(l => `${l.hex}:${l.startHeight}:${l.td ?? 2}`).join('|');
  return `${_cachedHeightsKey}|${current2DLayerIndex}|${state.simulateTransmission}|${state.posterize}|${layerState}|${state.puzzleEnabled}`;
}

function ensure2DBaseCache(cols, rows) {
  if (!_2dBaseCacheCanvas) {
    _2dBaseCacheCanvas = document.createElement('canvas');
  }

  if (_2dBaseCacheCanvas.width !== cols || _2dBaseCacheCanvas.height !== rows) {
    _2dBaseCacheCanvas.width = cols;
    _2dBaseCacheCanvas.height = rows;
    _2dBaseCacheImageData = null;
  }

  if (!_2dBaseCacheImageData || _2dBaseCacheImageData.width !== cols || _2dBaseCacheImageData.height !== rows) {
    _2dBaseCacheImageData = new ImageData(cols, rows);
  }

  return _2dBaseCacheImageData;
}

// ─── Flood Fill Region State ─────────────────────────────────────────────────
let ffModeActive = false;          // is the fill-select tool on?
let ffRegionMask = null;           // Int16Array: -1=unassigned, >=0 = region id
let ffRegionColors = {};           // { [regionId]: hexString }
let ffNextRegionId = 0;            // auto-increment region ids
let ffSelectedRegionId = null;     // which region is currently highlighted
let ffLastFillSet = null;          // Set of pixel indices from the last BFS (pending assign)
// ─────────────────────────────────────────────────────────────────────────────

// DOM Elements
let dropZone, fileInput, btnAutoDistribute, btnMatchColors, btnExport;
let container3D, canvas2D;
let layerListContainer;
let exportProgressContainer, exportProgressStatus, exportProgressFill, exportProgressMeta;

// View Cube
let vcRenderer, vcScene, vcCamera, vcCube;
let vcAnimating = false;
let vcDragging = false, vcDragStart = null, vcDragStartQuat = null;
let vcDragMoved = false;
const vcRaycaster = new THREE.Raycaster();
const vcMouse = new THREE.Vector2();
const DEFAULT_CAM_POS = new THREE.Vector3(0, -180, 150);
const DEFAULT_CAM_TARGET = new THREE.Vector3(0, 0, 0);
let exportProgressResetTimer = null;

function init() {
  initDOM();
  initThreeJS();
  loadFilaments();
  setupEventListeners();
  updateUIFromState();
  sync2DLayerIndex();
  showEmptyState();

  const loader = document.getElementById('app-loader');
  if (loader) {
    loader.style.opacity = '0';
    setTimeout(() => loader.remove(), 300);
  }
}

async function loadFilaments() {
  try {
    const res = await fetch('/api/filaments');
    const data = await res.json();
    if (data.ok && data.filaments) {
      state.filaments = data.filaments;
    }
  } catch (err) {
    console.warn('Could not load filament library:', err);
  }
}

function updateCardShadow() {
  const card = document.querySelector('.preview-card');
  if (!card) return;
  const empty = document.getElementById('preview-empty');
  const pane2d = document.getElementById('pane-2d');
  const isEmpty = empty && !empty.classList.contains('hidden') && pane2d && pane2d.classList.contains('active');
  if (isEmpty) {
    card.classList.add('is-empty');
  } else {
    card.classList.remove('is-empty');
  }
}

function showEmptyState() {
  document.getElementById('preview-spinner').classList.add('hidden');
  document.getElementById('preview-empty').classList.remove('hidden');
  document.getElementById('layer-nav').classList.add('hidden');
  const ffTb = document.getElementById('ff-toolbar');
  if (ffTb) ffTb.style.display = 'none';
  updateCardShadow();
  updateTabsForImage();
}

function updateTabsForImage() {
  const hasImage = !!state.image;
  const tab3d = document.getElementById('tab-3d');
  const tabFil = document.getElementById('tab-filament');
  if (tab3d) tab3d.disabled = !hasImage;
  if (tabFil) tabFil.disabled = !hasImage;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Setup DOM elements reference
function initDOM() {
  dropZone = document.getElementById('drop-zone');
  fileInput = document.getElementById('file-input');
  btnAutoDistribute = document.getElementById('btn-auto-distribute');
  btnMatchColors = document.getElementById('btn-match-colors');
  btnExport = document.getElementById('btn-export');
  container3D = document.getElementById('container-3d');
  canvas2D = document.getElementById('canvas-2d');
  layerListContainer = document.getElementById('layer-list');
  exportProgressContainer = document.getElementById('export-progress');
  exportProgressStatus = document.getElementById('export-progress-status');
  exportProgressFill = document.getElementById('export-progress-fill');
  exportProgressMeta = document.getElementById('export-progress-meta');
}

// Initialize Three.js Viewport
function initThreeJS() {
  const width = container3D.clientWidth;
  const height = container3D.clientHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#f4f5f7');

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  // Position camera at a 45 degree angle looking down
  camera.position.set(0, -180, 150);
  camera.up.set(0, 0, 1); // Z is UP in 3D printing

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  container3D.innerHTML = '';
  container3D.appendChild(renderer.domElement);

  // Orbit Controls
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.01; // Don't go below ground

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambientLight);

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight1.position.set(100, -100, 150);
  // dirLight1.castShadow = true;
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0xfef3c7, 0.2);
  dirLight2.position.set(-100, 100, 50);
  scene.add(dirLight2);

  // ── Build Plate (PEI) ────────────────────────────────────────
  const plateSize = 280;
  const plateGeo = new THREE.PlaneGeometry(plateSize, plateSize);

  // PEI grain texture
  const noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = 512; noiseCanvas.height = 512;
  const nctx = noiseCanvas.getContext('2d');
  const noiseData = nctx.createImageData(512, 512);
  for (let i = 0; i < noiseData.data.length; i += 4) {
    const val = Math.random() * 255;
    noiseData.data[i] = noiseData.data[i+1] = noiseData.data[i+2] = val;
    noiseData.data[i+3] = 255;
  }
  nctx.putImageData(noiseData, 0, 0);
  const peiTex = new THREE.CanvasTexture(noiseCanvas);
  peiTex.wrapS = peiTex.wrapT = THREE.RepeatWrapping;
  peiTex.repeat.set(4, 4);

  // Build plate group
  const buildPlate = new THREE.Group();
  const plateMat = new THREE.MeshStandardMaterial({
    color: '#d4af37',
    roughness: 0.7,
    metalness: 0.2,
    bumpMap: peiTex,
    bumpScale: 0.8
  });
  const plateMesh = new THREE.Mesh(plateGeo, plateMat);
  buildPlate.add(plateMesh);

  buildPlate.position.z = 0;
  scene.add(buildPlate);

  // Model group
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  // Handle resize
  window.addEventListener('resize', onWindowResize);

  // Mark scene dirty whenever the camera/controls move
  controls.addEventListener('change', () => { sceneNeedsRender = true; });

  // Animation Loop - only renders when something changed
  function animate() {
    requestAnimationFrame(animate);
    const changed = controls.update(); // returns true if camera moved
    if (changed) sceneNeedsRender = true;
    if (sceneNeedsRender) {
      renderer.render(scene, camera);
      sceneNeedsRender = false;
    }
    syncViewCube();
  }
  animate();

  initViewCube();
}

function onWindowResize() {
  if (!container3D) return;
  const width = container3D.clientWidth;
  const height = container3D.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  if (vcRenderer) vcRenderer.setSize(120, 120);
}

// ── View Cube ────────────────────────────────────────────────

function vcMakeFaceTexture(label, bgColor, rotation) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c4c5c6ff';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = bgColor;
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (rotation) {
    ctx.translate(64, 64);
    ctx.rotate(rotation);
    ctx.fillText(label, 0, 0);
  } else {
    ctx.fillText(label, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function initViewCube() {
  const canvas = document.getElementById('view-cube-canvas');
  if (!canvas) return;

  vcScene = new THREE.Scene();
  vcCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  vcCamera.position.set(0, 0, 3.2);

  vcRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  vcRenderer.setPixelRatio(window.devicePixelRatio || 1);
  vcRenderer.setSize(120, 120);
  vcRenderer.setClearColor(0x000000, 0);

  const BG = '#1f2937';
  const faces = [
    { label: 'Right',  bg: BG, rotation: -Math.PI / 2 }, // +X
    { label: 'Left',   bg: BG, rotation:  Math.PI / 2 }, // -X
    { label: 'Back',   bg: BG, rotation:  Math.PI },     // +Y
    { label: 'Front',  bg: BG, rotation: 0 },             // -Y
    { label: 'Top',    bg: BG, rotation: 0 },             // +Z
    { label: 'Bottom', bg: BG, rotation: Math.PI }        // -Z
  ];

  const faceMaterials = faces.map(f =>
    new THREE.MeshLambertMaterial({ map: vcMakeFaceTexture(f.label, f.bg, f.rotation), transparent: true, opacity: 0.9 })
  );

  const cubeGroup = new THREE.Group();
  const cubeGeo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  vcCube = new THREE.Mesh(cubeGeo, faceMaterials);
  cubeGroup.add(vcCube);

  // Thin black outline on every edge
  const edgeGeo = new THREE.EdgesGeometry(cubeGeo);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.5 });
  const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  vcCube.add(edgeLines);

  vcScene.add(cubeGroup);
  vcScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6);
  dl.position.set(2, 3, 4);
  vcScene.add(dl);

  // ── Drag to orbit ──
  canvas.addEventListener('mousedown', onVCDown);
  canvas.addEventListener('touchstart', onVCTouchStart, { passive: false });
  window.addEventListener('mousemove', onVCMove);
  window.addEventListener('mouseup', onVCUp);
  window.addEventListener('touchmove', onVCTouchMove, { passive: false });
  window.addEventListener('touchend', onVCUp);

  // ── Click face to snap view ──
  canvas.addEventListener('mouseup', onVCClick);
  canvas.addEventListener('touchend', onVCTouchClick);

  // ── Home button ──
  const homeBtn = document.getElementById('view-cube-home');
  if (homeBtn) {
    homeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      animateCameraTo(DEFAULT_CAM_POS, DEFAULT_CAM_TARGET);
    });
  }
}

function onVCDown(e) {
  vcDragging = true;
  vcDragMoved = false;
  vcDragStart = { x: e.clientX, y: e.clientY };
  vcDragStartQuat = camera.quaternion.clone();
  e.preventDefault();
}

function onVCTouchStart(e) {
  if (e.touches.length === 1) {
    vcDragging = true;
    vcDragMoved = false;
    vcDragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    vcDragStartQuat = camera.quaternion.clone();
    e.preventDefault();
  }
}

function onVCMove(e) {
  if (!vcDragging) return;
  const dx = e.clientX - vcDragStart.x;
  const dy = e.clientY - vcDragStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) vcDragMoved = true;
  applyVCDrag(dx, dy);
}

function onVCTouchMove(e) {
  if (!vcDragging || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - vcDragStart.x;
  const dy = e.touches[0].clientY - vcDragStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) vcDragMoved = true;
  applyVCDrag(dx, dy);
  e.preventDefault();
}

function applyVCDrag(dx, dy) {
  if (vcAnimating) return;

  // Horizontal drag → rotate around Z axis (up vector)
  const rotZ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), -dx * 0.008
  );

  // Vertical drag → rotate around camera's local right axis
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(vcDragStartQuat);
  const rotRight = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.008);

  // Apply both rotations to the start position
  const offset = camera.position.clone().sub(controls.target);
  offset.applyQuaternion(rotZ);
  offset.applyQuaternion(rotRight);

  // Clamp: don't go below ground or flip over
  const newUp = offset.z;
  if (newUp < 2) offset.z = 2;
  if (newUp > 290) offset.z = 290;

  camera.position.copy(controls.target).add(offset);
  camera.lookAt(controls.target);
  controls.update();
  sceneNeedsRender = true;
}

function onVCUp() {
  vcDragging = false;
}

// ── Click-to-face: animate camera to the clicked face's view ──
const VC_FACE_VIEWS = [
  { pos: new THREE.Vector3(180, 0, 150),   target: DEFAULT_CAM_TARGET.clone() }, // 0: +X Right
  { pos: new THREE.Vector3(-180, 0, 150),  target: DEFAULT_CAM_TARGET.clone() }, // 1: -X Left
  { pos: new THREE.Vector3(0, 180, 150),   target: DEFAULT_CAM_TARGET.clone() }, // 2: +Y Back
  { pos: new THREE.Vector3(0, -180, 150),  target: DEFAULT_CAM_TARGET.clone() }, // 3: -Y Front
  { pos: new THREE.Vector3(0, 0, 280),     target: DEFAULT_CAM_TARGET.clone() }, // 4: +Z Top
  { pos: new THREE.Vector3(0, -180, 30),   target: DEFAULT_CAM_TARGET.clone() }, // 5: -Z Bottom
];

function vcRaycastFace(cx, cy) {
  const canvas = vcRenderer.domElement;
  const rect = canvas.getBoundingClientRect();
  vcMouse.x = ((cx - rect.left) / rect.width) * 2 - 1;
  vcMouse.y = -((cy - rect.top) / rect.height) * 2 + 1;
  vcRaycaster.setFromCamera(vcMouse, vcCamera);
  const hits = vcRaycaster.intersectObject(vcCube);
  if (hits.length > 0) return hits[0].face.materialIndex;
  return -1;
}

function onVCClick(e) {
  if (vcDragMoved || vcAnimating) return;
  const faceIdx = vcRaycastFace(e.clientX, e.clientY);
  if (faceIdx >= 0 && faceIdx < VC_FACE_VIEWS.length) {
    const view = VC_FACE_VIEWS[faceIdx];
    animateCameraTo(view.pos, view.target);
  }
}

function onVCTouchClick(e) {
  if (vcDragMoved || vcAnimating || e.changedTouches.length !== 1) return;
  const t = e.changedTouches[0];
  const faceIdx = vcRaycastFace(t.clientX, t.clientY);
  if (faceIdx >= 0 && faceIdx < VC_FACE_VIEWS.length) {
    const view = VC_FACE_VIEWS[faceIdx];
    animateCameraTo(view.pos, view.target);
  }
}

function syncViewCube() {
  if (!vcCube || !camera) return;
  vcCube.quaternion.copy(camera.quaternion).invert();
  if (vcRenderer) vcRenderer.render(vcScene, vcCamera);
}

function animateCameraTo(targetPos, targetLookAt) {
  if (vcAnimating) return;
  vcAnimating = true;

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const duration = 400;
  const startTime = performance.now();

  function step(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    camera.position.lerpVectors(startPos, targetPos, ease);
    controls.target.lerpVectors(startTarget, targetLookAt, ease);
    camera.lookAt(controls.target);
    controls.update();
    sceneNeedsRender = true;

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      vcAnimating = false;
    }
  }
  requestAnimationFrame(step);
}

// ── End View Cube ────────────────────────────────────────────

// Setup Application Event Listeners
function setupEventListeners() {
  // Drag and Drop
  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleImageFile(e.dataTransfer.files[0]);
    }
  });

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleImageFile(fileInput.files[0]);
    }
  });

  // Remove background
  const removeBgBtn = document.getElementById('remove-bg-btn');
  if (removeBgBtn) {
    removeBgBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBackground();
    });
  }

  // Flood Fill canvas click
  canvas2D.addEventListener('click', onCanvas2DClick);

  // Dimension & Slicing Inputs
  setupInputListener('input-width', 'widthMm', (v) => Math.min(500, Math.max(10, parseFloat(v))), debounceUpdate);
  setupInputListener('input-height', 'heightMm', (v) => Math.min(500, Math.max(10, parseFloat(v))), debounceUpdate);
  setupInputListener('input-max-height', 'maxHeight', (v) => Math.min(20, Math.max(0.5, parseFloat(v))), () => {
    // Re-clamp layer slider maxes
    validateLayerHeights();
    renderLayersList();
    debounceUpdate();
  });
  setupInputListener('input-base-thickness', 'baseThickness', (v) => Math.min(10, Math.max(0.1, parseFloat(v))), () => {
    validateLayerHeights();
    renderLayersList();
    debounceUpdate();
  });
  setupInputListener('input-layer-height', 'layerHeight', (v) => Math.min(0.6, Math.max(0.02, parseFloat(v))), () => {
    validateLayerHeights();
    renderLayersList();
    updateTransitionTable();
    debounceUpdate();
  });
  setupInputListener('input-resolution', 'gridResolution', (v) => Math.min(1200, Math.max(50, parseInt(v))), () => {
    if (state.image) processImage();
  });

  document.getElementById('input-triangle-quality').addEventListener('change', (e) => {
    state.triangleQuality = parseInt(e.target.value, 10);
    update3DPreviewDebounced();
  });

  const checkboxInvert = document.getElementById('input-invert');
  checkboxInvert.addEventListener('change', () => {
    state.invertHeights = checkboxInvert.checked;
    // Reverse color order of all layers
    if (state.layers.length > 1) {
      state.layers.reverse();
    }
    renderLayersList();
    if (state.image) {
      processImage();
    }
  });

  const checkboxMirrorX = document.getElementById('input-mirror-x');
  if (checkboxMirrorX) {
    checkboxMirrorX.addEventListener('change', () => {
      state.mirrorX = checkboxMirrorX.checked;
      if (state.image) {
        processImage();
      }
    });
  }

  const checkboxPosterize = document.getElementById('input-posterize');
  if (checkboxPosterize) {
    checkboxPosterize.addEventListener('change', () => {
      state.posterize = checkboxPosterize.checked;
      if (state.posterize && checkboxSimulate && checkboxSimulate.checked) {
        checkboxSimulate.checked = false;
        state.simulateTransmission = false;
      }
      if (state.image) {
        debounceUpdate();
      }
    });
  }

  const checkboxSimulate = document.getElementById('input-simulate-td');
  if (checkboxSimulate) {
    checkboxSimulate.addEventListener('change', () => {
      state.simulateTransmission = checkboxSimulate.checked;
      if (state.simulateTransmission && checkboxPosterize && checkboxPosterize.checked) {
        checkboxPosterize.checked = false;
        state.posterize = false;
      }
      if (state.image) {
        debounceUpdate();
      }
    });
  }

  // Color Count Slider
  const sliderColorsCount = document.getElementById('input-colors-count');
  const labelColorsCount = document.getElementById('label-colors-count');
  sliderColorsCount.addEventListener('input', () => {
    const val = parseInt(sliderColorsCount.value);
    labelColorsCount.textContent = val;
    updateLayersCount(val);
    sync2DLayerIndex();
    renderLayersList();
    debounceUpdate();
  });

  document.getElementById('colors-count-down').addEventListener('click', () => {
    sliderColorsCount.value = Math.max(1, parseInt(sliderColorsCount.value) - 1);
    sliderColorsCount.dispatchEvent(new Event('input'));
  });
  document.getElementById('colors-count-up').addEventListener('click', () => {
    sliderColorsCount.value = Math.min(16, parseInt(sliderColorsCount.value) + 1);
    sliderColorsCount.dispatchEvent(new Event('input'));
  });

  // Puzzle UI Listeners
  const puzEnable = document.getElementById('input-puzzle-enable');
  const puzCols = document.getElementById('input-puzzle-cols');
  const puzRows = document.getElementById('input-puzzle-rows');
  const puzClearance = document.getElementById('input-puzzle-clearance');
  const puzClearanceLabel = document.getElementById('label-clearance-val');

  puzEnable.addEventListener('change', (e) => {
    state.puzzleEnabled = e.target.checked;
    debounceUpdate();
  });

  puzCols.addEventListener('input', (e) => {
    state.puzzleCols = Math.min(20, Math.max(1, parseInt(e.target.value) || 1));
    debounceUpdate();
  });

  puzRows.addEventListener('input', (e) => {
    state.puzzleRows = Math.min(20, Math.max(1, parseInt(e.target.value) || 1));
    debounceUpdate();
  });

  puzClearance.addEventListener('input', (e) => {
    state.puzzleClearanceMm = Math.min(0.5, Math.max(0, parseFloat(e.target.value) || 0));
    puzClearanceLabel.textContent = state.puzzleClearanceMm.toFixed(2) + ' mm';
    debounceUpdate();
  });
  // Auto-distribute button
  btnAutoDistribute.addEventListener('click', () => {
    const targetCount = Math.max(1, state.layers.length);
    if (state.layers.length !== targetCount) {
      updateLayersCount(targetCount);
      sync2DLayerIndex();
    }
    autoDistributeHeights();
    renderLayersList();
    syncColorCountUI();
    debounceUpdate();
  });

  if (btnMatchColors) {
    btnMatchColors.addEventListener('click', () => {
      showPreviewSpinner('Matching image colors...');
      setTimeout(() => {
        matchImageColors();
      }, 50);
    });
  }

  // Export 3MF button
  btnExport.addEventListener('click', export3MF);

  // Keyboard navigation for 2D layer viewer
  document.addEventListener('keydown', (e) => {
    const pane2D = document.getElementById('pane-2d');
    if (!pane2D || !pane2D.classList.contains('active')) return;
    if (e.key === 'ArrowLeft') { prev2DLayer(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { next2DLayer(); e.preventDefault(); }
  });

  // Close filament picker on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const overlay = document.getElementById('filament-picker-overlay');
      if (overlay && !overlay.classList.contains('hidden')) {
        closeFilamentPicker();
      }
    }
  });
}

// Helper to bind slider/number values back to state
function setupInputListener(elementId, stateField, parseFn, callback) {
  const el = document.getElementById(elementId);
  el.addEventListener('input', () => {
    const val = parseFn(el.value);
    if (!isNaN(val)) {
      state[stateField] = val;
      if (callback) callback();
    }
  });
  el.addEventListener('change', () => {
    const val = parseFn(el.value);
    if (!isNaN(val)) {
      el.value = val;
      state[stateField] = val;
    }
  });
}

// Default Gradient Image (useful on initial load)
function loadDefaultImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');

  // Create a nice radial gradient for a test heightmap
  const grad = ctx.createRadialGradient(150, 150, 20, 150, 150, 140);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.3, '#cccccc');
  grad.addColorStop(0.7, '#666666');
  grad.addColorStop(1, '#000000');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 300, 300);

  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imgWidth = img.width;
    state.imgHeight = img.height;
    const preview = document.getElementById('upload-preview');
    if (preview) { preview.src = img.src; dropZone.classList.add('has-image'); }
    processImage();
  };
  img.src = canvas.toDataURL();
}

// Process Image File
function handleImageFile(file) {
  if (!file.type.match('image.*')) {
    alert('Please upload an image file (PNG/JPG).');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      showPreviewSpinner('Processing image...');
      state.image = img;
      state.imgWidth = img.width;
      state.imgHeight = img.height;

      // Auto adjust aspect ratio
      const aspect = img.width / img.height;
      if (aspect >= 1) {
        state.widthMm = 150;
        state.heightMm = Math.round(150 / aspect);
      } else {
        state.heightMm = 150;
        state.widthMm = Math.round(150 * aspect);
      }

      document.getElementById('input-width').value = state.widthMm;
      document.getElementById('input-height').value = state.heightMm;

      // Show preview in upload zone
      const preview = document.getElementById('upload-preview');
      if (preview) { preview.src = img.src; dropZone.classList.add('has-image'); }

      // Reset flood fill regions when new image is loaded
      ffRegionMask = null;
      ffRegionColors = {};
      ffNextRegionId = 0;
      ffSelectedRegionId = null;
      ffLastFillSet = null;
      const ffClearBtn = document.getElementById('ff-clear-btn');
      if (ffClearBtn) ffClearBtn.style.display = 'none';
      updateRegionPanel();
      
      // Reset color state signature since new geometry is being generated
      _lastColorStateSignature = null;

      processImage();
      matchImageColors();
      autoDistributeHeights();
      renderLayersList();
      if (typeof dashTrackProject === 'function') dashTrackProject();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Remove background from the loaded image
function removeBackground() {
  if (!state.image) return;

  showPreviewSpinner('Removing background...');

  const img = state.image;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  const data = imgData.data;

  // Sample background color from corners
  const cornerPixels = [
    { x: 0, y: 0 },
    { x: c.width - 1, y: 0 },
    { x: 0, y: c.height - 1 },
    { x: c.width - 1, y: c.height - 1 }
  ];
  let rSum = 0, gSum = 0, bSum = 0;
  for (const p of cornerPixels) {
    const i = (p.y * c.width + p.x) * 4;
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
  }
  const bgR = rSum / cornerPixels.length;
  const bgG = gSum / cornerPixels.length;
  const bgB = bSum / cornerPixels.length;

  const tolerance = 40;

  for (let i = 0; i < data.length; i += 4) {
    const dr = Math.abs(data[i] - bgR);
    const dg = Math.abs(data[i + 1] - bgG);
    const db = Math.abs(data[i + 2] - bgB);
    if (dr + dg + db < tolerance) {
      data[i + 3] = 0;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const newSrc = c.toDataURL('image/png');

  // Create new image
  const newImg = new Image();
  newImg.onload = () => {
    state.image = newImg;
    state.imgWidth = newImg.width;
    state.imgHeight = newImg.height;
    const preview = document.getElementById('upload-preview');
    if (preview) preview.src = newSrc;
    processImage();
    matchImageColors();
    autoDistributeHeights();
    renderLayersList();
    hidePreviewSpinner();
  };
  newImg.src = newSrc;
}

// Extract luminance values from image at the active grid resolution
function processImage() {
  if (!state.image) return;

  const res = state.gridResolution;
  const aspect = state.imgWidth / state.imgHeight;

  // Determine grid columns/rows keeping aspect ratio
  let cols, rows;
  if (aspect >= 1) {
    cols = res;
    rows = Math.max(10, Math.round(res / aspect));
  } else {
    rows = res;
    cols = Math.max(10, Math.round(res * aspect));
  }

  state.gridCols = cols;
  state.gridRows = rows;

  // Draw to offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');

  if (state.mirrorX) {
    ctx.translate(cols, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(state.image, 0, 0, cols, rows);

  const imgData = ctx.getImageData(0, 0, cols, rows);
  const pixels = imgData.data;

  state.rawLuminance = new Float32Array(cols * rows);
  state.colorSampleRGB = new Uint8Array(cols * rows * 3);
  state.colorSampleWidth = cols;
  state.colorSampleHeight = rows;

  for (let i = 0; i < cols * rows; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];

    // Relative Luminance formula
    let L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

    if (state.invertHeights) {
      L = 1.0 - L;
    }
    state.rawLuminance[i] = L;
    state.colorSampleRGB[i * 3] = r;
    state.colorSampleRGB[i * 3 + 1] = g;
    state.colorSampleRGB[i * 3 + 2] = b;
  }

  debounceUpdate();
  updateTabsForImage();
}

function syncColorCountUI() {
  const slider = document.getElementById('input-colors-count');
  const label = document.getElementById('label-colors-count');
  if (slider) slider.value = state.layers.length;
  if (label) label.textContent = state.layers.length;
}

function getAdaptiveLayerCount() {
  const requested = Math.max(1, parseInt(state.layersCount) || 1);

  if (!state.colorSampleRGB || state.colorSampleWidth * state.colorSampleHeight === 0) {
    return Math.max(requested, 4);
  }

  const pixelCount = state.colorSampleWidth * state.colorSampleHeight;
  const bins = new Map();
  const binSize = 24;

  for (let i = 0; i < pixelCount; i++) {
    const r = state.colorSampleRGB[i * 3];
    const g = state.colorSampleRGB[i * 3 + 1];
    const b = state.colorSampleRGB[i * 3 + 2];
    const key = `${Math.floor(r / binSize) * binSize},${Math.floor(g / binSize) * binSize},${Math.floor(b / binSize) * binSize}`;
    bins.set(key, (bins.get(key) || 0) + 1);
  }

  const distinctBins = bins.size;
  const estimated = Math.max(4, Math.min(8, Math.ceil(Math.log2(distinctBins + 1))));
  return Math.max(requested, estimated);
}

// Update layers structure based on count slider
function updateLayersCount(newCount) {
  const currentCount = state.layers.length;
  if (newCount === currentCount) return;

  if (newCount < currentCount) {
    state.layers = state.layers.slice(0, newCount);
  } else {
    for (let i = currentCount; i < newCount; i++) {
      let hex, td;
      if (state.filaments.length > 0) {
        const f = state.filaments[i % state.filaments.length];
        hex = f.hex;
        td = f.td;
      } else {
        const colorIdx = i % PRESET_COLORS.length;
        hex = state.invertHeights
          ? PRESET_COLORS[PRESET_COLORS.length - 1 - colorIdx]
          : PRESET_COLORS[colorIdx];
        td = 2.0;
      }
      state.layers.push({
        hex: hex,
        startHeight: state.baseThickness + (state.maxHeight - state.baseThickness) * (i / newCount),
        td: td
      });
    }
  }

  validateLayerHeights();
  state.layersCount = newCount;
}

function addLayerFromColor(hex, td = 2.0) {
  if (!hex) return false;

  const normalized = String(hex).toLowerCase();
  const existingLayerIndex = state.layers.findIndex(layer => String(layer.hex).toLowerCase() === normalized);
  const existingFilamentIndex = state.filaments.findIndex(f => String(f.hex).toLowerCase() === normalized);

  if (existingFilamentIndex === -1) {
    state.filaments.push({
      id: `custom-${Date.now()}`,
      brand: 'Custom',
      material: 'Custom',
      name: 'Custom Color',
      hex,
      td
    });
  } else {
    state.filaments[existingFilamentIndex].td = td;
    state.filaments[existingFilamentIndex].brand = state.filaments[existingFilamentIndex].brand || 'Custom';
    state.filaments[existingFilamentIndex].name = state.filaments[existingFilamentIndex].name || 'Custom Color';
  }

  if (existingLayerIndex !== -1) {
    state.layers[existingLayerIndex].td = td;
    state.layersCount = state.layers.length;
    sync2DLayerIndex();
    renderLayersList();
    debounceUpdate();
    return true;
  }

  updateLayersCount(state.layers.length + 1);
  const addedLayer = state.layers[state.layers.length - 1];
  addedLayer.hex = hex;
  addedLayer.td = td;
  autoDistributeHeights();
  state.layersCount = state.layers.length;
  sync2DLayerIndex();
  renderLayersList();
  debounceUpdate();
  return true;
}

// Force layer start heights to remain in sorted order and inside base/max limits
function validateLayerHeights() {
  const base = state.baseThickness;
  const max = state.maxHeight;

  if (state.layers.length === 0) return;

  // Layer 1 is always locked at 0
  state.layers[0].startHeight = 0.0;

  for (let i = 1; i < state.layers.length; i++) {
    // Snap to layer height multiple
    state.layers[i].startHeight = Math.round(state.layers[i].startHeight / state.layerHeight) * state.layerHeight;

    let prevHeight = i === 1 ? base : state.layers[i - 1].startHeight;
    prevHeight = Math.ceil(prevHeight / state.layerHeight) * state.layerHeight;

    // Enforce that each subsequent layer starts at or after the previous one
    if (state.layers[i].startHeight < prevHeight) {
      state.layers[i].startHeight = prevHeight;
    }

    // Also must not exceed maximum physical height
    let maxH = Math.floor(max / state.layerHeight) * state.layerHeight;
    if (state.layers[i].startHeight > maxH) {
      state.layers[i].startHeight = maxH;
    }
  }
}

function reorderLayers(fromIndex, toIndex) {
  if (!state.layers.length || fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  if (fromIndex === 0 || toIndex === 0) return;

  const [moved] = state.layers.splice(fromIndex, 1);
  state.layers.splice(toIndex, 0, moved);

  const orderedHeights = state.layers.map(layer => layer.startHeight);
  const baseHeight = state.baseThickness;
  const maxHeight = state.maxHeight;
  const step = state.layerHeight;

  state.layers[0].startHeight = 0.0;
  for (let i = 1; i < state.layers.length; i++) {
    const prevHeight = i === 1 ? baseHeight : state.layers[i - 1].startHeight;
    const minHeight = Math.ceil(prevHeight / step) * step;
    const maxH = Math.floor(maxHeight / step) * step;
    let nextHeight = orderedHeights[i] !== undefined ? orderedHeights[i] : minHeight;
    if (nextHeight < minHeight) nextHeight = minHeight;
    if (nextHeight > maxH) nextHeight = maxH;
    state.layers[i].startHeight = nextHeight;
  }

  validateLayerHeights();
  state.layersCount = state.layers.length;
  sync2DLayerIndex();
  syncColorCountUI();
  renderLayersList();
  debounceUpdate();
}

function removeLayerAt(index) {
  if (!state.layers.length || index <= 0) return;

  const removedStart = state.layers[index].startHeight;
  state.layers.splice(index, 1);

  if (state.layers.length > 1 && index < state.layers.length) {
    state.layers[index].startHeight = removedStart;
  }

  if (state.layers.length === 1) {
    state.layers[0].startHeight = 0.0;
  } else {
    validateLayerHeights();
  }

  state.layersCount = state.layers.length;
  sync2DLayerIndex();
  syncColorCountUI();
  renderLayersList();
  debounceUpdate();
}

// Distribute layer heights smartly based on color luminance
function autoDistributeHeights() {
  const count = state.layers.length;
  if (count <= 1) return;

  state.layers[0].startHeight = 0.0;
  const base = state.baseThickness;
  const max = state.maxHeight;

  // Extract normalized luminance of each color
  const lums = state.layers.map(layer => {
    const rgb = hexToRgb(layer.hex);
    let L = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    if (state.invertHeights) L = 1.0 - L;
    return L;
  });

  for (let i = 1; i < count; i++) {
    // Place boundary exactly halfway between the luminance of adjacent colors
    const midL = (lums[i - 1] + lums[i]) / 2;
    state.layers[i].startHeight = base + midL * (max - base);
  }
  validateLayerHeights();
}

// Render dynamic list of color configuration rows
function renderLayersList() {
  layerListContainer.innerHTML = '';

  const lh = state.layerHeight;

  state.layers.forEach((layer, idx) => {
    const row = document.createElement('div');
    row.className = 'layer-row';

    const isBase = idx === 0;
    const layerNum = layer.startHeight === 0 ? 1 : Math.round(layer.startHeight / lh);

    row.draggable = !isBase;
    row.setAttribute('data-layer-index', idx);
    row.innerHTML = `
      <div class="layer-info">
        <span class="layer-title">Color ${idx + 1}</span>
        <div style="flex:1"></div>
        <button class="layer-swatch" id="layer-swatch-${idx}" style="background:${layer.hex}" title="Pick filament"></button>
        <div class="td-input-container">
          <span class="td-label">TD</span>
          <input type="number" class="td-input" value="${layer.td !== undefined ? layer.td : 2.0}" min="0.1" step="0.1" id="layer-td-${idx}">
        </div>
      </div>
      <div class="layer-controls">
        <button class="btn-step" id="layer-step-down-${idx}" ${isBase ? 'disabled' : ''}>-</button>
        <input type="range" class="height-slider" min="0" max="${state.maxHeight}" step="${state.layerHeight}" 
               value="${layer.startHeight}" ${isBase ? 'disabled' : ''} id="layer-slider-${idx}">
        <button class="btn-step" id="layer-step-up-${idx}" ${isBase ? 'disabled' : ''}>+</button>
        <span class="slider-value" id="layer-val-${idx}" style="min-width: 100px;">L${layerNum} (${(layer.startHeight + lh).toFixed(2)} mm)</span>
        <button class="btn-step btn-remove-layer" id="layer-remove-${idx}" ${isBase ? 'disabled' : ''} title="Remove this layer" style="background: #ef4444; color: #ffffff; border-color: #ef4444; width: 20px; height: 20px; font-size: 11px;">✕</button>
      </div>
    `;

    layerListContainer.appendChild(row);

    if (!isBase) {
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
        row.classList.add('dragging');
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const toIndex = idx;
        reorderLayers(fromIndex, toIndex);
      });

      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        document.querySelectorAll('.layer-row.drag-over').forEach(el => el.classList.remove('drag-over'));
      });
    }

    // Bind Layer Swatch (opens filament library)
    const swatchBtn = document.getElementById(`layer-swatch-${idx}`);
    if (swatchBtn) {
      swatchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFilamentPicker(idx);
      });
    }

    // Bind TD Event
    const tdInput = document.getElementById(`layer-td-${idx}`);
    tdInput.addEventListener('change', () => {
      layer.td = parseFloat(tdInput.value) || 2.0;
      debounceUpdate();
    });

    const removeBtn = document.getElementById(`layer-remove-${idx}`);
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        removeLayerAt(idx);
      });
    }

    // Bind Slider and Step Events
    if (!isBase) {
      const slider = document.getElementById(`layer-slider-${idx}`);
      const valLabel = document.getElementById(`layer-val-${idx}`);
      const btnDown = document.getElementById(`layer-step-down-${idx}`);
      const btnUp = document.getElementById(`layer-step-up-${idx}`);

      const updateVal = (val) => {
        // Snap to nearest layer height
        val = Math.round(val / state.layerHeight) * state.layerHeight;

        // Enforce constraints in real-time
        let prevH = idx === 1 ? state.baseThickness : state.layers[idx - 1].startHeight;
        prevH = Math.ceil(prevH / state.layerHeight) * state.layerHeight;

        let nextH = (idx + 1 < state.layers.length) ? state.layers[idx + 1].startHeight : state.maxHeight;
        nextH = Math.floor(nextH / state.layerHeight) * state.layerHeight;

        if (val < prevH) val = prevH;
        if (val > nextH) val = nextH;

        slider.value = val;
        layer.startHeight = val;
        const lNum = val === 0 ? 1 : Math.round(val / state.layerHeight);
        valLabel.textContent = `L${lNum} (${(val + state.layerHeight).toFixed(2)} mm)`;

        debounceUpdate();
      };

      slider.addEventListener('input', () => {
        updateVal(parseFloat(slider.value));
      });

      btnDown.addEventListener('click', () => {
        updateVal(layer.startHeight - state.layerHeight);
      });

      btnUp.addEventListener('click', () => {
        updateVal(layer.startHeight + state.layerHeight);
      });
    }
  });
}

// Sync UI inputs with code state on initial load/change
function updateUIFromState() {
  if (state.layers.length !== state.layersCount) {
    updateLayersCount(state.layersCount);
  }

  document.getElementById('input-width').value = state.widthMm;
  document.getElementById('input-height').value = state.heightMm;
  document.getElementById('input-max-height').value = state.maxHeight;
  document.getElementById('input-base-thickness').value = state.baseThickness;
  document.getElementById('input-layer-height').value = state.layerHeight;
  document.getElementById('input-resolution').value = state.gridResolution;
  document.getElementById('input-triangle-quality').value = state.triangleQuality;
  document.getElementById('input-invert').checked = state.invertHeights;
  const checkboxMirrorX = document.getElementById('input-mirror-x');
  if (checkboxMirrorX) {
    checkboxMirrorX.checked = state.mirrorX;
  }
  const checkboxPosterize = document.getElementById('input-posterize');
  if (checkboxPosterize) {
    checkboxPosterize.checked = state.posterize;
  }
  const checkboxSimulate = document.getElementById('input-simulate-td');
  if (checkboxSimulate) {
    checkboxSimulate.checked = state.simulateTransmission;
  }
  document.getElementById('input-puzzle-enable').checked = state.puzzleEnabled;
  document.getElementById('input-puzzle-cols').value = state.puzzleCols;
  document.getElementById('input-puzzle-rows').value = state.puzzleRows;
  document.getElementById('input-puzzle-clearance').value = state.puzzleClearanceMm;
  document.getElementById('label-clearance-val').textContent = state.puzzleClearanceMm.toFixed(2) + ' mm';

  document.getElementById('input-colors-count').value = state.layersCount;
  document.getElementById('label-colors-count').textContent = state.layersCount;

  renderLayersList();
}

// Get a signature representing the current color state
function getColorStateSignature() {
  const layerHexes = state.layers.map(l => l.hex).join('|');
  return `${layerHexes}:${state.simulateTransmission}`;
}

// Check if only color state has changed (geometry hasn't changed)
function hasOnlyColorChanged() {
  if (!_lastColorStateSignature || modelGroup.children.length === 0) {
    return false; // No previous state or no model exists yet
  }
  if (hasGeometryChanged()) {
    return false; // Geometry changed too
  }
  
  const currentSig = getColorStateSignature();
  return currentSig !== _lastColorStateSignature;
}

// Detect if any geometry-affecting state changed
function hasGeometryChanged() {
  // Geometry changes when these state variables change:
  // - rawLuminance (image changes)
  // - baseThickness, maxHeight (height scaling)
  // - posterize (height quantization)
  // - triangleQuality (mesh density)
  // - puzzleEnabled, puzzleCols, puzzleRows, puzzleClearanceMm (puzzle mode)
  // - mirrorX (mirroring affects heights)
  // - gridResolution (grid size)
  // - widthMm, heightMm (scale)
  // Note: colors do NOT affect geometry
  
  // Simplified: if heights aren't cached, assume geometry changed
  // Otherwise, heights would be cached from last full rebuild
  return _cachedHeights === null;
}

// Update vertex colors in existing meshes without rebuilding geometry
async function updateMeshColorsOnly() {
  if (modelGroup.children.length === 0) return;

  const cols = state.gridCols;
  const rows = state.gridRows;
  const heights = state.simulateTransmission ? getHeightsGrid() : null;

  for (const mesh of modelGroup.children) {
    if (!mesh.geometry || !mesh.userData) continue;

    const layerIndex = mesh.userData.layerIndex;
    if (typeof layerIndex !== 'number') continue;

    const colorData = mesh.geometry.attributes.color.array;

    if (state.simulateTransmission && state.layers.length > 0) {
      // TD mode: color varies per vertex based on height → full per-vertex loop
      const posData = mesh.geometry.attributes.position.array;
      const scaleX = state.widthMm;
      const scaleY = state.heightMm;
      for (let i = 0; i < posData.length; i += 3) {
        const px = posData[i];
        const py = posData[i + 1];
        const x = Math.round((px / scaleX + 0.5) * (cols - 1));
        const y = Math.round((-py / scaleY + 0.5) * (rows - 1));
        let currentR = 0, currentG = 0, currentB = 0;
        if (x >= 0 && x < cols && y >= 0 && y < rows) {
          const h = heights[y * cols + x];
          for (let j = 0; j <= layerIndex; j++) {
            const lStart = state.layers[j].startHeight;
            const lEnd = (j + 1 < state.layers.length) ? state.layers[j + 1].startHeight : state.maxHeight;
            if (h > lStart) {
              const thickness = Math.min(h, lEnd) - lStart;
              if (thickness > 0) {
                const layerTD = state.layers[j].td !== undefined ? state.layers[j].td : 2.0;
                const opacity = 1.0 - Math.pow(0.05, thickness / layerTD);
                const rgb = hexToRgb(state.layers[j].hex);
                if (j === 0) {
                  currentR = rgb.r; currentG = rgb.g; currentB = rgb.b;
                } else {
                  currentR = currentR * (1 - opacity) + rgb.r * opacity;
                  currentG = currentG * (1 - opacity) + rgb.g * opacity;
                  currentB = currentB * (1 - opacity) + rgb.b * opacity;
                }
              }
            }
          }
        }
        colorData[i] = currentR / 255;
        colorData[i + 1] = currentG / 255;
        colorData[i + 2] = currentB / 255;
      }
    } else {
      // Non-TD mode: entire mesh is a single flat color → bulk fill
      const baseC = hexToRgb(state.layers[layerIndex].hex);
      const r = baseC.r / 255;
      const g = baseC.g / 255;
      const b = baseC.b / 255;
      for (let i = 0; i < colorData.length; i += 3) {
        colorData[i] = r;
        colorData[i + 1] = g;
        colorData[i + 2] = b;
      }
    }

    mesh.geometry.attributes.color.needsUpdate = true;
  }

  sceneNeedsRender = true;
  await yieldToUI();
}

// Debounce updates so that sliding doesn't block the UI
function debounceUpdate() {
  if (renderDebounceTimer) {
    clearTimeout(renderDebounceTimer);
  }

  const is3DActive = document.getElementById('pane-3d')?.classList.contains('active');

  if (is3DActive) {
    showPreviewSpinner('Rendering...');
  }

  const draw2DIdle = () => schedule2DRender();
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(draw2DIdle, { timeout: 300 });
  } else {
    setTimeout(draw2DIdle, 0);
  }

  if (!is3DActive) {
    hidePreviewSpinner();
    return;
  }

  renderDebounceTimer = setTimeout(async () => {
    renderDebounceTimer = null;

    // If 3D tab is no longer active, skip the heavy work
    if (!document.getElementById('pane-3d')?.classList.contains('active')) {
      hidePreviewSpinner();
      return;
    }

    // Check if only colors changed (no geometry changes)
    if (hasOnlyColorChanged() && modelGroup.children.length > 0) {
      // Fast path: update vertex colors only
      await updateMeshColorsOnly();
    } else {
      // Full rebuild: geometry or first-time render
      _cachedHeights = null;
      await update3DPreview();
      updateTransitionTable();
    }
    
    // Update signature tracking for next change detection
    _lastColorStateSignature = getColorStateSignature();
    
    hidePreviewSpinner();
    if (typeof dashTrackSave === 'function') dashTrackSave();
  }, 200);
}

function showExportProgress() {
  if (exportProgressResetTimer) {
    clearTimeout(exportProgressResetTimer);
    exportProgressResetTimer = null;
  }
  if (exportProgressContainer) {
    exportProgressContainer.classList.add('visible');
  }
}

function updateExportProgress(percent, status) {
  const safePercent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  showExportProgress();
  if (exportProgressStatus && status) {
    exportProgressStatus.textContent = status;
  }
  if (exportProgressFill) {
    exportProgressFill.style.width = `${safePercent.toFixed(0)}%`;
  }
  if (exportProgressMeta) {
    exportProgressMeta.textContent = `${safePercent.toFixed(0)}%`;
  }
  if (btnExport) {
    btnExport.textContent = `Exporting... ${safePercent.toFixed(0)}%`;
  }
}

function finishExportProgress(status) {
  updateExportProgress(100, status || 'Export complete.');
  exportProgressResetTimer = setTimeout(() => {
    if (exportProgressContainer) {
      exportProgressContainer.classList.remove('visible');
    }
    if (exportProgressFill) {
      exportProgressFill.style.width = '0%';
    }
    if (exportProgressMeta) {
      exportProgressMeta.textContent = '0%';
    }
    if (exportProgressStatus) {
      exportProgressStatus.textContent = 'Preparing export...';
    }
  }, 2000);
}

function failExportProgress(status) {
  showExportProgress();
  if (exportProgressStatus) {
    exportProgressStatus.textContent = status || 'Export failed.';
  }
}

function yieldToUI() {
  return new Promise(resolve => {
    requestAnimationFrame(() => resolve());
  });
}

function showPreviewSpinner(text) {
  document.getElementById('preview-empty').classList.add('hidden');
  const spinner = document.getElementById('preview-spinner');
  const textEl = document.getElementById('preview-spinner-text');
  if (spinner) spinner.classList.remove('hidden');
  if (textEl && text) textEl.textContent = text;
  updateCardShadow();
}

function hidePreviewSpinner() {
  document.getElementById('preview-spinner').classList.add('hidden');
  if (!state.rawLuminance) {
    document.getElementById('preview-empty').classList.remove('hidden');
    document.getElementById('layer-nav').classList.add('hidden');
    const ffTb = document.getElementById('ff-toolbar');
    if (ffTb) ffTb.style.display = 'none';
  } else {
    document.getElementById('layer-nav').classList.remove('hidden');
    const ffTb = document.getElementById('ff-toolbar');
    if (ffTb) ffTb.style.display = '';
  }
  updateCardShadow();
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

function shadeHex(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  const shade = (channel) => Math.max(0, Math.min(255, Math.round(channel * factor)));
  const toHex = (channel) => shade(channel).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function buildLayerSliceCanvas(layerIndex, heights, cols, rows) {
  const layer = state.layers[layerIndex];
  const offscreen = document.createElement('canvas');
  offscreen.width = cols;
  offscreen.height = rows;

  const ctx = offscreen.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);
  const data = imgData.data;

  // Re-calculate colors for each pixel based on transmission or posterization
  for (let i = 0; i < cols * rows; i++) {
    let h = heights[i];
    let r, g, b;

    if (state.simulateTransmission && state.layers.length > 0) {
      // Simulate Light Transmission (HueForge style)
      let currentR = 0, currentG = 0, currentB = 0;

      for (let j = 0; j < state.layers.length; j++) {
        const lStart = state.layers[j].startHeight;
        const lEnd = (j + 1 < state.layers.length) ? state.layers[j + 1].startHeight : state.maxHeight;

        if (h > lStart) {
          const thickness = Math.min(h, lEnd) - lStart;
          if (thickness > 0) {
            const layerTD = state.layers[j].td !== undefined ? state.layers[j].td : 2.0;
            // Opacity based on transmission: opacity approaches 95% at TD
            const opacity = 1.0 - Math.pow(0.05, thickness / layerTD);

            const rgb = hexToRgb(state.layers[j].hex);
            if (j === 0) {
              // Base layer is fully opaque
              currentR = rgb.r; currentG = rgb.g; currentB = rgb.b;
            } else {
              currentR = currentR * (1 - opacity) + rgb.r * opacity;
              currentG = currentG * (1 - opacity) + rgb.g * opacity;
              currentB = currentB * (1 - opacity) + rgb.b * opacity;
            }
          }
        }
      }
      r = currentR; g = currentG; b = currentB;
    } else {
      // Standard Posterized Rendering
      let layerIdx = 0;
      for (let j = 1; j < state.layers.length; j++) {
        if (h >= state.layers[j].startHeight) {
          layerIdx = j;
        }
      }
      const baseColor = hexToRgb(state.layers[layerIdx].hex);
      r = baseColor.r; g = baseColor.g; b = baseColor.b;
    }

    if (h < layer.startHeight) {
      // Background pixels or lower layers transparent
      data[i * 4 + 3] = 0;
    } else {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return offscreen;
}

function draw2DSimulation() {
  if (!state.rawLuminance || !canvas2D) return;

  const cols = state.gridCols;
  const rows = state.gridRows;
  const heights = getHeightsGrid();
  const idx = current2DLayerIndex;

  const canvasW = canvas2D.parentElement ? canvas2D.parentElement.clientWidth - 40 : 300;
  const canvasH = canvas2D.parentElement ? canvas2D.parentElement.clientHeight - 40 : 300;
  const cellSize = Math.max(2, Math.floor(Math.min(canvasW / cols, canvasH / rows)));
  const imgW = cols * cellSize;
  const imgH = rows * cellSize;
  const targetHeight = imgH + 60;

  const renderKey = get2DRenderCacheKey();
  const needsRebuild = _2dBaseCacheKey !== renderKey || !_2dBaseCacheCanvas || _2dBaseCacheCanvas.width !== cols || _2dBaseCacheCanvas.height !== rows;

  if (needsRebuild) {
    const imgData = ensure2DBaseCache(cols, rows);
    const data = imgData.data;

    for (let i = 0; i < cols * rows; i++) {
      const h = heights[i];
      let r, g, b;

      if (ffRegionMask && ffRegionMask[i] >= 0) {
        const overrideHex = ffRegionColors[ffRegionMask[i]];
        if (overrideHex) {
          const oc = hexToRgb(overrideHex);
          r = oc.r; g = oc.g; b = oc.b;
          data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
          continue;
        }
      }

      if (state.simulateTransmission && state.layers.length > 0) {
        let cr = 0, cg = 0, cb = 0;
        for (let j = 0; j <= idx; j++) {
          const ls = state.layers[j].startHeight;
          const le = (j + 1 < state.layers.length) ? state.layers[j + 1].startHeight : state.maxHeight;
          if (h > ls) {
            const t = Math.min(h, le) - ls;
            if (t > 0) {
              const td = state.layers[j].td !== undefined ? state.layers[j].td : 2.0;
              const op = 1.0 - Math.pow(0.05, t / td);
              const rgb = hexToRgb(state.layers[j].hex);
              if (j === 0) { cr = rgb.r; cg = rgb.g; cb = rgb.b; }
              else { cr = cr * (1 - op) + rgb.r * op; cg = cg * (1 - op) + rgb.g * op; cb = cb * (1 - op) + rgb.b * op; }
            }
          }
        }
        r = cr; g = cg; b = cb;
      } else {
        let li = 0;
        for (let j = 1; j <= idx; j++) {
          if (h >= state.layers[j].startHeight) li = j;
        }
        const bc = hexToRgb(state.layers[li].hex);
        r = bc.r; g = bc.g; b = bc.b;
      }

      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }

    const baseCtx = _2dBaseCacheCanvas.getContext('2d');
    baseCtx.putImageData(imgData, 0, 0);
    _2dBaseCacheKey = renderKey;
  }

  if (canvas2D.width !== imgW || canvas2D.height !== targetHeight) {
    canvas2D.width = imgW;
    canvas2D.height = targetHeight;
  }

  const ctx = canvas2D.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas2D.width, canvas2D.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(_2dBaseCacheCanvas, 0, 0, imgW, imgH);

  // Draw flood fill pending selection highlight (last BFS result before assign)
  if (ffLastFillSet && ffLastFillSet.size > 0) {
    ctx.fillStyle = 'rgba(85, 186, 8, 0.30)';
    for (const pixIdx of ffLastFillSet) {
      const px = pixIdx % cols;
      const py = Math.floor(pixIdx / cols);
      ctx.fillRect(px * cellSize, py * cellSize, cellSize, cellSize);
    }
    // Draw marching-ants border (simple thick outline)
    ctx.strokeStyle = 'rgba(85,186,8,0.9)';
    ctx.lineWidth = 1.5;
    for (const pixIdx of ffLastFillSet) {
      const px = pixIdx % cols;
      const py = Math.floor(pixIdx / cols);
      const neighbors = [
        [px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || !ffLastFillSet.has(ny * cols + nx)) {
          const ex1 = nx < px ? px * cellSize : (nx > px ? (px + 1) * cellSize : px * cellSize);
          const ey1 = ny < py ? py * cellSize : (ny > py ? (py + 1) * cellSize : py * cellSize);
          const ex2 = nx < px ? px * cellSize : (nx > px ? (px + 1) * cellSize : (px + 1) * cellSize);
          const ey2 = ny < py ? py * cellSize : (ny > py ? (py + 1) * cellSize : (py + 1) * cellSize);
          ctx.beginPath();
          ctx.moveTo(ex1, ey1);
          ctx.lineTo(ex2, ey2);
          ctx.stroke();
        }
      }
    }
  }

  // Draw selected region highlight
  if (ffSelectedRegionId !== null && ffRegionMask) {
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (let i = 0; i < ffRegionMask.length; i++) {
      if (ffRegionMask[i] === ffSelectedRegionId) {
        const px = i % cols;
        const py = Math.floor(i / cols);
        ctx.fillRect(px * cellSize, py * cellSize, cellSize, cellSize);
      }
    }
  }

  if (state.puzzleEnabled) {
    drawPuzzleCuts(ctx, cols, rows, state.puzzleCols, state.puzzleRows, cellSize);
  } else {
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize, 0);
      ctx.lineTo(x * cellSize, imgH);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize);
      ctx.lineTo(imgW, y * cellSize);
      ctx.stroke();
    }
  }

  const barY = imgH + 8;
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, barY, canvas2D.width, 56);

  ctx.fillStyle = '#111827';
  ctx.font = '600 30px Poppins, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Layer ${idx + 1} of ${state.layers.length}`, 12, barY + 40);

  // Right-aligned color swatches - layer 1 shows 1, layer 2 shows 2, etc.
  const swatchSize = 24;
  const swatchGap = 5;
  const numSwatches = idx + 1;
  const totalSwatchesW = numSwatches * swatchSize + (numSwatches - 1) * swatchGap + 8;
  let sx = canvas2D.width - totalSwatchesW - 12;
  const sy = barY + (56 - swatchSize) / 2;
  for (let i = 0; i < numSwatches; i++) {
    const isCurrent = i === idx;
    const s = isCurrent ? swatchSize + 8 : swatchSize;
    const yOff = isCurrent ? -4 : 0;
    ctx.fillStyle = state.layers[i].hex;
    ctx.fillRect(sx, sy + yOff, s, s);
    ctx.strokeStyle = isCurrent ? '#111827' : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = isCurrent ? 2.5 : 1;
    ctx.strokeRect(sx, sy + yOff, s, s);
    sx += s + swatchGap;
  }
}

// ─── Flood Fill Functions ─────────────────────────────────────────────────────

function toggleFloodFillMode() {
  ffModeActive = !ffModeActive;
  const btn = document.getElementById('ff-toggle-btn');
  const panel = document.getElementById('ff-region-panel');
  if (btn) btn.classList.toggle('active', ffModeActive);
  canvas2D.classList.toggle('ff-cursor', ffModeActive);

  if (ffModeActive) {
    panel.classList.remove('hidden');
    ffLastFillSet = null;
    updateRegionPanel();
    schedule2DRender();
  } else {
    ffLastFillSet = null;
    ffSelectedRegionId = null;
    // Keep panel visible if there are saved regions
    if (Object.keys(ffRegionColors).length === 0) {
      panel.classList.add('hidden');
    }
    updateRegionPanel();
    schedule2DRender();
  }
}

function floodFillBFS(startIdx) {
  const cols = state.gridCols;
  const rows = state.gridRows;
  const heights = getHeightsGrid();
  const targetH = heights[startIdx];
  const tolerance = 0.001; // heights are snapped so exact match needed

  const visited = new Set();
  const queue = [startIdx];
  visited.add(startIdx);

  while (queue.length > 0) {
    const cur = queue.shift();
    const cx = cur % cols;
    const cy = Math.floor(cur / cols);
    const neighbors = [
      [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const nIdx = ny * cols + nx;
      if (visited.has(nIdx)) continue;
      if (Math.abs(heights[nIdx] - targetH) <= tolerance) {
        visited.add(nIdx);
        queue.push(nIdx);
      }
    }
  }
  return visited;
}

function initRegionMask() {
  const size = state.gridCols * state.gridRows;
  if (!ffRegionMask || ffRegionMask.length !== size) {
    ffRegionMask = new Int16Array(size).fill(-1);
  }
}

function onCanvas2DClick(e) {
  if (!ffModeActive || !state.rawLuminance) return;

  const rect = canvas2D.getBoundingClientRect();
  const scaleX = canvas2D.width / rect.width;
  const scaleY = canvas2D.height / rect.height;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top) * scaleY;

  const cols = state.gridCols;
  const rows = state.gridRows;

  // Compute cell size (same as draw2DSimulation)
  const canvasW = canvas2D.parentElement.clientWidth - 40;
  const canvasH = canvas2D.parentElement.clientHeight - 40;
  const cellSize = Math.max(2, Math.floor(Math.min(canvasW / cols, canvasH / rows)));
  const imgH = rows * cellSize;

  // Ignore clicks in the info bar below the image
  if (cy >= imgH) return;

  const gridX = Math.floor(cx / cellSize);
  const gridY = Math.floor(cy / cellSize);
  if (gridX < 0 || gridX >= cols || gridY < 0 || gridY >= rows) return;

  const pixIdx = gridY * cols + gridX;

  // If clicking on an already-assigned region, select it for editing
  if (ffRegionMask && ffRegionMask[pixIdx] >= 0) {
    ffSelectedRegionId = ffRegionMask[pixIdx];
    ffLastFillSet = null;
    const panel = document.getElementById('ff-region-panel');
    panel.classList.remove('hidden');
    const applyBtn = document.getElementById('ff-apply-btn');
    if (applyBtn) {
      applyBtn.textContent = 'Apply to Selection';
      applyBtn.disabled = false;
    }
    updateRegionPanel();
    schedule2DRender();
    return;
  }

  // Otherwise run flood fill from this pixel
  ffSelectedRegionId = null;
  ffLastFillSet = floodFillBFS(pixIdx);

  const panel = document.getElementById('ff-region-panel');
  panel.classList.remove('hidden');
  const applyBtn = document.getElementById('ff-apply-btn');
  if (applyBtn) applyBtn.disabled = false;
  updateRegionPanel();
  invalidate2DCache();
  schedule2DRender();
}

function applyRegionColor() {
  const colorInput = document.getElementById('ff-color-pick');
  const hex = colorInput ? colorInput.value : '#ff6600';

  if (ffSelectedRegionId !== null) {
    // Re-color an existing region
    ffRegionColors[ffSelectedRegionId] = hex;
    ffSelectedRegionId = null;
  } else if (ffLastFillSet && ffLastFillSet.size > 0) {
    // Assign a new region
    initRegionMask();
    const rid = ffNextRegionId++;
    ffRegionColors[rid] = hex;
    for (const idx of ffLastFillSet) {
      ffRegionMask[idx] = rid;
    }
    ffLastFillSet = null;
    const clearBtn = document.getElementById('ff-clear-btn');
    if (clearBtn) clearBtn.style.display = '';
  }

  addLayerFromColor(hex);

  const applyBtn = document.getElementById('ff-apply-btn');
  if (applyBtn) applyBtn.disabled = true;
  updateRegionPanel();
  invalidate2DCache();
  schedule2DRender();
}

function deleteRegion(rid) {
  if (!ffRegionMask) return;
  for (let i = 0; i < ffRegionMask.length; i++) {
    if (ffRegionMask[i] === rid) ffRegionMask[i] = -1;
  }
  delete ffRegionColors[rid];
  if (ffSelectedRegionId === rid) ffSelectedRegionId = null;
  if (Object.keys(ffRegionColors).length === 0) {
    const clearBtn = document.getElementById('ff-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';
  }
  updateRegionPanel();
  schedule2DRender();
}

function clearAllRegions() {
  ffRegionMask = null;
  ffRegionColors = {};
  ffNextRegionId = 0;
  ffSelectedRegionId = null;
  ffLastFillSet = null;
  const clearBtn = document.getElementById('ff-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
  const applyBtn = document.getElementById('ff-apply-btn');
  if (applyBtn) applyBtn.disabled = true;
  updateRegionPanel();
  schedule2DRender();
}

function updateRegionPanel() {
  const list = document.getElementById('ff-region-list');
  const panel = document.getElementById('ff-region-panel');
  const applyBtn = document.getElementById('ff-apply-btn');
  if (!list) return;

  const ids = Object.keys(ffRegionColors);

  // Show panel if fill mode is active OR if there are saved regions
  if (panel) {
    if (ffModeActive || ids.length > 0) {
      panel.classList.remove('hidden');
    }
  }

  // Update apply button text/state
  if (applyBtn) {
    if (ffSelectedRegionId !== null) {
      applyBtn.textContent = 'Re-color Region';
      applyBtn.disabled = false;
    } else if (ffLastFillSet && ffLastFillSet.size > 0) {
      applyBtn.textContent = 'Add to List ↓';
      applyBtn.disabled = false;
    } else {
      applyBtn.textContent = 'Select an area first';
      applyBtn.disabled = true;
    }
  }

  if (ids.length === 0) {
    list.innerHTML = ffModeActive
      ? '<div style="font-size:11px;color:var(--text-sub);padding:2px 0;">Click any area on the canvas to select it.</div>'
      : '';
    return;
  }

  list.innerHTML = ids.map(rid => {
    const hex = ffRegionColors[rid];
    const isSelected = parseInt(rid) === ffSelectedRegionId;
    return `<div class="ff-region-item${isSelected ? ' selected' : ''}" onclick="selectRegionFromPanel(${rid})">
      <div class="ff-region-swatch" style="background:${hex}"></div>
      <span class="ff-region-label">Region ${parseInt(rid) + 1}</span>
      <button class="ff-region-del" onclick="event.stopPropagation();deleteRegion(${rid})" title="Remove region">✕</button>
    </div>`;
  }).join('');
}

function selectRegionFromPanel(rid) {
  ffSelectedRegionId = rid;
  ffLastFillSet = null;
  const applyBtn = document.getElementById('ff-apply-btn');
  if (applyBtn) {
    applyBtn.textContent = 'Apply to Selection';
    applyBtn.disabled = false;
  }
  updateRegionPanel();
  schedule2DRender();
}

window.toggleFloodFillMode = toggleFloodFillMode;
window.applyRegionColor = applyRegionColor;
window.clearAllRegions = clearAllRegions;
window.deleteRegion = deleteRegion;
window.selectRegionFromPanel = selectRegionFromPanel;
// ─────────────────────────────────────────────────────────────────────────────

function prev2DLayer() {
  if (current2DLayerIndex > 0) {
    current2DLayerIndex--;
    schedule2DRender();
  }
}

function next2DLayer() {
  if (current2DLayerIndex < state.layers.length - 1) {
    current2DLayerIndex++;
    schedule2DRender();
  }
}

window.prev2DLayer = prev2DLayer;
window.next2DLayer = next2DLayer;

// Build height map grid of physical heights (cached)
function getHeightsGrid() {
  // Build a lightweight cache key from current settings
  const key = `${state.gridCols},${state.gridRows},${state.baseThickness},${state.maxHeight},${state.posterize},` +
    state.layers.map(l => l.startHeight).join(',');

  if (_cachedHeights && _cachedHeightsKey === key) {
    return _cachedHeights;
  }

  const cols = state.gridCols;
  const rows = state.gridRows;
  const base = state.baseThickness;
  const max = state.maxHeight;

  const heights = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    let h = base + state.rawLuminance[i] * (max - base);

    if (state.posterize && state.layers.length > 0) {
      let layerIdx = 0;
      for (let j = 1; j < state.layers.length; j++) {
        if (h >= state.layers[j].startHeight) {
          layerIdx = j;
        }
      }
      // Snap height perfectly into the determined layer to create flat, crisp regions
      let snappedH = layerIdx === state.layers.length - 1 ? max : state.layers[layerIdx + 1].startHeight - 0.001;
      h = Math.max(base, snappedH);
    }

    heights[i] = h;
  }

  _cachedHeights = heights;
  _cachedHeightsKey = key;
  return heights;
}

// Build 3D Mesh layers and show in Three.js Scene
async function update3DPreview() {
  if (!state.rawLuminance) return;

  const pane3D = document.getElementById('pane-3d');
  if (pane3D && !pane3D.classList.contains('active')) return;

  // Skip full rebuild if model already rendered and nothing changed
  if (modelGroup.children.length > 0) {
    const colorChanged = getColorStateSignature() !== _lastColorStateSignature;
    if (!colorChanged && !hasGeometryChanged()) {
      sceneNeedsRender = true;
      return;
    }
  }

  while (modelGroup.children.length > 0) {
    const obj = modelGroup.children[0];
    obj.geometry.dispose();
    if (Array.isArray(obj.material)) {
      obj.material.forEach(m => m.dispose());
    } else {
      obj.material.dispose();
    }
    modelGroup.remove(obj);
  }

  const cols = state.gridCols;
  const rows = state.gridRows;
  const heights = getHeightsGrid();

  const scaleX = state.widthMm;
  const scaleY = state.heightMm;

  _modelVertexCount = 0;
  _modelTriangleCount = 0;

  let puzzleMap = null;
  let numPieces = 1;
  if (state.puzzleEnabled) {
    puzzleMap = generatePuzzleMap(cols, rows, state.puzzleCols, state.puzzleRows, state.puzzleClearanceMm, scaleX, scaleY);
    numPieces = state.puzzleCols * state.puzzleRows;
  }

  for (let k = 0; k < state.layers.length; k++) {
    const layer = state.layers[k];
    const zMin = layer.startHeight;
    const zMax = (k + 1 < state.layers.length) ? state.layers[k + 1].startHeight : state.maxHeight;

    for (let p = 1; p <= numPieces; p++) {
      const meshData = buildLayerGeometry(heights, cols, rows, scaleX, scaleY, zMin, zMax, puzzleMap, state.puzzleEnabled ? p : 0, k === 0, state.mirrorX, state.maxHeight, k);
      if (meshData.triangles.length === 0) continue;

      _modelVertexCount += meshData.vertices.length / 3;
      _modelTriangleCount += meshData.triangles.length / 3;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(meshData.vertices, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(meshData.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(meshData.triangles, 1));
      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.7,
        metalness: 0.1,
        flatShading: false,
        side: THREE.DoubleSide
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.layerIndex = k; // Store layer index for color-only updates

      modelGroup.add(mesh);

      // Yield to UI every layer so the spinner animates and UI stays responsive
      if ((k + p) % 2 === 0) {
        await yieldToUI();
      }
    }
  }

  sceneNeedsRender = true;
  updateModelInfoCard();
  
  // Initialize color state signature after full rebuild for future comparisons
  _lastColorStateSignature = getColorStateSignature();
}

function updateModelInfoCard() {
  const sizeEl = document.getElementById('info-size');
  const layersEl = document.getElementById('info-layers');
  const lhEl = document.getElementById('info-lh');
  const maxhEl = document.getElementById('info-maxh');
  const gridEl = document.getElementById('info-grid');
  const vertsEl = document.getElementById('info-vertices');
  const trisEl = document.getElementById('info-triangles');
  if (!sizeEl) return;

  sizeEl.textContent = `${Math.round(state.widthMm)} × ${Math.round(state.heightMm)} mm`;
  layersEl.textContent = state.layers.length;
  lhEl.textContent = state.layerHeight.toFixed(2) + ' mm';
  maxhEl.textContent = state.maxHeight.toFixed(2) + ' mm';
  gridEl.textContent = `${state.gridCols} × ${state.gridRows}`;
  vertsEl.textContent = _modelVertexCount.toLocaleString();
  trisEl.textContent = _modelTriangleCount.toLocaleString();
}

// Updates filament transition instructions text/table
function updateTransitionTable() {
  const tableBody = document.getElementById('transition-table-body');
  if (!tableBody) return;

  tableBody.innerHTML = '';

  if (state.mirrorX) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="4" style="text-align:center; color: var(--accent); padding: 20px;">
      <i data-lucide="alert-triangle" style="width: 16px; height: 16px; vertical-align: middle;"></i> 
      <strong>Face-Down Mode requires an AMS/MMU.</strong><br>
      Colors exist on the same Z-height, so manual filament swaps (M600) will not work.
    </td>`;
    tableBody.appendChild(row);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return;
  }

  const lh = state.layerHeight;
  if (lh <= 0) return;

  state.layers.forEach((layer, idx) => {
    const height = layer.startHeight;
    const layerNum = height === 0 ? 1 : Math.round(height / lh);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span class="color-swatch-sm" style="background-color: ${layer.hex}"></span> Layer ${idx + 1}</td>
      <td>${layer.hex.toUpperCase()}</td>
      <td>${(height + lh).toFixed(2)} mm</td>
      <td><strong>Layer ${layerNum}</strong></td>
    `;
    tableBody.appendChild(row);
  });
}

// Puzzle edge cache (shared across 2D, 3D, and export so all views use the same balanced edge patterns)
let _puzzleEdgeCache = null;
let _puzzleEdgeCacheKey = '';

function getBalancedPuzzleParams() {
  const tabRatio = 0.18 + (Math.random() - 0.5) * 0.04;
  const neckRatio = 0.06 + (Math.random() - 0.5) * 0.015;
  const headRatio = 0.13 + (Math.random() - 0.5) * 0.02;
  const bowRatio = 0.012 + (Math.random() - 0.5) * 0.012;

  return {
    tabRatio: Math.max(0.13, Math.min(0.24, tabRatio)),
    neckRatio: Math.max(0.04, Math.min(0.09, neckRatio)),
    headRatio: Math.max(0.1, Math.min(0.17, headRatio)),
    bowRatio: Math.max(0.002, Math.min(0.03, bowRatio))
  };
}

function generateEdges(cols, rows) {
  const key = cols + 'x' + rows;
  if (_puzzleEdgeCache && _puzzleEdgeCacheKey === key) return _puzzleEdgeCache;

  const vEdges = [];
  const vEdgeParams = [];
  for (let r = 0; r < rows; r++) {
    const rowEdges = [];
    const rowParams = [];
    for (let c = 0; c < cols - 1; c++) {
      rowEdges.push(Math.random() > 0.5 ? 1 : -1);
      rowParams.push(getBalancedPuzzleParams());
    }
    vEdges.push(rowEdges);
    vEdgeParams.push(rowParams);
  }

  const hEdges = [];
  const hEdgeParams = [];
  for (let r = 0; r < rows - 1; r++) {
    const rowEdges = [];
    const rowParams = [];
    for (let c = 0; c < cols; c++) {
      rowEdges.push(Math.random() > 0.5 ? 1 : -1);
      rowParams.push(getBalancedPuzzleParams());
    }
    hEdges.push(rowEdges);
    hEdgeParams.push(rowParams);
  }

  _puzzleEdgeCache = { vEdges, vEdgeParams, hEdges, hEdgeParams };
  _puzzleEdgeCacheKey = key;
  return _puzzleEdgeCache;
}

function drawJigsawLine(ctx, x0, y0, x1, y1, tabDir, params) {
  if (tabDir === 0) {
    ctx.lineTo(x1, y1);
    return;
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = dx / len;
  const ny = dy / len;
  const px = -ny;
  const py = nx;

  const cx = len / 2;
  const neck = len * (params ? params.neckRatio : 0.08);
  const head = len * (params ? params.headRatio : 0.16);
  const h = len * (params ? params.tabRatio : 0.22) * (-tabDir);
  const bow = len * (params ? params.bowRatio : 0.03) * tabDir;

  function lb(lx, ly, lx2, ly2, lx3, ly3) {
    ctx.bezierCurveTo(
      x0 + lx * nx + ly * px,
      y0 + lx * ny + ly * py,
      x0 + lx2 * nx + ly2 * px,
      y0 + lx2 * ny + ly2 * py,
      x0 + lx3 * nx + ly3 * px,
      y0 + lx3 * ny + ly3 * py
    );
  }

  lb(0.15 * len, bow, 0.35 * len, bow, cx - neck, 0);
  lb(cx - neck, h * 0.2, cx - head, h * 0.5, cx - head, h * 0.7);
  lb(cx - head, h * 1.15, cx + head, h * 1.15, cx + head, h * 0.7);
  lb(cx + head, h * 0.5, cx + neck, h * 0.2, cx + neck, 0);
  lb(0.65 * len, bow, 0.85 * len, bow, len, 0);
}

function drawPuzzleCuts(ctx, gridCols, gridRows, puzzleCols, puzzleRows, cellSize) {
  const edges = generateEdges(puzzleCols, puzzleRows);
  const { vEdges, vEdgeParams, hEdges, hEdgeParams } = edges;

  const pieceW = (gridCols * cellSize) / puzzleCols;
  const pieceH = (gridRows * cellSize) / puzzleRows;

  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, Math.min(pieceW, pieceH) * 0.08);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Horizontal cuts (between puzzle rows)
  for (let r = 0; r < puzzleRows - 1; r++) {
    for (let c = 0; c < puzzleCols; c++) {
      const x0 = c * pieceW;
      const y0 = (r + 1) * pieceH;
      const x1 = (c + 1) * pieceW;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      drawJigsawLine(ctx, x0, y0, x1, y0, hEdges[r][c], hEdgeParams[r][c]);
      ctx.stroke();
    }
  }

  // Vertical cuts (between puzzle columns)
  for (let r = 0; r < puzzleRows; r++) {
    for (let c = 0; c < puzzleCols - 1; c++) {
      const x0 = (c + 1) * pieceW;
      const y0 = r * pieceH;
      const y1 = (r + 1) * pieceH;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      drawJigsawLine(ctx, x0, y0, x0, y1, vEdges[r][c], vEdgeParams[r][c]);
      ctx.stroke();
    }
  }

  // Outer boundary
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = Math.max(1.5, Math.min(pieceW, pieceH) * 0.1);
  ctx.strokeRect(0, 0, gridCols * cellSize, gridRows * cellSize);
  ctx.restore();
}

// Generate a 2D map of puzzle pieces, where each pixel corresponds to a piece ID (1 to N) or 0 (clearance gap)
function generatePuzzleMap(W, H, cols, rows, clearanceMm, scaleX, scaleY) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Clear with 0 (gap)
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.fillRect(0, 0, W, H);

  const cellW = W / cols;
  const cellH = H / rows;

  const { vEdges, vEdgeParams, hEdges, hEdgeParams } = generateEdges(cols, rows);

  // Draw each puzzle piece
  let pieceId = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.beginPath();
      const x0 = c * cellW;
      const y0 = r * cellH;
      const x1 = (c + 1) * cellW;
      const y1 = (r + 1) * cellH;

      ctx.moveTo(x0, y0);

      // Top edge
      drawJigsawLine(ctx, x0, y0, x1, y0, r === 0 ? 0 : -hEdges[r - 1][c], r === 0 ? null : hEdgeParams[r - 1][c]);
      // Right edge
      drawJigsawLine(ctx, x1, y0, x1, y1, c === cols - 1 ? 0 : vEdges[r][c], c === cols - 1 ? null : vEdgeParams[r][c]);
      // Bottom edge
      drawJigsawLine(ctx, x1, y1, x0, y1, r === rows - 1 ? 0 : hEdges[r][c], r === rows - 1 ? null : hEdgeParams[r][c]);
      // Left edge
      drawJigsawLine(ctx, x0, y1, x0, y0, c === 0 ? 0 : -vEdges[r][c - 1], c === 0 ? null : vEdgeParams[r][c - 1]);

      ctx.closePath();

      // Fill with pieceId (using the red channel to store ID)
      ctx.fillStyle = `rgba(${pieceId}, 0, 0, 1)`;
      ctx.fill();
      pieceId++;
    }
  }

  // Now, stroke all boundaries with 0 to create the clearance gap
  const clearancePixels = (clearanceMm / scaleX) * W;
  if (clearancePixels > 0) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = clearancePixels;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Stroke all piece edges
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * cellW;
        const y0 = r * cellH;
        const x1 = (c + 1) * cellW;
        const y1 = (r + 1) * cellH;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        drawJigsawLine(ctx, x0, y0, x1, y0, r === 0 ? 0 : -hEdges[r - 1][c], r === 0 ? null : hEdgeParams[r - 1][c]);
        drawJigsawLine(ctx, x1, y0, x1, y1, c === cols - 1 ? 0 : vEdges[r][c], c === cols - 1 ? null : vEdgeParams[r][c]);
        drawJigsawLine(ctx, x1, y1, x0, y1, r === rows - 1 ? 0 : hEdges[r][c], r === rows - 1 ? null : hEdgeParams[r][c]);
        drawJigsawLine(ctx, x0, y1, x0, y0, c === 0 ? 0 : -vEdges[r][c - 1], c === 0 ? null : vEdgeParams[r][c - 1]);
        ctx.stroke();
      }
    }
  }

  // Extract pixel data. Red channel contains piece ID. 0 means gap.
  const imgData = ctx.getImageData(0, 0, W, H).data;
  const map = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // If alpha is 0 (due to destination-out), ID is 0
    map[i] = imgData[i * 4 + 3] === 0 ? 0 : imgData[i * 4];
  }

  return map;
}

// Build Watertight Mesh Geometry for a single layer slice
function buildLayerGeometry(heights, W, H, scaleX, scaleY, zMin, zMax, puzzleMap = null, targetPieceId = 0, isBaseLayer = false, isFaceDown = false, maxHeight = 3.0, layerIndex = 0) {
  let step = 1;
  if (typeof state.triangleQuality === 'number') {
    step = Math.max(1, Math.round(Math.sqrt(100 / state.triangleQuality)));
  } else if (state.triangleQuality === 'low') step = 8;
  else if (state.triangleQuality === 'normal') step = 4;
  else if (state.triangleQuality === 'high') step = 2;

  const vertices = [];
  const triangles = [];
  const epsilon = 0.001;

  const vertexMap = new Int32Array(W * H).fill(-1);
  let activeVertCount = 0;

  const activeCells = new Uint8Array((W - 1) * (H - 1));
  const activeVertsSet = new Uint8Array(W * H);

  const getZ = (h) => {
    if (isFaceDown) {
      if (isBaseLayer) {
        return { bot: Math.max(0, h - zMax), top: maxHeight };
      } else {
        return { bot: Math.max(0, h - zMax), top: Math.max(0, h - zMin) };
      }
    } else {
      return { bot: zMin, top: Math.max(zMin, Math.min(h, zMax)) };
    }
  };

  // Scan cells to identify active regions
  for (let y = 0; y < H - 1; y += step) {
    for (let x = 0; x < W - 1; x += step) {
      const nextX = Math.min(x + step, W - 1);
      const nextY = Math.min(y + step, H - 1);

      const idxA = y * W + x;
      const idxB = y * W + nextX;
      const idxC = nextY * W + x;
      const idxD = nextY * W + nextX;

      // If puzzle mode is active, check if all 4 corners belong to the target piece
      if (puzzleMap && targetPieceId > 0) {
        if (puzzleMap[idxA] !== targetPieceId ||
          puzzleMap[idxB] !== targetPieceId ||
          puzzleMap[idxC] !== targetPieceId ||
          puzzleMap[idxD] !== targetPieceId) {
          continue; // Not active for this piece
        }
      }

      const hA = heights[idxA];
      const hB = heights[idxB];
      const hC = heights[idxC];
      const hD = heights[idxD];

      const zA = getZ(hA);
      const zB = getZ(hB);
      const zC = getZ(hC);
      const zD = getZ(hD);

      const tA = zA.top - zA.bot;
      const tB = zB.top - zB.bot;
      const tC = zC.top - zC.bot;
      const tD = zD.top - zD.bot;

      if (tA > epsilon || tB > epsilon || tC > epsilon || tD > epsilon) {
        activeCells[y * (W - 1) + x] = 1;
        activeVertsSet[idxA] = 1;
        activeVertsSet[idxB] = 1;
        activeVertsSet[idxC] = 1;
        activeVertsSet[idxD] = 1;
      }
    }
  }

  // Assign vertex indices
  for (let idx = 0; idx < W * H; idx++) {
    if (activeVertsSet[idx] === 1) {
      vertexMap[idx] = activeVertCount;
      activeVertCount++;
    }
  }

  if (activeVertCount === 0) {
    return { vertices: new Float32Array(0), triangles: new Uint32Array(0), colors: new Float32Array(0) };
  }

  // 2 groups of vertices: Top grid and Bottom grid
  const vertexData = new Float32Array(activeVertCount * 2 * 3);
  const colorData = new Float32Array(activeVertCount * 2 * 3);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (activeVertsSet[idx] === 1) {
        const vIdx = vertexMap[idx];
        const h = heights[idx];

        // Scale to physical size, center on XY. Invert Y so it isn't mirrored vertically.
        const px = (x / (W - 1) - 0.5) * scaleX;
        const py = -(y / (H - 1) - 0.5) * scaleY;
        const z = getZ(h);
        const pzTop = z.top;
        const pzBot = z.bot;

        // Top vertex coordinates
        vertexData[vIdx * 3] = px;
        vertexData[vIdx * 3 + 1] = py;
        vertexData[vIdx * 3 + 2] = pzTop;

        // Bottom vertex coordinates (flat floor at zMin)
        const botIdx = vIdx + activeVertCount;
        vertexData[botIdx * 3] = px;
        vertexData[botIdx * 3 + 1] = py;
        vertexData[botIdx * 3 + 2] = pzBot;

        // Calculate Vertex Color (Simulate Transmission)
        let r, g, b;
        if (state.simulateTransmission && state.layers.length > 0) {
          let currentR = 0, currentG = 0, currentB = 0;
          for (let j = 0; j <= layerIndex; j++) {
            const lStart = state.layers[j].startHeight;
            const lEnd = (j + 1 < state.layers.length) ? state.layers[j + 1].startHeight : state.maxHeight;
            if (h > lStart) {
              const thickness = Math.min(h, lEnd) - lStart;
              if (thickness > 0) {
                const layerTD = state.layers[j].td !== undefined ? state.layers[j].td : 2.0;
                const opacity = 1.0 - Math.pow(0.05, thickness / layerTD);
                const rgb = hexToRgb(state.layers[j].hex);
                if (j === 0) {
                  currentR = rgb.r; currentG = rgb.g; currentB = rgb.b;
                } else {
                  currentR = currentR * (1 - opacity) + rgb.r * opacity;
                  currentG = currentG * (1 - opacity) + rgb.g * opacity;
                  currentB = currentB * (1 - opacity) + rgb.b * opacity;
                }
              }
            }
          }
          r = currentR / 255; g = currentG / 255; b = currentB / 255;
        } else {
          const baseC = hexToRgb(state.layers[layerIndex].hex);
          r = baseC.r / 255; g = baseC.g / 255; b = baseC.b / 255;
        }

        colorData[vIdx * 3] = r;
        colorData[vIdx * 3 + 1] = g;
        colorData[vIdx * 3 + 2] = b;
        colorData[botIdx * 3] = r;
        colorData[botIdx * 3 + 1] = g;
        colorData[botIdx * 3 + 2] = b;
      }
    }
  }

  // Create triangles
  for (let y = 0; y < H - 1; y += step) {
    for (let x = 0; x < W - 1; x += step) {
      if (activeCells[y * (W - 1) + x] === 1) {
        const nextX = Math.min(x + step, W - 1);
        const nextY = Math.min(y + step, H - 1);

        const idxA = y * W + x;
        const idxB = y * W + nextX;
        const idxC = nextY * W + x;
        const idxD = nextY * W + nextX;

        const vA = vertexMap[idxA];
        const vB = vertexMap[idxB];
        const vC = vertexMap[idxC];
        const vD = vertexMap[idxD];

        // Top surface triangles (Counterclockwise, facing UP)
        // Since Y is inverted, we swap the 2nd and 3rd vertices to reverse the winding order
        triangles.push(vA, vC, vB);
        triangles.push(vB, vC, vD);

        // Bottom surface triangles (Clockwise from top view, facing DOWN)
        const vA_ = vA + activeVertCount;
        const vB_ = vB + activeVertCount;
        const vC_ = vC + activeVertCount;
        const vD_ = vD + activeVertCount;

        triangles.push(vA_, vB_, vC_);
        triangles.push(vB_, vD_, vC_);

        // Outer & inner boundary walls
        // 1. Left Edge (x - 1)
        if (x === 0 || activeCells[y * (W - 1) + (x - step)] === 0) {
          triangles.push(vA, vC_, vC);
          triangles.push(vA, vA_, vC_);
        }
        // 2. Right Edge (x + 1)
        if (nextX === W - 1 || activeCells[y * (W - 1) + nextX] === 0) {
          triangles.push(vB, vD_, vB_);
          triangles.push(vB, vD, vD_);
        }
        // 3. Top Edge (y - 1)
        if (y === 0 || activeCells[(y - step) * (W - 1) + x] === 0) {
          triangles.push(vA, vB_, vA_);
          triangles.push(vA, vB, vB_);
        }
        // 4. Bottom Edge (y + 1)
        if (nextY === H - 1 || activeCells[nextY * (W - 1) + x] === 0) {
          triangles.push(vC, vD_, vD);
          triangles.push(vC, vC_, vD_);
        }
      }
    }
  }

  return {
    vertices: vertexData,
    triangles: new Uint32Array(triangles),
    colors: colorData
  };
}

// Package all layers and trigger a 3MF download
async function export3MF() {
  if (!state.rawLuminance) {
    alert("Please upload an image first.");
    return;
  }

  btnExport.disabled = true;
  updateExportProgress(2, 'Preparing export...');

  try {
    const cols = state.gridCols;
    const rows = state.gridRows;
    const heights = getHeightsGrid();
    const scaleX = state.widthMm;
    const scaleY = state.heightMm;

    const layersData = [];

    let puzzleMap = null;
    let numPieces = 1;
    if (state.puzzleEnabled) {
      updateExportProgress(8, 'Generating puzzle split map...');
      await yieldToUI();
      puzzleMap = generatePuzzleMap(cols, rows, state.puzzleCols, state.puzzleRows, state.puzzleClearanceMm, scaleX, scaleY);
      numPieces = state.puzzleCols * state.puzzleRows;
    }

    const totalSlices = Math.max(1, numPieces * state.layers.length);
    let completedSlices = 0;

    for (let p = 1; p <= numPieces; p++) {
      for (let k = 0; k < state.layers.length; k++) {
        const layer = state.layers[k];
        const zMin = layer.startHeight;
        const zMax = (k + 1 < state.layers.length) ? state.layers[k + 1].startHeight : state.maxHeight;
        const currentSlice = completedSlices + 1;
        const slicePercent = 12 + (currentSlice / totalSlices) * 63;
        const status = state.puzzleEnabled
          ? `Building piece ${p}/${numPieces}, layer ${k + 1}/${state.layers.length}...`
          : `Building layer ${k + 1}/${state.layers.length}...`;
        updateExportProgress(slicePercent, status);
        if (currentSlice === 1 || currentSlice % 2 === 0) {
          await yieldToUI();
        }

        const meshData = buildLayerGeometry(heights, cols, rows, scaleX, scaleY, zMin, zMax, puzzleMap, state.puzzleEnabled ? p : 0, k === 0, state.mirrorX, state.maxHeight, k);
        completedSlices++;
        if (meshData.triangles.length === 0) continue;

        // Give a meaningful name for BambuStudio object hierarchy
        let layerName = `Part_${k + 1}_Color_${layer.hex.toUpperCase()}_Start_${zMin.toFixed(2)}mm`;
        if (state.puzzleEnabled) {
          layerName = `Piece_${p}_` + layerName;
        }

        layersData.push({
          name: layerName,
          hex: layer.hex,
          vertices: meshData.vertices,
          triangles: meshData.triangles
        });
      }
    }

    if (layersData.length === 0) {
      alert("No geometry was generated! Make sure layer heights are set correctly.");
      btnExport.disabled = false;
      btnExport.textContent = "Export 3MF for BambuStudio";
      failExportProgress('No geometry was generated.');
      return;
    }

    // Export triggers a single OBJ download with embedded vertex colors
    updateExportProgress(80, 'Writing OBJ file...');
    await yieldToUI();
    await window.Exporter3MF.export(layersData, (percent, status) => {
      const mappedPercent = 80 + percent * 0.2;
      updateExportProgress(mappedPercent, status || 'Writing OBJ file...');
    });
    finishExportProgress('OBJ exported successfully.');
    if (typeof dashTrackExport === 'function') dashTrackExport();

  } catch (error) {
    console.error(error);
    failExportProgress('Export failed.');
    alert("Export failed: " + error.message);
  } finally {
    btnExport.disabled = false;
    btnExport.innerHTML = '<i data-lucide="download"></i> Export OBJ for BambuStudio';
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

// Export single merged binary STL
async function exportSTL() {
  if (!state.rawLuminance) {
    alert('Please upload an image first.');
    return;
  }

  const btnSTL = document.getElementById('btn-export-stl');
  if (btnSTL) btnSTL.disabled = true;

  updateExportProgress(2, 'Preparing STL export...');

  try {
    const cols = state.gridCols;
    const rows = state.gridRows;
    const heights = getHeightsGrid();
    const scaleX = state.widthMm;
    const scaleY = state.heightMm;

    let puzzleMap = null;
    let numPieces = 1;
    if (state.puzzleEnabled) {
      updateExportProgress(8, 'Generating puzzle split map...');
      await yieldToUI();
      puzzleMap = generatePuzzleMap(cols, rows, state.puzzleCols, state.puzzleRows, state.puzzleClearanceMm, scaleX, scaleY);
      numPieces = state.puzzleCols * state.puzzleRows;
    }

    const allMeshes = [];
    const totalSlices = Math.max(1, numPieces * state.layers.length);
    let completedSlices = 0;

    for (let p = 1; p <= numPieces; p++) {
      for (let k = 0; k < state.layers.length; k++) {
        const layer = state.layers[k];
        const zMin = layer.startHeight;
        const zMax = (k + 1 < state.layers.length) ? state.layers[k + 1].startHeight : state.maxHeight;
        completedSlices++;
        const slicePercent = 12 + (completedSlices / totalSlices) * 68;
        updateExportProgress(slicePercent, `Building STL layer ${k + 1}/${state.layers.length}...`);
        if (completedSlices % 2 === 0) await yieldToUI();

        const meshData = buildLayerGeometry(heights, cols, rows, scaleX, scaleY, zMin, zMax, puzzleMap, state.puzzleEnabled ? p : 0, k === 0, state.mirrorX, state.maxHeight, k);
        if (meshData.triangles.length === 0) continue;
        allMeshes.push(meshData);
      }
    }

    if (allMeshes.length === 0) {
      alert('No geometry was generated!');
      return;
    }

    updateExportProgress(82, 'Writing binary STL...');
    await yieldToUI();
    await window.Exporter3MF.exportSTL(allMeshes, (pct, status) => {
      updateExportProgress(82 + pct * 0.18, status);
    });
    finishExportProgress('STL exported successfully.');

  } catch (error) {
    console.error(error);
    failExportProgress('STL export failed.');
    alert('STL export failed: ' + error.message);
  } finally {
    if (btnSTL) {
      btnSTL.disabled = false;
      btnSTL.innerHTML = '<i data-lucide="box"></i> Export STL';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

// ── Perceptual Color Space Helpers (OKLab + DeltaE OK) ─────────────────────

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);
  let l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  let m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  let s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  l = Math.cbrt(l);
  m = Math.cbrt(m);
  s = Math.cbrt(s);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ];
}

function deltaEOK(a, b) {
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ── K-Means Color Matching ────────────────────────────────────────────────
function matchImageColors() {
  if (!state.image) return;

  // Use full-resolution pixel data from processImage (no separate 64x64 resample)
  const pixels = state.colorSampleRGB;
  const pixelCount = state.colorSampleWidth * state.colorSampleHeight;
  if (!pixels || pixelCount === 0) return;

  const targetCount = getAdaptiveLayerCount();
  if (targetCount !== state.layers.length) {
    updateLayersCount(targetCount);
    sync2DLayerIndex();
  }

  const k = state.layers.length;
  if (k === 0) return;

  // Precompute OKLab for all sample pixels
  // 1. Group similar colors into bins to prevent massive areas from dominating
  const colorBins = new Map();
  const BIN_SIZE = 16; // Adjust this to group colors more or less aggressively

  for (let i = 0; i < pixelCount; i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];

    // Snap colors to the nearest bin
    const rBin = Math.floor(r / BIN_SIZE) * BIN_SIZE;
    const gBin = Math.floor(g / BIN_SIZE) * BIN_SIZE;
    const bBin = Math.floor(b / BIN_SIZE) * BIN_SIZE;
    const key = `${rBin},${gBin},${bBin}`;

    let bin = colorBins.get(key);
    if (!bin) {
      bin = { indices: [] };
      colorBins.set(key, bin);
    }
    bin.indices.push(i);
  }

  // 2. Extract sampled indices with dampened weights
  const sampledIndices = [];
  for (const bin of colorBins.values()) {
    const count = bin.indices.length;
    // Square root flattens the curve so the red sun doesn't swallow the brown mountain
    const weight = Math.ceil(Math.sqrt(count));
    const step = Math.max(1, Math.floor(count / weight));

    for (let w = 0; w < weight; w++) {
      const pixelIndex = bin.indices[w * step];
      if (pixelIndex !== undefined) {
        sampledIndices.push(pixelIndex);
      }
    }
  }

  const sampledCount = sampledIndices.length;
  const indices = new Uint32Array(sampledCount);
  const labData = new Float64Array(pixelCount * 3); // Sized to original so K-means indexing maps correctly

  // 3. Precompute OKLab ONLY for our curated, balanced sample pool
  for (let i = 0; i < sampledCount; i++) {
    const pIdx = sampledIndices[i];
    indices[i] = pIdx;

    const r = pixels[pIdx * 3];
    const g = pixels[pIdx * 3 + 1];
    const b = pixels[pIdx * 3 + 2];
    const lab = rgbToOklab(r, g, b);

    labData[pIdx * 3] = lab[0];
    labData[pIdx * 3 + 1] = lab[1];
    labData[pIdx * 3 + 2] = lab[2];
  }

  // ── Deterministic centroid initialization ──

  // Compute average OKLab of the image
  let sumL = 0, sumA = 0, sumB = 0;
  for (let si = 0; si < sampledCount; si++) {
    const idx = indices[si] * 3;
    sumL += labData[idx];
    sumA += labData[idx + 1];
    sumB += labData[idx + 2];
  }
  const avgLab = [sumL / sampledCount, sumA / sampledCount, sumB / sampledCount];

  // First centroid: pixel farthest from average in OKLab distance (ensures an extreme)
  let centroids = [];
  let bestDist = -1;
  let bestIdx = 0;
  for (let si = 0; si < sampledCount; si++) {
    const idx = indices[si] * 3;
    const d = deltaEOK(avgLab, [labData[idx], labData[idx + 1], labData[idx + 2]]);
    if (d > bestDist) { bestDist = d; bestIdx = indices[si]; }
  }
  centroids.push([labData[bestIdx * 3], labData[bestIdx * 3 + 1], labData[bestIdx * 3 + 2]]);

  // Remaining centroids: farthest-point sampling (k-means++ style, deterministic)
  const initStep = Math.max(1, Math.floor(sampledCount / 600));
  for (let c = 1; c < k; c++) {
    bestDist = -1;
    bestIdx = 0;
    for (let si = 0; si < sampledCount; si += initStep) {
      const idx = indices[si] * 3;
      const plab = [labData[idx], labData[idx + 1], labData[idx + 2]];
      let minD = Infinity;
      for (let j = 0; j < centroids.length; j++) {
        const d = deltaEOK(plab, centroids[j]);
        if (d < minD) minD = d;
      }
      if (minD > bestDist) { bestDist = minD; bestIdx = indices[si]; }
    }
    centroids.push([labData[bestIdx * 3], labData[bestIdx * 3 + 1], labData[bestIdx * 3 + 2]]);
  }

  // ── K-means iterations in OKLab space ──
  const assignment = new Uint16Array(sampledCount);
  const maxIter = 30;

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each pixel to nearest centroid
    for (let si = 0; si < sampledCount; si++) {
      const idx = indices[si] * 3;
      const plab = [labData[idx], labData[idx + 1], labData[idx + 2]];
      let minD = Infinity;
      let bestC = 0;
      for (let j = 0; j < k; j++) {
        const d = deltaEOK(plab, centroids[j]);
        if (d < minD) { minD = d; bestC = j; }
      }
      assignment[si] = bestC;
    }

    // Recompute centroids
    const sums = Array.from({ length: k }, () => ({ L: 0, a: 0, b: 0, count: 0 }));
    for (let si = 0; si < sampledCount; si++) {
      const c = assignment[si];
      const idx = indices[si] * 3;
      sums[c].L += labData[idx];
      sums[c].a += labData[idx + 1];
      sums[c].b += labData[idx + 2];
      sums[c].count++;
    }

    let changed = false;
    for (let j = 0; j < k; j++) {
      if (sums[j].count === 0) continue;
      const newL = sums[j].L / sums[j].count;
      const newa = sums[j].a / sums[j].count;
      const newb = sums[j].b / sums[j].count;
      const drift = Math.abs(centroids[j][0] - newL) +
        Math.abs(centroids[j][1] - newa) +
        Math.abs(centroids[j][2] - newb);
      if (drift > 0.001) changed = true;
      centroids[j] = [newL, newa, newb];
    }
    if (!changed) break;
  }

  // ── Compute RGB centroids and cluster populations ──
  const rgbSums = Array.from({ length: k }, () => ({ r: 0, g: 0, b: 0, count: 0 }));
  for (let si = 0; si < sampledCount; si++) {
    const c = assignment[si];
    const idx = indices[si] * 3;
    rgbSums[c].r += pixels[idx];
    rgbSums[c].g += pixels[idx + 1];
    rgbSums[c].b += pixels[idx + 2];
    rgbSums[c].count++;
  }

  const clusterInfo = [];
  for (let j = 0; j < k; j++) {
    const cnt = rgbSums[j].count;
    if (cnt === 0) {
      // Empty cluster: use centroid OKLab back to sRGB as fallback
      const lab = centroids[j];
      clusterInfo.push({ rgb: [128, 128, 128], luminance: 128, pop: 0 });
      continue;
    }
    const rgb = [rgbSums[j].r / cnt, rgbSums[j].g / cnt, rgbSums[j].b / cnt];
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    clusterInfo.push({ rgb, luminance: lum, pop: cnt });
  }

  // Sort by luminance (dark → light)
  clusterInfo.sort((a, b) => a.luminance - b.luminance);

  // ── Protect against minority dark colors hijacking the base layer ──
  // If the darkest cluster is less populous than the next and within similar
  // luminance, swap so the dominant nearby color becomes the base instead.
  const MAX_SWAP_LUM_DIFF = 30;

  if (clusterInfo.length >= 2 && clusterInfo[0].pop < clusterInfo[1].pop) {
    const lumDiff = clusterInfo[1].luminance - clusterInfo[0].luminance;
    if (lumDiff <= MAX_SWAP_LUM_DIFF) {
      [clusterInfo[0], clusterInfo[1]] = [clusterInfo[1], clusterInfo[0]];
    }
  }

  // Symmetric protection for the lightest (top) layer
  const last = clusterInfo.length - 1;
  if (clusterInfo.length >= 2 && clusterInfo[last].pop < clusterInfo[last - 1].pop) {
    const lumDiff = clusterInfo[last].luminance - clusterInfo[last - 1].luminance;
    if (lumDiff <= MAX_SWAP_LUM_DIFF) {
      [clusterInfo[last], clusterInfo[last - 1]] = [clusterInfo[last - 1], clusterInfo[last]];
    }
  }

  // ── Convert to hex and apply to layers ──
  const toHex = (c) => {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const r = clamp(c[0]).toString(16).padStart(2, '0');
    const g = clamp(c[1]).toString(16).padStart(2, '0');
    const b = clamp(c[2]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  };

  for (let i = 0; i < k && i < state.layers.length; i++) {
    state.layers[i].hex = toHex(clusterInfo[i].rgb);
  }

  syncColorCountUI();
  renderLayersList();
  debounceUpdate();
}

// ── Filament Picker Modal ──────────────────────────────────────

function openFilamentPicker(layerIndex) {
  const overlay = document.getElementById('filament-picker-overlay');
  const body = document.getElementById('filament-picker-body');
  if (!overlay || !body) return;

  const brands = {};
  state.filaments.forEach(f => {
    const brand = f.brand || 'Unknown';
    const material = f.material || 'Unknown';
    if (!brands[brand]) brands[brand] = {};
    if (!brands[brand][material]) brands[brand][material] = [];
    brands[brand][material].push(f);
  });

  const sortedBrands = Object.keys(brands).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  sortedBrands.forEach(brand => {
    const materials = brands[brand];
    const sortedMaterials = Object.keys(materials).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    sortedMaterials.forEach(mat => {
      materials[mat].sort((a, b) => hexToRGBValue(a.hex) - hexToRGBValue(b.hex));
    });
  });

  let html = '';
  sortedBrands.forEach(brand => {
    html += `<div class="filament-brand-group"><div class="filament-brand-header">${brand}</div>`;
    const materials = brands[brand];
    const sortedMaterials = Object.keys(materials).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    sortedMaterials.forEach(mat => {
      html += `<div class="filament-material-header">${mat}</div><div class="filament-brand-grid">`;
      materials[mat].forEach(f => {
        html += `<div class="filament-picker-swatch" data-hex="${f.hex}" data-td="${f.td}" data-layer-index="${layerIndex}" title="${f.brand} - ${f.name} (${f.material}, TD ${f.td})" style="background:${f.hex}"></div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;
  });

  if (!html) {
    html = '<div class="filament-picker-empty">No filaments in library</div>';
  }

  body.innerHTML = html;
  overlay.classList.remove('hidden');

  // Eyedropper button
  const eyedropperBtn = document.getElementById('filament-eyedropper');
  if (eyedropperBtn) {
    eyedropperBtn.onclick = () => {
      if ('EyeDropper' in window) {
        const eyeDropper = new EyeDropper();
        eyeDropper.open().then(result => {
          applyFilamentColor(layerIndex, result.sRGBHex, null);
        }).catch(() => {});
      } else {
        // Fallback: create a temporary color input and trigger it
        const tempInput = document.createElement('input');
        tempInput.type = 'color';
        tempInput.value = state.layers[layerIndex]?.hex || '#000000';
        tempInput.addEventListener('input', () => {
          applyFilamentColor(layerIndex, tempInput.value, null);
        });
        tempInput.click();
      }
    };
  }

  body.querySelectorAll('.filament-picker-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      applyFilamentColor(parseInt(swatch.dataset.layerIndex), swatch.dataset.hex, parseFloat(swatch.dataset.td) || 2.0);
    });
  });
}

function applyFilamentColor(idx, hex, td) {
  const layer = state.layers[idx];
  if (!layer) return;

  layer.hex = hex;
  if (td !== null) layer.td = td;

  const swatchBtn = document.getElementById(`layer-swatch-${idx}`);
  const tdInput = document.getElementById(`layer-td-${idx}`);
  if (swatchBtn) swatchBtn.style.backgroundColor = hex;
  if (tdInput) tdInput.value = layer.td;

  closeFilamentPicker();
  debounceUpdate();
}

function closeFilamentPicker() {
  const overlay = document.getElementById('filament-picker-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function hexToRGBValue(hex) {
  if (hex.length === 7) {
    return parseInt(hex.slice(1), 16);
  }
  return 0;
}

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initSolarSystem, updateSolarSystem } from './solarsystem.js';

const EARTH_R   = 1.0;
const CLICK_THR = 0.018;
const DEG       = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
//  Texture sources — STATIC global mosaics only.
//
//  Day   = NASA Visible Earth: Blue Marble Topography + Bathymetry + Ice
//          (Dec 2004 composite) — shaded landforms, ocean depth, polar ice.
//  Night = NASA Earth at Night 2012 (Black Marble, VIIRS DNB annual mosaic).
//
//  Daily MODIS / VIIRS layers are intentionally NOT used: their per-orbit
//  swath gaps showed up as visible diagonal stripes on the globe. Static
//  composites are gap-free and align cleanly with the sphere UVs.
//
//  Fallbacks = NASA GIBS WMS BlueMarble_NextGeneration → three-globe CDN.
// ─────────────────────────────────────────────────────────────────────────────

function gibsWMS(layer) {
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi`
    + `?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image%2Fjpeg`
    + `&TRANSPARENT=false&LAYERS=${layer}`
    + `&WIDTH=4096&HEIGHT=2048&SRS=EPSG:4326&BBOX=-180,-90,180,90`;
}

const CDN     = 'https://unpkg.com/three-globe/example/img';
const NASA_VE = 'https://eoimages.gsfc.nasa.gov/images/imagerecords';

// Texture cascade — every entry is a STATIC, gap-free global mosaic.
// Daily MODIS / VIIRS layers were removed because their orbit swaths leave
// diagonal no-data stripes that show up as visible holes on the globe.
const GLOBE_SRC = {
  // Day side: NASA Blue Marble Topography + Bathymetry + Ice (Dec 2004) →
  // GIBS WMS BlueMarble_NextGeneration → three-globe CDN.
  dayPrimary:  `${NASA_VE}/73000/73938/world.topo.bathy.200412.3x5400x2700.jpg`,
  dayGIBS:     gibsWMS('BlueMarble_NextGeneration'),
  dayCDN:      `${CDN}/earth-blue-marble.jpg`,

  // Night side: NASA Black Marble 2012 → three-globe CDN.
  nightPrimary:`${NASA_VE}/79000/79765/dnb_land_ocean_ice.2012.3600x1800.jpg`,
  nightCDN:    `${CDN}/earth-night.jpg`,

  clouds:      `${CDN}/earth-clouds.png`,
  water:       `${CDN}/earth-water.png`,
};

// ── Subcontinent country IDs (ISO 3166-1 numeric) ─────────────────────────────
// India, Pakistan, Bangladesh, Nepal, Bhutan, Sri Lanka, Myanmar, Afghanistan, Maldives
const SUBCONTINENT_IDS = new Set([356, 586, 50, 524, 64, 144, 104, 4, 462]);

// ── Module state ─────────────────────────────────────────────────────────────
let scene, camera, renderer, controls;
let earthMesh, cloudMesh;
let satGroups = {};
let onSatClick;

let countryFeatures   = [];
let countryGeometries = new Map();
let hoverMesh         = null;
let lastHoverId       = null;

let footprintLine  = null;
let groundTrackGrp = null;

const hoverMat = new THREE.LineBasicMaterial({
  color: 0x00e5ff, transparent: true, opacity: 0.9, depthWrite: false,
});

const uSunDir   = new THREE.Uniform(new THREE.Vector3(1, 0, 0));
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();

// ── Public init ───────────────────────────────────────────────────────────────

export async function initGlobe(canvas, onClickCb) {
  onSatClick = onClickCb;

  scene  = new THREE.Scene();

  // Read viewport size from the canvas's parent. THREE.WebGLRenderer.setSize()
  // writes inline `width: 0px; height: 0px` if it ever receives 0,0 — which then
  // wedges the canvas at zero size because subsequent reads of clientWidth keep
  // returning 0. The parent (#main) is always laid out, so size from there.
  const sizeHost = () => {
    const host = canvas.parentElement || canvas;
    const r = host.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
  };
  const { w: w0, h: h0 } = sizeHost();

  // Camera positioned to look toward Indian subcontinent (lat≈22°N lon≈80°E)
  // geo2xyz(22, 80) → roughly (0.16, 0.37, -0.91) in globe space
  camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.01, 4000);
  camera.position.set(0.45, 1.05, -2.56);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setSize(w0, h0, false);          // false = don't override CSS, let our 100%/100% rules drive the layout
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x050810, 1);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping    = true;
  controls.dampingFactor    = 0.06;
  controls.minDistance      = 1.2;
  controls.maxDistance      = 1100;     // allow zoom out to full solar-system scale (Neptune ≈ 30 AU ≈ 750 units)
  controls.autoRotate       = true;
  controls.autoRotateSpeed  = 0.20;
  controls.enablePan        = false;
  controls.target.set(0, 0, 0);

  buildStars();
  await buildEarth();
  buildAtmosphere();
  buildCountryBorders();   // async, fires in background
  initSolarSystem(scene);  // hidden until the camera zooms out past Earth scale

  scene.add(new THREE.AmbientLight(0x0d1a33, 0.5));

  // Re-size on viewport change AND on parent layout change (covers iframes
  // that initialise at 0×0 and only become visible later).
  const handleResize = () => {
    const { w, h } = sizeHost();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  window.addEventListener('resize', handleResize);
  if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
    new ResizeObserver(handleResize).observe(canvas.parentElement);
  }

  canvas.addEventListener('click',      handleClick);
  canvas.addEventListener('mousemove',  handleMouseMove);
  canvas.addEventListener('mouseleave', () => showCountryBorder(null));

  (function loop() {
    requestAnimationFrame(loop);
    const now = new Date();
    uSunDir.value = computeSunDir(now);
    controls.update();
    if (cloudMesh) cloudMesh.rotation.y += 0.00007;
    updateSolarSystem(camera, now);
    renderer.render(scene, camera);
  })();
}

// ── Stars ─────────────────────────────────────────────────────────────────────

function buildStars() {
  const N = 14000, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    // Placed outside solar-system zoom range (Neptune ≈ 750 units)
    const r  = 1400 + Math.random() * 600;
    pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
    pos[i*3+1] = r * Math.cos(ph);
    pos[i*3+2] = r * Math.sin(ph) * Math.sin(th);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.8, sizeAttenuation: true, transparent: true, opacity: 0.85,
  })));
}

// ── Earth ─────────────────────────────────────────────────────────────────────

async function buildEarth() {
  const dayTex   = await loadCascade([GLOBE_SRC.dayPrimary,   GLOBE_SRC.dayGIBS,  GLOBE_SRC.dayCDN],   'day');
  const nightTex = await loadCascade([GLOBE_SRC.nightPrimary, GLOBE_SRC.nightCDN],                     'night');
  const waterTex = await loadTex(GLOBE_SRC.water);

  const geo = new THREE.SphereGeometry(EARTH_R, 128, 128);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uDay:    { value: dayTex },
      uNight:  { value: nightTex },
      uWater:  { value: waterTex },
      uSunDir: uSunDir,
    },
    vertexShader:   VERT,
    fragmentShader: FRAG,
  });

  earthMesh = new THREE.Mesh(geo, mat);
  scene.add(earthMesh);

  const cloudTex = await loadTex(GLOBE_SRC.clouds).catch(() => null);
  if (cloudTex) {
    const cLight = new THREE.DirectionalLight(0xffffff, 0.8);
    cLight.position.set(5, 3, 5);
    scene.add(cLight);
    cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.006, 96, 96),
      new THREE.MeshLambertMaterial({
        map: cloudTex, transparent: true, opacity: 0.28, depthWrite: false,
      })
    );
    scene.add(cloudMesh);
  }
}

// ── Texture cascade ───────────────────────────────────────────────────────────
// Each entry in `urls` is tried in order; first success wins. All sources are
// static, gap-free global mosaics — daily satellite layers were intentionally
// removed because their orbit-swath patterns leave visible no-data stripes.

async function loadCascade(urls, label) {
  for (const url of urls) {
    try {
      const tex = await loadTex(url);
      console.info(`[argos] ${label} texture: ${url}`);
      return tex;
    } catch (e) {
      console.warn(`[argos] ${label} texture failed:`, url, e?.message || e);
    }
  }
  return null;
}

// ── Texture helpers ───────────────────────────────────────────────────────────

function loadTex(url) {
  return new Promise((res, rej) => {
    const loader = new THREE.TextureLoader();
    loader.load(url, tex => { applyTexParams(tex); res(tex); }, undefined, rej);
  });
}

function applyTexParams(tex) {
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // Sphere geometry's antimeridian seam: U wraps around the globe so a slight
  // overshoot of 1.0 must read from the start of the texture, not clamp.
  tex.wrapS = THREE.RepeatWrapping;
  // Latitude doesn't wrap — the poles must clamp to the topmost / bottommost row.
  tex.wrapT = THREE.ClampToEdgeWrapping;
  if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
}

// ── GLSL shaders ──────────────────────────────────────────────────────────────

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWN;
  varying vec3 vWP;

  void main() {
    vUv = uv;
    vWN = normalize(position);
    vWP = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uWater;
  uniform vec3      uSunDir;

  varying vec2 vUv;
  varying vec3 vWN;
  varying vec3 vWP;

  void main() {
    vec3 N = normalize(vWN);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(-vWP);

    float NdotL = dot(N, L);

    // Wide twilight band: fade across roughly civil → nautical → astronomical
    // twilight (≈18° solar elevation, NdotL span ≈0.31). The cubic eases out the
    // hard edges so the terminator reads as a soft gradient rather than a line.
    float dayF   = smoothstep(-0.32, 0.18, NdotL);
    float nightF = 1.0 - smoothstep(-0.28, 0.04, NdotL);

    vec3 dayTex  = texture2D(uDay, vUv).rgb;
    // Softer diffuse: lower slope + slight ambient floor so the lit hemisphere
    // doesn't fall off too aggressively into the terminator zone.
    float diffuse = clamp(NdotL * 0.95 + 0.18, 0.0, 1.0);
    vec3 dayCol   = dayTex * diffuse * dayF;

    vec3 nightTex = texture2D(uNight, vUv).rgb;
    nightTex      = pow(max(nightTex, vec3(0.0)), vec3(0.45)) * 2.4;
    vec3 nightCol = nightTex * nightF;

    // Broader, softer sunset/dawn ring (orange near terminator, blue further into day).
    float tGlow  = smoothstep(-0.18, 0.02, NdotL) * smoothstep(0.40, 0.06, NdotL);
    vec3  atmCol = mix(vec3(0.95, 0.55, 0.20), vec3(0.25, 0.60, 0.95),
                       smoothstep(-0.05, 0.25, NdotL))
                   * tGlow * 0.45;

    float water  = texture2D(uWater, vUv).r;
    vec3  H      = normalize(L + V);
    float spec   = pow(max(dot(N, H), 0.0), 90.0) * water * 0.22;
    spec *= step(0.0, NdotL);

    gl_FragColor = vec4(dayCol + nightCol + atmCol + spec, 1.0);
  }
`;

// ── Atmosphere ────────────────────────────────────────────────────────────────

function buildAtmosphere() {
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 1.048, 48, 48),
    new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vN;
        void main(){
          vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        varying vec3 vN;
        void main(){
          float rim = pow(clamp(0.72 - dot(vN, vec3(0,0,1)), 0.0, 1.0), 3.5);
          gl_FragColor = vec4(0.05, 0.44, 0.92, rim * 0.62);
        }`,
      blending: THREE.AdditiveBlending, side: THREE.FrontSide,
      transparent: true, depthWrite: false,
    })
  ));
}

// ── Country borders ───────────────────────────────────────────────────────────
// Two tiers:
//   1. Dim blue borders for the rest of the world
//   2. Bright gold borders for India + subcontinent neighbours (for policy relevance)
//      Boundaries sourced from Natural Earth, cross-referenced with ISRO Bhuvan.

async function buildCountryBorders() {
  try {
    const resp  = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    const world = await resp.json();
    const topo  = window.topojson;

    countryFeatures = topo.feature(world, world.objects.countries).features;

    const worldVerts       = [];
    const subcontinentVerts = [];

    countryFeatures.forEach(feat => {
      const verts = [];
      extractRings(feat.geometry, verts);
      if (!verts.length) return;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      countryGeometries.set(feat.id, geo);

      if (SUBCONTINENT_IDS.has(parseInt(feat.id, 10))) {
        subcontinentVerts.push(...verts);
      } else {
        worldVerts.push(...verts);
      }
    });

    // Dim world borders
    if (worldVerts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(worldVerts, 3));
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0x1a3a5c, transparent: true, opacity: 0.55, depthWrite: false,
      })));
    }

    // Bright gold subcontinent borders — India, Pakistan, Bangladesh, Nepal, etc.
    if (subcontinentVerts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(subcontinentVerts, 3));
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0xffd700, transparent: true, opacity: 0.90, depthWrite: false,
      })));
    }

  } catch (e) {
    console.warn('[argos] border load failed:', e.message);
  }
}

function extractRings(geometry, out) {
  if (!geometry) return;
  const polys = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

  polys.forEach(poly => poly.forEach(ring => {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lo1, la1] = ring[i];
      const [lo2, la2] = ring[i + 1];
      const r = EARTH_R * 1.0015;
      const a = geo2xyz(la1, lo1, r), b = geo2xyz(la2, lo2, r);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }));
}

function showCountryBorder(feature) {
  const id = feature?.id ?? null;
  if (id === lastHoverId) return;
  lastHoverId = id;

  if (hoverMesh) { scene.remove(hoverMesh); hoverMesh = null; }
  if (!feature)  return;

  const geo = countryGeometries.get(feature.id);
  if (!geo) return;

  hoverMesh = new THREE.LineSegments(geo, hoverMat);
  scene.add(hoverMesh);
}

// ── Coverage footprint for selected satellite ─────────────────────────────────
// Draws the 0° elevation footprint circle (maximum coverage boundary).

export function renderFootprint(pos) {
  if (footprintLine) { scene.remove(footprintLine); footprintLine = null; }
  if (!pos?.valid) return;

  const EARTH_R_KM = 6371;
  const halfAngle  = Math.acos(EARTH_R_KM / (EARTH_R_KM + Math.max(pos.alt, 100))) / DEG;
  const pts        = footprintPoints(pos.lat, pos.lon, halfAngle);
  if (!pts.length) return;

  const flat = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { flat[i*3] = p.x; flat[i*3+1] = p.y; flat[i*3+2] = p.z; });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
  footprintLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: 0xff4444, transparent: true, opacity: 0.55, depthWrite: false,
  }));
  scene.add(footprintLine);
}

function footprintPoints(lat0Deg, lon0Deg, halfAngleDeg, segments = 96) {
  const lat0 = lat0Deg * DEG;
  const lon0 = lon0Deg * DEG;
  const rho  = halfAngleDeg * DEG;
  const R    = EARTH_R * 1.002;
  const pts  = [];

  for (let i = 0; i <= segments; i++) {
    const az     = (i / segments) * 2 * Math.PI;
    const sinPhi = Math.sin(lat0) * Math.cos(rho) +
                   Math.cos(lat0) * Math.sin(rho) * Math.cos(az);
    const pLat   = Math.asin(Math.min(1, Math.max(-1, sinPhi))) / DEG;
    const pLon   = lon0 / DEG + Math.atan2(
      Math.sin(az) * Math.sin(rho) * Math.cos(lat0),
      Math.cos(rho) - Math.sin(lat0) * sinPhi
    ) / DEG;
    pts.push(geo2xyz(pLat, pLon, R));
  }
  return pts;
}

// ── Orbital ground track for selected satellite ───────────────────────────────
// Propagates ±1 orbit and draws the ground track.

export function renderGroundTrack(sat) {
  if (groundTrackGrp) { scene.remove(groundTrackGrp); groundTrackGrp = null; }
  if (!sat?.satrec) return;

  const period = sat.period || 90; // minutes
  const step   = Math.max(0.5, period / 180); // ~180 steps per orbit
  const nowMs  = Date.now();
  const R      = EARTH_R * 1.003;

  // Collect points; break segments at large 3D gaps (avoids wrong interpolation)
  const segments = [];
  let current    = [];

  for (let t = -period * 0.5; t <= period * 1.5; t += step) {
    const time = new Date(nowMs + t * 60000);
    try {
      const pv = window.satellite.propagate(sat.satrec, time);
      if (!pv?.position) { if (current.length) { segments.push(current); current = []; } continue; }
      const gmst = window.satellite.gstime(time);
      const gd   = window.satellite.eciToGeodetic(pv.position, gmst);
      const lat  = window.satellite.degreesLat(gd.latitude);
      const lon  = window.satellite.degreesLong(gd.longitude);
      if (!isFinite(lat) || !isFinite(lon)) { if (current.length) { segments.push(current); current = []; } continue; }
      const p = geo2xyz(lat, lon, R);
      if (current.length > 0) {
        const prev = current[current.length - 1];
        const dx = p.x - prev.x, dy = p.y - prev.y, dz = p.z - prev.z;
        if (Math.sqrt(dx*dx + dy*dy + dz*dz) > 0.5) {
          segments.push(current); current = [];
        }
      }
      current.push(p);
    } catch { if (current.length) { segments.push(current); current = []; } }
  }
  if (current.length) segments.push(current);

  if (!segments.length) return;

  groundTrackGrp = new THREE.Group();

  // Past track (dimmer), future track (brighter)
  const nowLine  = -period * 0.5;
  segments.forEach(seg => {
    if (seg.length < 2) return;
    const flat = new Float32Array(seg.length * 3);
    seg.forEach((p, i) => { flat[i*3] = p.x; flat[i*3+1] = p.y; flat[i*3+2] = p.z; });
    const geo  = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    groundTrackGrp.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xff4444, transparent: true, opacity: 0.35, depthWrite: false,
    })));
  });

  scene.add(groundTrackGrp);
}

// ── Sun direction (USNO simplified) ──────────────────────────────────────────

function computeSunDir(date) {
  const JD   = date.getTime() / 86400000 + 2440587.5;
  const n    = JD - 2451545.0;
  const L    = (280.460  + 0.9856474    * n) % 360;
  const g    = ((357.528 + 0.9856003    * n) % 360) * DEG;
  const lam  = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps  = (23.439   - 0.0000004    * n) * DEG;
  const ra   = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec  = Math.asin (Math.sin(eps) * Math.sin(lam));
  const GMST = ((280.46061837 + 360.98564736629 * n) % 360) * DEG;
  return geo2xyz(dec / DEG, ((ra - GMST) / DEG + 360) % 360 - 180, 1);
}

// ── Coordinate conversions ────────────────────────────────────────────────────

function geo2xyz(lat, lon, r) {
  const phi   = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  );
}

function xyz2geo(v) {
  const n   = v.clone().normalize();
  const lat = 90 - Math.acos(n.y) / DEG;
  const lon = Math.atan2(n.z, -n.x) / DEG - 180;
  return { lat, lon };
}

// ── Input handlers ────────────────────────────────────────────────────────────

function handleMouseMove(e) {
  if (!earthMesh) return;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const hits = raycaster.intersectObject(earthMesh);
  if (!hits.length || !countryFeatures.length || !window.d3geo) {
    showCountryBorder(null); return;
  }

  const { lat, lon } = xyz2geo(hits[0].point);
  const hovered = countryFeatures.find(f => window.d3geo.geoContains(f, [lon, lat])) ?? null;
  showCountryBorder(hovered);
}

function handleClick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  raycaster.params.Points.threshold = CLICK_THR;

  const hits = raycaster.intersectObjects(Object.values(satGroups));
  if (!hits.length) return;

  const hit = hits[0];
  if (hit.object.userData.satData?.[hit.index]) {
    controls.autoRotate = false;
    onSatClick(hit.object.userData.satData[hit.index]);
  }
}

// ── Satellite point clouds ────────────────────────────────────────────────────

export function renderSatellites(positions) {
  Object.values(satGroups).forEach(p => scene.remove(p));
  satGroups = {};

  const buckets = {};
  positions.forEach(p => {
    if (!p.valid) return;
    if (!buckets[p.group]) buckets[p.group] = { xyz: [], data: [], color: p.color };
    buckets[p.group].xyz.push(p.x, p.y, p.z);
    buckets[p.group].data.push(p);
  });

  Object.entries(buckets).forEach(([grp, { xyz, data, color }]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color, size: 0.012, sizeAttenuation: true, transparent: true, opacity: 0.92,
    }));
    pts.userData.satData = data;
    satGroups[grp] = pts;
    scene.add(pts);
  });
}

export function resumeAutoRotate() {
  if (controls) controls.autoRotate = true;
}

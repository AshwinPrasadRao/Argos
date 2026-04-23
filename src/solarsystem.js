import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
//  Real-time heliocentric solar system overlay.
//
//  Ephemeris: NASA JPL "Approximate Positions of the Planets"
//             (Standish, Keplerian elements at J2000, valid 1800–2050).
//             ssd.jpl.nasa.gov/planets/approx_pos.html
//
//  Frame: geocentric — Earth stays at scene origin. Sun + planets are placed
//  at their current geocentric positions, and the whole solar-system group
//  is rotated by -GMST about the north-pole axis so that Sun direction stays
//  consistent with the globe's day/night terminator shader.
//
//  Visibility fades in when the camera zooms out past Earth scale.
// ─────────────────────────────────────────────────────────────────────────────

const DEG       = Math.PI / 180;
const AU_SCENE  = 25;                    // 1 AU  = 25 scene units
const OBLIQUITY = 23.4392911 * DEG;       // Earth's axial tilt (J2000)
const FADE_IN   = 10;                    // camera distance at which overlay starts fading in
const FADE_OUT  = 30;                    // fully visible at this distance

// J2000 Keplerian elements (a AU, e, i°, L°, ω̄°, Ω°) + rates per Julian century.
// "Earth" element set is actually the Earth-Moon barycenter (JPL convention).
const PLANETS = [
  { name:'Mercury', color:0xa8a29e, size:0.32,
    e0:[0.38709927, 0.20563593, 7.00497902, 252.25032350,  77.45779628,  48.33076593],
    er:[0.00000037, 0.00001906,-0.00594749,149472.67411175, 0.16047689, -0.12534081] },
  { name:'Venus',   color:0xe8c890, size:0.48,
    e0:[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718,  76.67984255],
    er:[0.00000390,-0.00004107,-0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
  { name:'Earth',   color:0x4488ff, size:0.50,
    e0:[1.00000261, 0.01671123,-0.00001531, 100.46457166, 102.93768193,   0.0       ],
    er:[0.00000562,-0.00004392,-0.01294668, 35999.37244981, 0.32327364,   0.0       ] },
  { name:'Mars',    color:0xcc5533, size:0.38,
    e0:[1.52371034, 0.09339410, 1.84969142,  -4.55343205, -23.94362959,  49.55953891],
    er:[0.00001847, 0.00007882,-0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  { name:'Jupiter', color:0xd8b080, size:1.25,
    e0:[5.20288700, 0.04838624, 1.30439695,  34.39644051,  14.72847983, 100.47390909],
    er:[-0.00011607,-0.00013253,-0.00183714, 3034.74612775, 0.21252668,  0.20469106] },
  { name:'Saturn',  color:0xe6d098, size:1.05,
    e0:[9.53667594, 0.05386179, 2.48599187,  49.95424423,  92.59887831, 113.66242448],
    er:[-0.00125060,-0.00050991, 0.00193609, 1222.49362201,-0.41897216, -0.28867794] },
  { name:'Uranus',  color:0x9ec8d4, size:0.78,
    e0:[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630,  74.01692503],
    er:[-0.00196176,-0.00004397,-0.00242939,  428.48202785,  0.40805281,   0.04240589] },
  { name:'Neptune', color:0x4a6ecb, size:0.78,
    e0:[30.06992276, 0.00859048, 1.77004347, -55.12002969,  44.96476227, 131.78422574],
    er:[ 0.00026291, 0.00005105, 0.00035372,  218.45945325,-0.32241464,  -0.00508664] },
];

// ── Kepler solver ────────────────────────────────────────────────────────────

function solveKepler(M, e) {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 10; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return E;
}

// ── Time helpers ─────────────────────────────────────────────────────────────

function julianCentury(date) {
  const JD = date.getTime() / 86400000 + 2440587.5;
  return (JD - 2451545.0) / 36525;
}

function gmstRad(date) {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const n  = JD - 2451545.0;
  const deg = ((280.46061837 + 360.98564736629 * n) % 360 + 360) % 360;
  return deg * DEG;
}

function elementsAt(p, T) {
  const [a0,e0,i0,L0,w0,O0] = p.e0;
  const [ar,er,ir,Lr,wr,Or] = p.er;
  return {
    a:     a0 + ar * T,
    e:     e0 + er * T,
    i:    (i0 + ir * T) * DEG,
    L:    (L0 + Lr * T) * DEG,
    wBar: (w0 + wr * T) * DEG,
    omega:(O0 + Or * T) * DEG,
  };
}

// ── Orbital point sampler (heliocentric ecliptic J2000, astronomical convention) ──
// Returns AU. Axes: X = vernal equinox, Y = 90° ecliptic longitude, Z = ecliptic north.

function sampleOrbit(E, el) {
  const { a, e, i, wBar, omega } = el;
  const w  = wBar - omega;
  const cE = Math.cos(E), sE = Math.sin(E);
  const xP = a * (cE - e);
  const yP = a * Math.sqrt(Math.max(0, 1 - e * e)) * sE;

  const cw = Math.cos(w),     sw = Math.sin(w);
  const cO = Math.cos(omega), sO = Math.sin(omega);
  const ci = Math.cos(i),     si = Math.sin(i);

  return {
    x: ( cw*cO - sw*sO*ci) * xP + (-sw*cO - cw*sO*ci) * yP,
    y: ( cw*sO + sw*cO*ci) * xP + (-sw*sO + cw*cO*ci) * yP,
    z: ( sw*si)             * xP + ( cw*si)            * yP,
  };
}

function currentPosition(el) {
  let M = el.L - el.wBar;
  M = ((M + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return sampleOrbit(solveKepler(M, el.e), el);
}

// Ecliptic → equatorial (astronomical: rotate about X by obliquity)
function eclToEq(p) {
  const c = Math.cos(OBLIQUITY), s = Math.sin(OBLIQUITY);
  return { x: p.x, y: c*p.y - s*p.z, z: s*p.y + c*p.z };
}

// Astro equatorial (X=vernal, Y=RA90°, Z=north)  →  scene J2000 (X=vernal, Y=north, Z=-RA90°)
// Matches the axis convention used by globe.js geo2xyz() so scene ECEF = group rotated by -GMST about Y.
function astroToScene(p) {
  return { x: p.x, y: p.z, z: -p.y };
}

// ── Scene objects ────────────────────────────────────────────────────────────

let solarGroup;
let sunMesh;
const planetMeshes = new Map();
const orbitLines   = new Map();

export function initSolarSystem(scene) {
  solarGroup = new THREE.Group();
  solarGroup.renderOrder = 2;
  scene.add(solarGroup);

  // ── Sun ──────────────────────────────────────────────────────────────
  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 48, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffdc8a, transparent: true, opacity: 0, depthWrite: false,
    })
  );
  sunMesh.renderOrder = 3;
  solarGroup.add(sunMesh);

  // Corona sprite
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: buildGlowTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true, opacity: 0, depthWrite: false,
  }));
  corona.scale.set(22, 22, 1);
  corona.userData.role = 'corona';
  sunMesh.add(corona);

  // Sun point light (illuminates planet MeshStandardMaterials)
  const sunLight = new THREE.PointLight(0xfff0d0, 0, 0, 0);
  sunLight.userData.role = 'sunlight';
  sunMesh.add(sunLight);

  // ── Planets + orbits ─────────────────────────────────────────────────
  for (const p of PLANETS) {
    const mat = new THREE.MeshStandardMaterial({
      color: p.color, roughness: 1.0, metalness: 0.0,
      emissive: p.color, emissiveIntensity: 0.0,
      transparent: true, opacity: 0, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 24, 24), mat);
    mesh.userData.planet = p.name;
    planetMeshes.set(p.name, mesh);
    if (p.name !== 'Earth') solarGroup.add(mesh);

    // Saturn's rings
    if (p.name === 'Saturn') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(p.size * 1.35, p.size * 2.15, 80),
        new THREE.MeshBasicMaterial({
          color: 0xd8c28c, side: THREE.DoubleSide,
          transparent: true, opacity: 0, depthWrite: false,
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring.userData.role = 'ring';
      mesh.add(ring);
    }

    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(256 * 3), 3));
    const orbit = new THREE.LineLoop(orbitGeo, new THREE.LineBasicMaterial({
      color:       p.name === 'Earth' ? 0x66ccff : 0x4a5878,
      transparent: true,
      opacity:     0,
      depthWrite:  false,
    }));
    orbit.userData.planet = p.name;
    orbitLines.set(p.name, orbit);
    solarGroup.add(orbit);
  }
}

function buildGlowTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0.00, 'rgba(255,232,150,0.95)');
  g.addColorStop(0.30, 'rgba(255,180, 70,0.45)');
  g.addColorStop(0.70, 'rgba(255,120, 40,0.10)');
  g.addColorStop(1.00, 'rgba(255,100, 40,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ── Per-frame update ─────────────────────────────────────────────────────────

export function updateSolarSystem(camera, date) {
  if (!solarGroup) return;

  const camDist = camera.position.length();
  const fade = Math.min(1, Math.max(0, (camDist - FADE_IN) / (FADE_OUT - FADE_IN)));

  solarGroup.visible = fade > 0.001;
  if (!solarGroup.visible) return;

  const T       = julianCentury(date);
  const earthEl = elementsAt(PLANETS.find(p => p.name === 'Earth'), T);
  const earthHE = currentPosition(earthEl);           // helio ecliptic (AU)

  // Sun geocentric = -earthHE.  Transform to scene frame (pre-GMST).
  const sunG  = astroToScene(eclToEq({ x: -earthHE.x, y: -earthHE.y, z: -earthHE.z }));
  sunMesh.position.set(sunG.x * AU_SCENE, sunG.y * AU_SCENE, sunG.z * AU_SCENE);
  sunMesh.material.opacity = fade;
  sunMesh.traverse(o => {
    if (o.userData.role === 'corona')   o.material.opacity = fade;
    if (o.userData.role === 'sunlight') o.intensity = 2.2 * fade;
  });

  // Planets + orbits
  for (const p of PLANETS) {
    const el    = elementsAt(p, T);
    const orbit = orbitLines.get(p.name);
    const arr   = orbit.geometry.attributes.position.array;
    const N     = arr.length / 3;

    for (let k = 0; k < N; k++) {
      const he = sampleOrbit((k / N) * 2 * Math.PI, el);
      const ge = eclToEq({ x: he.x - earthHE.x, y: he.y - earthHE.y, z: he.z - earthHE.z });
      const sc = astroToScene(ge);
      arr[k * 3]     = sc.x * AU_SCENE;
      arr[k * 3 + 1] = sc.y * AU_SCENE;
      arr[k * 3 + 2] = sc.z * AU_SCENE;
    }
    orbit.geometry.attributes.position.needsUpdate = true;
    orbit.material.opacity = (p.name === 'Earth' ? 0.85 : 0.32) * fade;

    if (p.name !== 'Earth') {
      const he  = currentPosition(el);
      const ge  = eclToEq({ x: he.x - earthHE.x, y: he.y - earthHE.y, z: he.z - earthHE.z });
      const sc  = astroToScene(ge);
      const msh = planetMeshes.get(p.name);
      msh.position.set(sc.x * AU_SCENE, sc.y * AU_SCENE, sc.z * AU_SCENE);
      msh.material.opacity          = fade;
      msh.material.emissiveIntensity = 0.18 * fade;
      const ring = msh.children.find(c => c.userData.role === 'ring');
      if (ring) ring.material.opacity = 0.55 * fade;
    }
  }

  // Rotate scene-J2000-equatorial → ECEF so Sun direction matches the Earth shader's terminator.
  solarGroup.rotation.y = -gmstRad(date);
}

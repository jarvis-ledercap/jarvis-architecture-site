import * as THREE from './vendor/three.module.js';

const TYPE_COLORS = {
  core: 0xffd166,
  memory: 0x4cc9f0,
  project: 0x72efdd,
  skill: 0xc77dff,
  skill_progress: 0x80ed99,
  doc: 0xa0c4ff,
  ops: 0xff6b6b,
  default: 0x9aa6d1
};

const DOMAIN_COLORS = {
  ledercap: 0x00ffc3,
  robotics: 0x72efdd,
  cfa: 0xc77dff,
  nestpoint: 0x4cc9f0,
  'social-capital': 0xffd166,
  infrastructure: 0xa0c4ff,
  memory: 0xff6b6b,
  general: 0x9aa6d1
};

const VIZ_CONFIG = {
  orbit: {
    radius: 78,
    height: 44,
    zoomMin: 18,
    zoomMax: 220,
    wheelSensitivity: 0.03,
    dragRotateSensitivity: 0.008,
    dragHeightSensitivity: 0.22,
    heightMin: 8,
    heightMax: 120
  },
  nodes: {
    hoverScale: 1.14,
    levelSpacing: 8.2
  },
  camera: {
    lookAt: new THREE.Vector3(0, 0, 14)
  }
};

const legend = document.getElementById('legend');
const details = document.getElementById('details');
const graphContainer = document.getElementById('graph');
const viewModeEl = document.getElementById('viewMode');
const domainFilterEl = document.getElementById('domainFilter');
const layoutModeEl = document.getElementById('layoutMode');
const dimensionalModeEl = document.getElementById('dimensionalMode');
const forestTitleEl = document.getElementById('forestTitle');

Object.entries(TYPE_COLORS)
  .filter(([k]) => k !== 'default')
  .forEach(([type, color]) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="dot" style="background:#${color.toString(16).padStart(6, '0')}"></span>${type}`;
    legend.appendChild(item);
  });

let graphData;
async function loadGraphData() {
  const publicMode = new URLSearchParams(window.location.search).get('public') === '1';
  const candidates = publicMode
    ? ['../data/public-memory-graph.json', '/data/public-memory-graph.json']
    : [
        '../data/memory-graph.generated.json',
        '/data/memory-graph.generated.json',
        '../data/memory-graph.v1.json',
        '/data/memory-graph.v1.json'
      ];

  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.nodes?.length) return json;
    } catch {}
  }
  return { nodes: [], links: [], summary: { error: 'No graph data found. Serve from project root and open /app/.' } };
}

graphData = await loadGraphData();
if (!graphData.nodes.length) {
  details.innerHTML = '<strong>Graph data missing</strong><br/><span>Start server from <code>memory-architecture-3d/</code> and open <code>/app/</code>.</span>';
}

const domains = Array.from(new Set((graphData.nodes || []).map(n => n.domain).filter(Boolean))).sort();
for (const d of domains) {
  const opt = document.createElement('option');
  opt.value = d;
  opt.textContent = d;
  domainFilterEl?.appendChild(opt);
}

const urlParams = new URLSearchParams(window.location.search);
const initialLayoutMode = urlParams.get('layout') || 'executive';
const initialDimensionalMode = urlParams.get('dim') || '3d';
if (layoutModeEl && ['executive', 'natural', 'circle', 'domain'].includes(initialLayoutMode)) {
  layoutModeEl.value = initialLayoutMode;
}
if (dimensionalModeEl && ['3d', '2d'].includes(initialDimensionalMode)) {
  dimensionalModeEl.value = initialDimensionalMode;
}
if (forestTitleEl) {
  forestTitleEl.textContent = `Memory Forest — ${initialDimensionalMode === '2d' ? '2D' : '3D'}`;
}

const dedupeCounts = new Map();
for (const n of graphData.nodes || []) {
  if (!n.dedupeKey) continue;
  dedupeCounts.set(n.dedupeKey, (dedupeCounts.get(n.dedupeKey) || 0) + 1);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071014);
scene.fog = new THREE.Fog(0x071014, 95, 300);

const camera = new THREE.PerspectiveCamera(60, graphContainer.clientWidth / graphContainer.clientHeight, 0.1, 2000);
camera.position.set(42, -62, 42);
camera.up.set(0, 0, 1); // z-up world for VR-oriented layout
camera.lookAt(VIZ_CONFIG.camera.lookAt);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(graphContainer.clientWidth, graphContainer.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
graphContainer.appendChild(renderer.domElement);

const hoverLabel = document.createElement('div');
hoverLabel.id = 'hoverLabel';
hoverLabel.style.display = 'none';
graphContainer.appendChild(hoverLabel);

// VR controls temporarily disabled in web preview to avoid CDN module-resolution issues.

let orbitAngle = 0;
let orbitRadius = VIZ_CONFIG.orbit.radius;
let orbitHeight = VIZ_CONFIG.orbit.height;
let walkMode = false;

const dragState = {
  active: false,
  lastX: 0,
  lastY: 0
};

const moveState = { forward: false, back: false, left: false, right: false, up: false, down: false };
let yaw = Math.PI * 0.25;
let pitch = -0.2;
const walkSpeed = 0.34;
const treeColliders = [];

renderer.domElement.addEventListener('wheel', (e) => {
  if (walkMode) return;
  e.preventDefault();
  orbitRadius = Math.min(
    VIZ_CONFIG.orbit.zoomMax,
    Math.max(VIZ_CONFIG.orbit.zoomMin, orbitRadius + e.deltaY * VIZ_CONFIG.orbit.wheelSensitivity)
  );
}, { passive: false });

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xaed9ff, 0.7);
key.position.set(40, -30, 70);
scene.add(key);

// Ground plane (xy)
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(140, 64),
  new THREE.MeshStandardMaterial({ color: 0x0d1820, roughness: 0.95, metalness: 0.05 })
);
ground.rotation.x = 0; // already on xy for z-up
scene.add(ground);

// Concentric helper rings
for (let r = 20; r <= 120; r += 20) {
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 80 }, (_, i) => {
        const a = (i / 80) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0.02);
      })
    ),
    new THREE.LineBasicMaterial({ color: 0x14343a, transparent: true, opacity: 0.42 })
  );
  scene.add(ring);
}

// Build a filesystem-like tree map from node paths
const workspacePrefix = '/Users/jarvis-ai/.openclaw/workspace';
const pathMap = new Map();
for (const n of graphData.nodes) {
  if (!n.path || !n.path.startsWith(workspacePrefix)) continue;
  const rel = n.path.slice(workspacePrefix.length).replace(/^\//, '');
  pathMap.set(rel, n);
}

// Hierarchy object
const roots = new Map();
for (const [relPath, node] of pathMap.entries()) {
  const parts = relPath.split('/').filter(Boolean);
  if (!parts.length) continue;
  const top = parts[0];
  if (!roots.has(top)) roots.set(top, { name: top, children: new Map(), nodeRef: pathMap.get(top) || null });

  let current = roots.get(top);
  let accum = top;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    accum += '/' + part;
    if (!current.children.has(part)) {
      current.children.set(part, {
        name: part,
        children: new Map(),
        nodeRef: pathMap.get(accum) || null,
        relPath: accum
      });
    }
    current = current.children.get(part);
  }
}

const clickable = [];
const nodeMeshes = [];

function createNodeMesh(label, type = 'default', radius = 0.45, domain = 'general') {
  const baseColor = DOMAIN_COLORS[domain] ?? TYPE_COLORS[type] ?? TYPE_COLORS.default;
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    emissive: baseColor,
    emissiveIntensity: 0.18,
    roughness: 0.4,
    metalness: 0.15
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 14), mat);
  mesh.userData = { label, type, domain };
  return mesh;
}

function createBranchLine(start, end, width = 1.4, color = 0x2b6f72) {
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = dir.length();
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(width * 0.08, width * 0.12, len, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05 })
  );
  cyl.position.copy(start).addScaledVector(dir, 0.5);
  cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return cyl;
}

const rootEntries = Array.from(roots.entries());

function estimateTreeMass(treeNode, depth = 0, maxDepth = 4) {
  if (!treeNode || depth > maxDepth) return 0;
  const children = Array.from(treeNode.children?.values?.() ?? []);
  let mass = 1;
  for (const child of children) {
    mass += estimateTreeMass(child, depth + 1, maxDepth) * 0.8;
  }
  return mass;
}

const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const layoutMode = layoutModeEl?.value || 'natural';

const rootPositions = rootEntries.map(([_, rootTree], idx) => {
  const mass = estimateTreeMass(rootTree);

  if (layoutMode === 'executive') {
    const label = rootTree.nodeRef?.label || rootTree.name || '';
    const is2D = (dimensionalModeEl?.value || '3d') === '2d';
    const primarySlots = is2D ? {
      'LederCap': new THREE.Vector3(-96, 34, 0.8),
      'Robotics': new THREE.Vector3(-52, 78, 0.8),
      'CFA': new THREE.Vector3(0, 102, 0.8),
      'Nestpoint': new THREE.Vector3(52, 78, 0.8),
      'Social Capital': new THREE.Vector3(96, 34, 0.8),
      'Intake': new THREE.Vector3(-100, -48, 0.8),
      'Memory': new THREE.Vector3(-34, -78, 0.8),
      'Indexing': new THREE.Vector3(0, -96, 0.8),
      'Embeddings': new THREE.Vector3(34, -78, 0.8),
      'Outputs': new THREE.Vector3(100, -48, 0.8),
      'Infrastructure': new THREE.Vector3(0, -112, 0.8)
    } : {
      'LederCap': new THREE.Vector3(-78, 12, 0.8),
      'Robotics': new THREE.Vector3(-30, 62, 0.8),
      'CFA': new THREE.Vector3(0, 88, 0.8),
      'Nestpoint': new THREE.Vector3(30, 62, 0.8),
      'Social Capital': new THREE.Vector3(78, 12, 0.8),
      'Memory': new THREE.Vector3(-40, -72, 0.8),
      'Infrastructure': new THREE.Vector3(40, -72, 0.8)
    };

    const domain = rootTree.nodeRef?.domain || 'general';
    const domainBases = {
      ledercap: new THREE.Vector3(-78, 12, 0.8),
      robotics: new THREE.Vector3(0, 66, 0.8),
      cfa: new THREE.Vector3(78, 12, 0.8),
      nestpoint: new THREE.Vector3(-54, -54, 0.8),
      'social-capital': new THREE.Vector3(54, -54, 0.8),
      memory: new THREE.Vector3(0, -82, 0.8),
      infrastructure: new THREE.Vector3(0, 104, 0.8),
      general: new THREE.Vector3(0, 0, 0.8)
    };

    const isPrimary = !!primarySlots[label];
    const base = primarySlots[label] || domainBases[domain] || domainBases.general;
    const canopyRadius = Math.min(16, 4 + Math.sqrt(Math.max(1, mass)) * 1.25);
    const localAngle = idx * 1.618;
    const localRadius = isPrimary ? 0 : canopyRadius;

    return {
      mass,
      canopyRadius,
      isPrimary,
      pos: new THREE.Vector3(
        base.x + Math.cos(localAngle) * localRadius,
        base.y + Math.sin(localAngle) * localRadius,
        base.z
      )
    };
  }

  if (layoutMode === 'circle') {
    const baseRadius = 58 + Math.min(24, Math.sqrt(mass) * 2.2);
    const a = (idx / Math.max(rootEntries.length, 1)) * Math.PI * 2;
    return {
      mass,
      pos: new THREE.Vector3(Math.cos(a) * baseRadius, Math.sin(a) * baseRadius, 0.8)
    };
  }

  if (layoutMode === 'domain') {
    const domain = rootTree.nodeRef?.domain || 'general';
    const domainKeys = Array.from(new Set(rootEntries.map(([__, t]) => t.nodeRef?.domain || 'general'))).sort();
    const domainIdx = domainKeys.indexOf(domain);
    const domainAngle = (domainIdx / Math.max(domainKeys.length, 1)) * Math.PI * 2;
    const localAngle = idx * 0.82;
    const clusterRadius = 32 + domainIdx * 6;
    const localRadius = 8 + Math.sqrt(Math.max(1, idx + 1)) * 3 + Math.min(10, Math.sqrt(mass) * 1.2);
    const x = Math.cos(domainAngle) * clusterRadius + Math.cos(localAngle) * localRadius;
    const y = Math.sin(domainAngle) * clusterRadius + Math.sin(localAngle) * localRadius;
    return { mass, pos: new THREE.Vector3(x, y, 0.8) };
  }

  const growthRadius = Math.sqrt(Math.max(1, idx + 1)) * 13.5;
  const massOffset = Math.min(22, Math.sqrt(mass) * 1.6);
  const angle = idx * goldenAngle + (mass * 0.17);
  const jitter = (Math.sin((idx + 1) * 12.9898) * 43758.5453) % 1;
  const jitterNorm = (jitter - Math.floor(jitter)) - 0.5;
  const radius = growthRadius + massOffset + jitterNorm * 4;

  return {
    mass,
    pos: new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.8)
  };
});

for (let pass = 0; pass < 6; pass++) {
  for (let i = 0; i < rootPositions.length; i++) {
    for (let j = i + 1; j < rootPositions.length; j++) {
      const a = rootPositions[i];
      const b = rootPositions[j];
      const delta = new THREE.Vector2(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      const dist = Math.max(0.001, delta.length());
      const executiveGap = ((a.canopyRadius || 6) + (b.canopyRadius || 6)) + 18;
      const naturalGap = 9 + Math.min(14, Math.sqrt(a.mass + b.mass) * 1.2);
      const minDist = layoutMode === 'executive' ? executiveGap : naturalGap;
      if (dist < minDist) {
        const push = (minDist - dist) * 0.5;
        delta.normalize();
        if (!a.isPrimary) {
          a.pos.x += delta.x * push;
          a.pos.y += delta.y * push;
        }
        if (!b.isPrimary) {
          b.pos.x -= delta.x * push;
          b.pos.y -= delta.y * push;
        }
      }
    }
  }
}

rootEntries.forEach(([rootName, rootTree], idx) => {
  const rootLayout = rootPositions[idx];
  const rootPos = rootLayout.pos.clone();

  // trunk
  const trunkTop = rootPos.clone().add(new THREE.Vector3(0, 0, rootLayout.isPrimary ? 12 : 9));
  const trunk = createBranchLine(rootPos, trunkTop, rootLayout.isPrimary ? 4.8 : 3.3, rootLayout.isPrimary ? 0x00ffc3 : 0x2b6f72);
  scene.add(trunk);
  const rootMass = rootPositions[idx].mass;
  treeColliders.push({ x: rootPos.x, y: rootPos.y, r: Math.min(10, 2.4 + (rootLayout.canopyRadius || 5) * 0.45) });

  const rootType = rootTree.nodeRef?.type ?? 'project';
  const rootDomain = rootTree.nodeRef?.domain ?? 'general';
  const rootNode = createNodeMesh(rootTree.nodeRef?.label || rootName, rootType, rootLayout.isPrimary ? 1.7 : 1.05, rootDomain);
  rootNode.position.copy(trunkTop);
  rootNode.userData.path = rootTree.nodeRef?.path ?? `${workspacePrefix}/${rootName}`;
  rootNode.userData.domain = rootTree.nodeRef?.domain ?? 'general';
  rootNode.userData.nodeType = rootType;
  rootNode.userData.status = rootTree.nodeRef?.status ?? 'active';
  rootNode.userData.orphan = !!rootTree.nodeRef?.orphan;
  rootNode.userData.redundant = !!rootTree.nodeRef?.redundant;
  rootNode.userData.dedupeKey = rootTree.nodeRef?.dedupeKey || null;
  nodeMeshes.push(rootNode);
  scene.add(rootNode);
  clickable.push(rootNode);

  function grow(parentObj, childrenMap, depth, ringR = 10) {
    const is2D = (dimensionalModeEl?.value || '3d') === '2d';
    let children = Array.from(childrenMap.values());
    if (layoutMode === 'executive') {
      children = children.filter(child => child.nodeRef?.type !== 'doc' || depth <= 1);
    }
    if (!children.length || depth > 5) return;

    children.forEach((child, cIdx) => {
      const baseAngle = (cIdx / Math.max(children.length, 1)) * Math.PI * 2;
      const tilt = 0.55 + depth * 0.1;
      const executiveSpread = layoutMode === 'executive' ? 1.5 : 1;
      const dx = Math.cos(baseAngle) * ringR * executiveSpread * (1 / (depth * 0.72));
      const dy = Math.sin(baseAngle) * ringR * executiveSpread * (1 / (depth * 0.72));
      const dz = is2D ? Math.max(0.2, 1.4 - depth * 0.25) : VIZ_CONFIG.nodes.levelSpacing * (1 / Math.pow(depth, 0.12)) * tilt;

      const childPos = parentObj.position.clone().add(new THREE.Vector3(dx, dy, dz));
      const branch = createBranchLine(parentObj.position, childPos, Math.max(0.5, 2.2 - depth * 0.26), layoutMode === 'executive' ? 0x1ea7a8 : 0x6d89bd);
      scene.add(branch);

      const type = child.nodeRef?.type ?? (child.name.endsWith('.md') ? 'memory' : 'project');
      const domain = child.nodeRef?.domain ?? 'general';
      const label = child.nodeRef?.label || child.name;
      const node = createNodeMesh(label, type, Math.max(0.24, 0.55 - depth * 0.05), domain);
      node.position.copy(childPos);
      node.userData.path = child.nodeRef?.path ?? `${workspacePrefix}/${child.relPath ?? child.name}`;
      node.userData.domain = child.nodeRef?.domain ?? 'general';
      node.userData.nodeType = type;
      node.userData.status = child.nodeRef?.status ?? 'active';
      node.userData.orphan = !!child.nodeRef?.orphan;
      node.userData.redundant = !!child.nodeRef?.redundant;
      node.userData.dedupeKey = child.nodeRef?.dedupeKey || null;
      scene.add(node);
      clickable.push(node);
      nodeMeshes.push(node);

      grow(node, child.children, depth + 1, ringR * 0.88);
    });
  }

  grow(rootNode, rootTree.children, 1, 13);
});

applyViewFilters();

// interaction
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredNode = null;

function showNodeDetails(obj) {
  const dupCount = obj.userData.dedupeKey ? (dedupeCounts.get(obj.userData.dedupeKey) || 0) : 0;
  const recommendation = obj.userData.redundant
    ? `Recommendation: merge into canonical note (duplicate cluster size: ${dupCount}).`
    : obj.userData.orphan
      ? 'Recommendation: link this note to at least one active project/skill.'
      : (obj.userData.status === 'stale' ? 'Recommendation: refresh or archive.' : 'Recommendation: keep active.');

  details.innerHTML = `
    <strong>${obj.userData.label}</strong><br />
    <span>Type: ${obj.userData.type}</span><br/>
    <span>Domain: ${obj.userData.domain ?? 'general'}</span><br/>
    <span>Status: ${obj.userData.status ?? 'active'}</span>
    ${(obj.userData.orphan || obj.userData.redundant) ? `<br/><span>Flags: ${obj.userData.orphan ? 'orphan ' : ''}${obj.userData.redundant ? 'redundant' : ''}</span>` : ''}
    ${obj.userData.path ? `<code>${obj.userData.path}</code>` : ''}
    <p style="margin-top:8px;"><strong>${recommendation}</strong></p>
  `;
}

function applyViewFilters() {
  const mode = viewModeEl?.value ?? 'all';
  const domain = domainFilterEl?.value ?? 'all';
  const layout = layoutModeEl?.value ?? 'executive';

  for (const mesh of nodeMeshes) {
    const nodeType = mesh.userData.nodeType || mesh.userData.type;
    const nodeDomain = mesh.userData.domain || 'general';
    const label = mesh.userData.label || '';
    const isMajorDomain = ['LederCap', 'Robotics', 'CFA', 'Nestpoint', 'Social Capital', 'Intake', 'Memory', 'Indexing', 'Embeddings', 'Outputs'].includes(label);
    const isMajor = isMajorDomain || mesh.scale.x >= 1 || /^domain_/i.test(mesh.userData.path || '');

    let active = true;
    if (mode === 'timeline') active = nodeType === 'skill_progress';
    if (mode === 'structure') active = nodeType !== 'skill_progress';
    if (mode === 'health') active = mesh.userData.status === 'stale' || mesh.userData.orphan || mesh.userData.redundant;
    if (domain !== 'all' && nodeDomain !== domain) active = false;
    if (layout === 'executive' && !isMajor && nodeType === 'doc') active = false;

    mesh.visible = active;
    mesh.material.transparent = true;
    mesh.material.opacity = active ? 1 : 0.08;
    mesh.material.emissiveIntensity = active ? 0.24 : 0.03;
  }
}

viewModeEl?.addEventListener('change', applyViewFilters);
domainFilterEl?.addEventListener('change', applyViewFilters);
layoutModeEl?.addEventListener('change', () => {
  const params = new URLSearchParams(window.location.search);
  params.set('layout', layoutModeEl.value);
  params.set('dim', dimensionalModeEl?.value || '3d');
  window.location.search = params.toString();
});

dimensionalModeEl?.addEventListener('change', () => {
  if (forestTitleEl) {
    forestTitleEl.textContent = `Memory Forest — ${dimensionalModeEl.value === '2d' ? '2D' : '3D'}`;
  }
  const params = new URLSearchParams(window.location.search);
  params.set('layout', layoutModeEl?.value || 'executive');
  params.set('dim', dimensionalModeEl.value);
  window.location.search = params.toString();
});

let pendingHoverEvent = null;
let hoverRaf = null;

function hideHoverLabel() {
  hoverLabel.style.display = 'none';
  if (hoveredNode) {
    hoveredNode.scale.setScalar(1);
    hoveredNode = null;
  }
}

function renderHoverLabel(event) {
  if (walkMode) {
    hideHoverLabel();
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(clickable);
  if (!intersects.length) {
    hideHoverLabel();
    return;
  }

  const hit = intersects[0].object;
  if (hoveredNode && hoveredNode !== hit) hoveredNode.scale.setScalar(1);
  hoveredNode = hit;
  hoveredNode.scale.setScalar(VIZ_CONFIG.nodes.hoverScale);

  const flags = `${hit.userData.orphan ? 'orphan ' : ''}${hit.userData.redundant ? 'redundant' : ''}`.trim();
  hoverLabel.innerHTML = `
    <strong>${hit.userData.label || 'node'}</strong>
    <div class="hover-meta">${hit.userData.type || 'unknown'} · ${hit.userData.domain || 'general'} · ${hit.userData.status || 'active'}</div>
    ${flags ? `<div class="hover-flags">${flags}</div>` : ''}
  `;
  hoverLabel.style.display = 'block';
  hoverLabel.style.left = `${event.clientX - rect.left + 12}px`;
  hoverLabel.style.top = `${event.clientY - rect.top + 12}px`;
}

function scheduleHover(event) {
  pendingHoverEvent = event;
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = null;
    if (pendingHoverEvent) renderHoverLabel(pendingHoverEvent);
    pendingHoverEvent = null;
  });
}

renderer.domElement.addEventListener('mousemove', (event) => {
  if (!walkMode && dragState.active) {
    const dx = event.clientX - dragState.lastX;
    const dy = event.clientY - dragState.lastY;
    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;

    orbitAngle -= dx * VIZ_CONFIG.orbit.dragRotateSensitivity;
    orbitHeight = Math.max(
      VIZ_CONFIG.orbit.heightMin,
      Math.min(VIZ_CONFIG.orbit.heightMax, orbitHeight + dy * VIZ_CONFIG.orbit.dragHeightSensitivity)
    );
  }

  scheduleHover(event);
});

renderer.domElement.addEventListener('mouseleave', () => {
  hideHoverLabel();
  pendingHoverEvent = null;
  if (hoverRaf) {
    cancelAnimationFrame(hoverRaf);
    hoverRaf = null;
  }
  dragState.active = false;
});

renderer.domElement.addEventListener('mousedown', (event) => {
  if (walkMode) return;
  if (event.button !== 0) return;
  dragState.active = true;
  dragState.lastX = event.clientX;
  dragState.lastY = event.clientY;
});

window.addEventListener('mouseup', () => {
  dragState.active = false;
});

renderer.domElement.addEventListener('click', (event) => {
  if (walkMode && document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock();
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(clickable);
  if (!intersects.length) return;

  const hit = intersects[0].object;
  showNodeDetails(hit);
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'f') {
    walkMode = !walkMode;
    if (!walkMode && document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    details.innerHTML = walkMode
      ? '<strong>Walk mode ON</strong><br/><span>WASD move, Q/E vertical, mouse look. Press F to exit walk mode.</span>'
      : '<strong>Orbit mode ON</strong><br/><span>Mouse wheel zoom. Press F for walk mode.</span>';
  }

  if (k === 'w') moveState.forward = true;
  if (k === 's') moveState.back = true;
  if (k === 'a') moveState.left = true;
  if (k === 'd') moveState.right = true;
  if (k === 'q') moveState.down = true;
  if (k === 'e') moveState.up = true;
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w') moveState.forward = false;
  if (k === 's') moveState.back = false;
  if (k === 'a') moveState.left = false;
  if (k === 'd') moveState.right = false;
  if (k === 'q') moveState.down = false;
  if (k === 'e') moveState.up = false;
});

window.addEventListener('mousemove', (e) => {
  if (!walkMode || document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
});


function frame() {
  const layout = layoutModeEl?.value || 'executive';
  for (const sprite of textSprites) {
    sprite.lookAt(camera.position);
    if (layout === 'executive' && !sprite.userData.isPrimary && !sprite.userData.isSecondary) sprite.visible = false;
    else sprite.visible = true;
  }

  if (!renderer.xr.isPresenting) {
    if (walkMode) {
      const forward = new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0);
      const right = new THREE.Vector3(-Math.sin(yaw), Math.cos(yaw), 0);

      if (moveState.forward) camera.position.addScaledVector(forward, walkSpeed);
      if (moveState.back) camera.position.addScaledVector(forward, -walkSpeed);
      if (moveState.left) camera.position.addScaledVector(right, -walkSpeed);
      if (moveState.right) camera.position.addScaledVector(right, walkSpeed);
      if (moveState.up) camera.position.z += walkSpeed * 0.8;
      if (moveState.down) camera.position.z -= walkSpeed * 0.8;

      for (const c of treeColliders) {
        const dx = camera.position.x - c.x;
        const dy = camera.position.y - c.y;
        const dist = Math.hypot(dx, dy);
        const minDist = c.r + 0.8;
        if (dist < minDist && dist > 0.0001) {
          const push = (minDist - dist) * 0.7;
          camera.position.x += (dx / dist) * push;
          camera.position.y += (dy / dist) * push;
        }
      }

      camera.position.z = Math.max(1.6, Math.min(70, camera.position.z));
      const lookDir = new THREE.Vector3(
        Math.cos(pitch) * Math.cos(yaw),
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch)
      );
      const target = camera.position.clone().add(lookDir);
      camera.lookAt(target);
    } else {
      const is2D = (dimensionalModeEl?.value || '3d') === '2d';
      if (layout === 'executive') {
        if (is2D) {
          camera.position.set(0, -4, 190);
          camera.lookAt(new THREE.Vector3(0, 0, 0));
        } else {
          camera.position.set(0, -128, 72);
          camera.lookAt(new THREE.Vector3(0, 6, 16));
        }
      } else {
        camera.position.x = Math.cos(orbitAngle) * orbitRadius;
        camera.position.y = Math.sin(orbitAngle) * orbitRadius;
        camera.position.z = orbitHeight;
        camera.lookAt(VIZ_CONFIG.camera.lookAt);
      }
    }
  }

  renderer.render(scene, camera);
}
const textSprites = [];

function makeTextSprite(text, color = '#e8fffb', fontSize = 44, weight = 700) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${weight} ${fontSize}px Inter, Arial, sans-serif`;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width + 40);
  canvas.height = Math.ceil(fontSize + 28);
  ctx.font = `${weight} ${fontSize}px Inter, Arial, sans-serif`;
  ctx.fillStyle = 'rgba(7,16,20,0.72)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(0,255,195,0.24)';
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  ctx.fillStyle = color;
  ctx.fillText(text, 20, fontSize);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width / 24, canvas.height / 24, 1);
  return sprite;
}

for (const mesh of nodeMeshes) {
  const label = mesh.userData.label || 'node';
  const isPrimary = ['LederCap', 'Robotics', 'CFA', 'Nestpoint', 'Social Capital'].includes(label);
  const isSecondary = ['Intake', 'Memory', 'Indexing', 'Embeddings', 'Outputs', 'Infrastructure'].includes(label);
  const isMajor = isPrimary || isSecondary || mesh.scale.x >= 1 || /^domain_/i.test(mesh.userData.path || '') || ['ledercap','robotics','cfa'].includes(mesh.userData.domain);
  if (!isMajor) continue;
  const sprite = makeTextSprite(label, isPrimary ? '#00ffc3' : '#e8fffb', isPrimary ? 64 : (isSecondary ? 44 : 36), 700);
  sprite.position.copy(mesh.position).add(new THREE.Vector3(0, 0, isPrimary ? 4.2 : 2.6));
  sprite.userData.isPrimary = isPrimary;
  sprite.userData.isSecondary = isSecondary;
  scene.add(sprite);
  textSprites.push(sprite);
}

renderer.setAnimationLoop(frame);

window.addEventListener('resize', () => {
  camera.aspect = graphContainer.clientWidth / graphContainer.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(graphContainer.clientWidth, graphContainer.clientHeight);
});

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { Rhino3dmLoader } from 'three/examples/jsm/loaders/3DMLoader'
import rhino3dm from 'rhino3dm'

const loader = new Rhino3dmLoader()
loader.setLibraryPath('https://unpkg.com/rhino3dm@8.0.0-beta3/')

const data = {
  // definition: 'form_io_main_002.gh',
  definition: 'test_main_2.gh',

  inputs: {}  // initialize as empty
}

// Rhino library instance
let doc
const rhino = await rhino3dm()
console.log('Loaded rhino3dm.')

let threeScene, threeCamera, threeRenderer
let map
let meshb64Mesh, meshoutMesh
let draw
let isEnvelopeSelectable = false;
let isBlockSelectable = false;
let currentDrawRole = null; // "site", "Envelope", "block", etc.


init()

function getInputs() {
  const inputs = {};
  document.querySelectorAll('#customise-inputs input, #customise-inputs textarea').forEach(input => {
    const id = input.id;
    if (input.type === 'checkbox') {
      inputs[id] = input.checked ? 1 : 0;
    } else {
      const parsed = Number(input.value);
      inputs[id] = isNaN(parsed) ? input.value : parsed;
    }
  });

  if (DJ_SITE_ENVELOPE) {
    inputs['envelope_vertices'] = formatSiteEvnelopeWithTurfDistances(DJ_SITE_ENVELOPE);
  }
  if (draw && DJ_SITE_ENVELOPE) {
    const allBlocks = draw.getAll().features.filter(f => f.properties?.role === 'block');
    const blockStr = formatBlockVertices(allBlocks, DJ_SITE_ENVELOPE);
    inputs['block_vertices'] = blockStr;
    console.log('[Form IO] blockStr recomputed in getInputs():', blockStr);
  }
  return inputs;
}



async function compute() {
  if (!threeScene) return


  data.inputs = getInputs()

  const formData = new FormData()
  formData.append("grasshopper_file_name", data.definition)
  formData.append("input_data", JSON.stringify(data.inputs))

  try {
    const response = await fetch("/api/rhino/solve/", {
      method: "POST",
      body: formData,
      headers: {
        "X-CSRFToken": getCSRFToken(),
      },
    })
    if (!response.ok) throw new Error(response.statusText)
    const json = await response.json()
    collectResults(json)
  } catch (e) {
    console.error('Compute failed:', e)
  }
}

// Helper to get accurate meter-to-Mercator scaling factor
function getMercatorUnitsPerMeterAtOrigin(originLngLat) {
  // Create a point 1 meter east of the origin
  const originPoint = turf.point([originLngLat.lng, originLngLat.lat]);
  const offsetPoint = turf.destination(originPoint, 1, 90, { units: 'meters' }); // 90° = east

  const mercOrigin = mapboxgl.MercatorCoordinate.fromLngLat(originLngLat);
  const mercOffset = mapboxgl.MercatorCoordinate.fromLngLat({
    lng: offsetPoint.geometry.coordinates[0],
    lat: offsetPoint.geometry.coordinates[1]
  });

  const dx = mercOffset.x - mercOrigin.x;

  return dx; // true Mercator units per 1 meter at this location
}



function meshToThreejs(mesh) {
  const loader = new THREE.BufferGeometryLoader();
  const geometry = loader.parse(mesh.toThreejsJSON());



  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6
  });

  return new THREE.Mesh(geometry, material);
}


function replaceCurrentMesh(mesh, type) {
  if (type === 'meshb64' && meshb64Mesh) {
    threeScene.remove(meshb64Mesh)
    meshb64Mesh.geometry.dispose()
    meshb64Mesh.material.dispose()
    meshb64Mesh = null
  } else if (type === 'meshout' && meshoutMesh) {
    threeScene.remove(meshoutMesh)
    meshoutMesh.geometry.dispose()
    meshoutMesh.material.dispose()
    meshoutMesh = null
  }
  if (type === 'meshb64') {
    meshb64Mesh = mesh
    threeScene.add(meshb64Mesh)
  } else if (type === 'meshout') {
    meshoutMesh = mesh
    threeScene.add(meshoutMesh)
  }
  console.log(`[Form IO] Replaced current mesh with type: ${type}`)
  map.triggerRepaint(); // Explicitly force re-render

}

function decodeItem(item) {
  const data = JSON.parse(item.data)
  if (item.type === 'System.String') {
    try {
      return rhino.DracoCompression.decompressBase64String(data)
    } catch {}
  } else if (typeof data === 'object') {
    return rhino.CommonObject.decode(data)
  }
  return null
}

function collectResults(json) {
  if (doc) doc.delete();
  doc = new rhino.File3dm();

  json.values.forEach(output => {
    const branches = output.InnerTree;

    Object.values(branches).forEach(branch => {
      branch.forEach(item => {
        const obj = decodeItem(item);
        if (obj) {
          const mesh = meshToThreejs(obj);

          // --- Place the mesh into the scene
          const isMeshb64 = output.ParamName.includes('meshb64');
          replaceCurrentMesh(mesh, isMeshb64 ? 'meshb64' : 'meshout');
          
          // --- Store decoded object (optional)
          doc.objects().add(obj, null);

          const edges = new THREE.EdgesGeometry(mesh.geometry);
          const line = new THREE.LineSegments(
              edges,
              new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
            );
          line.material.depthTest = false;
          line.material.depthWrite = false;
          line.renderOrder = 1; // Prevent visual glitches
          mesh.add(line);
        }
      });
    });
  });
}


// Global variables for site and Envelope polygons
let sitePolygonId = null;
let EnvelopePolygonId = null;
let siteLabelMarkers = [];
let EnvelopeLabelMarkers = [];

function init() {
  const siteBounds = getBoundsFromSiteGeometry(DJ_SITE_BOUNDS);
  const paddedBounds = getPaddedBounds(siteBounds.bounds);

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: siteBounds.center,
    zoom: 16,
    pitch: 60,
    bearing: -17.6,
    antialias: true,
    maxBounds: paddedBounds
  });

    // Extend the default modes with the rectangle drawing mode
  const modes = MapboxDraw.modes;
  modes.draw_rectangle_drag = mapboxGLDrawRectangleDrag;
  // Initialize the drawing control with the extended modes
  const draw = new MapboxDraw({
    displayControlsDefault: false,
    modes: modes
  });

  // Add the drawing control to the map
  map.addControl(draw);



document.getElementById('btn-envelope-polygon').addEventListener('click', () => {
  currentDrawRole = 'Envelope';
  draw.changeMode('draw_polygon');
  console.log('[Form IO] Drawing mode: Envelope');
});


  document.getElementById('btn-envelope-delete').addEventListener('click', () => {
    if (!isEnvelopeSelectable) {
      showToast('delete-blocked', 'Activate "Edit Envelope" to delete', 'warning', 2000);
      return;
    }

    if (EnvelopePolygonId && draw) {
      // Remove polygon from map
      draw.delete(EnvelopePolygonId);
      EnvelopePolygonId = null;

      // Clear visual markers and inputs
      clearEnvelopeLabels();
      document.getElementById('envelope_vertices').value = '';
      DJ_SITE_ENVELOPE = "";
      saveSiteEvnelope('');

      removeToast('delete-blocked');
      console.warn('[Form IO] Envelope polygon deleted via UI');
    }
  });


  document.getElementById('btn-envelope-select').addEventListener('click', () => {
    const button = document.getElementById('btn-envelope-select');
    isEnvelopeSelectable = !isEnvelopeSelectable;

    if (isEnvelopeSelectable) {
      button.classList.add('btn-active');
      draw.changeMode('simple_select');
      showToast('envelope-select-toast', 'Envelope edit mode "On"', 'neutral');
      console.log('[Form IO] Envelope edit mode ON');
    } else {
      button.classList.remove('btn-active');
      draw.changeMode('simple_select', { featureIds: [] });
      removeToast('envelope-select-toast');
      console.log('[Form IO] Envelope edit mode OFF');
    }
  });


  // Toggle block selection mode
document.getElementById('btn-bldg-select').addEventListener('click', () => {
  const button = document.getElementById('btn-bldg-select');
  isBlockSelectable = !isBlockSelectable;

  if (isBlockSelectable) {
    button.classList.add('btn-active');
    currentDrawRole = 'block';
    draw.changeMode('simple_select');
    showToast('block-select-toast', 'Block edit mode "On"', 'neutral');
    console.log('[Form IO] Block edit mode ON');
  } else {
    button.classList.remove('btn-active');
    currentDrawRole = null;
    draw.changeMode('simple_select', { featureIds: [] });
    removeToast('block-select-toast');
    console.log('[Form IO] Block edit mode OFF');
  }
});


// Draw block as LineString
document.getElementById('btn-bldg-line').addEventListener('click', () => {
  currentDrawRole = 'block';
  draw.changeMode('draw_line_string');
  console.log('[Form IO] Drawing mode: block line (2-point limit)');

  const handler = (e) => {
    const features = draw.getAll().features;
    const current = features[features.length - 1];

    if (current?.geometry?.type === 'LineString' && current.geometry.coordinates.length === 2) {
      draw.changeMode('simple_select', { featureIds: [current.id] });
      console.log('[Form IO] Line completed after 2 points');
      map.off('draw.update', handler); // Remove this temp handler
    }
  };

  map.on('draw.update', handler);
});


// Draw block as Polyline (LineString again)
document.getElementById('btn-bldg-polyline').addEventListener('click', () => {
  currentDrawRole = 'block';
  draw.changeMode('draw_line_string');
  console.log('[Form IO] Drawing mode: block polyline');
});

// Draw block as Polygon
document.getElementById('btn-bldg-polygon').addEventListener('click', () => {
  currentDrawRole = 'block';
  draw.changeMode('draw_polygon');
  console.log('[Form IO] Drawing mode: Envelope');
});



// Delete block features (basic version)
document.getElementById('btn-bldg-delete').addEventListener('click', () => {
  const selected = draw.getSelectedIds();
  if (selected.length > 0) {
    draw.delete(selected);
    console.warn('[Form IO] Block geometry deleted');
  } else {
    showToast('delete-block-failed', 'No block selected for deletion', 'warning', 2000);
  }
});



  map.on('load', () => {



    // Site layer and polygon
    if (DJ_SITE_BOUNDS?.features?.length) {
      const siteFeature = DJ_SITE_BOUNDS.features[0];
      siteFeature.properties = { role: 'site' };

      map.addSource('site', {
        type: 'geojson',
        data: DJ_SITE_BOUNDS
      });

      map.addLayer({
        id: 'site-boundary',
        type: 'fill',
        source: 'site',
        paint: {
          'fill-color': '#3b82f6',
          'fill-opacity': 0
        } 
      });

      // const addedSite = draw.add(siteFeature);
      // sitePolygonId = addedSite[0];
    }

    // Envelope layer and polygon
    const EnvelopeFeature = siteenvelopeToGeoJSON(DJ_SITE_ENVELOPE);
    if (EnvelopeFeature) {
      EnvelopeFeature.properties = { role: 'Envelope' };

      map.addSource('Envelope', {
        type: 'geojson',
        data: EnvelopeFeature
      });

      map.addLayer({
        id: 'Envelope-boundary',
        type: 'fill',
        source: 'Envelope',
        paint: {
          'fill-color': '#f97316',
          'fill-opacity': 0
        }
      });

      const addedEnvelope = draw.add(EnvelopeFeature);
      EnvelopePolygonId = addedEnvelope[0];
      clearEnvelopeLabels();
      showSiteEvnelopeDimensions(EnvelopeFeature.geometry);
    }

      if (draw && DJ_BLOCKS_ENVELOPE && Array.isArray(DJ_BLOCKS_ENVELOPE)) {
      DJ_BLOCKS_ENVELOPE.forEach(feature => {
    draw.add({
      type: "Feature",
      geometry: feature.geometry,
      properties: feature.properties || { role: "block" }
    });
  });
  } else {
    console.warn('[Form IO] draw not ready');
  }

  
    // 3D Envelopes
    map.addLayer({
      id: '3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 15,
      paint: {
        'fill-extrusion-color': '#aaa',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': 0.3
      }
    });

    // Hide street labels
    map.getStyle().layers.forEach(layer => {
      if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
        map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    });

    map.fitBounds(siteBounds.bounds, { padding: 0, duration: 0 });
    map.addLayer(customLayer);

  });

map.on('click', (e) => {
  // If neither editing mode is active, prevent lingering selections
  if (!isEnvelopeSelectable && !isBlockSelectable) {
    draw.changeMode('simple_select', { featureIds: [] });
    console.log('[Form IO] Selection cleared on click (no active edit mode)');
  }
});


// Create handler
map.on('draw.create', function (e) {
  const feature = e.features[0];
  if (!feature || !['Polygon', 'LineString'].includes(feature.geometry.type)) return;

  if (!feature.properties) feature.properties = {};
  if (!feature.properties.role) {
    feature.properties.role = currentDrawRole || 'undefined';
  }

  const featureId = feature.id;

  switch (currentDrawRole) {
    case 'Envelope':
      EnvelopePolygonId = featureId;
      updateEnvelopeSource(feature.geometry);
      handlePolygonGeometry(feature.geometry, 'Envelope');
      showPolygonDimensions(feature.geometry, 'Envelope');
      break;

    case 'site':
      sitePolygonId = featureId;
      handlePolygonGeometry(feature.geometry, 'site');
      showPolygonDimensions(feature.geometry, 'site');
      break;

    case 'block':
      console.log('[Form IO] Block geometry created:', feature);

      feature.properties.role = 'block';
      draw.setFeatureProperty(feature.id, 'role', 'block');

      const allBlocks = draw.getAll().features.filter(f => f.properties?.role === 'block');
      const blockFeatures = allBlocks.map(f => ({
        type: "Feature",
        geometry: f.geometry,
        properties: f.properties || {}
      }));

      saveBlocksToProject(blockFeatures);

      if (DJ_SITE_ENVELOPE) {
        const blockStr = formatBlockVertices(blockFeatures, DJ_SITE_ENVELOPE);
        updateInputs({ block_vertices: blockStr });
        compute();
      }

      setTimeout(() => {
        draw.changeMode(feature.geometry.type === 'Polygon' ? 'draw_polygon' : 'draw_line_string');
        console.log('[Form IO] Re-armed draw mode for another block');
      }, 100);
      break;
  }

  currentDrawRole = null;
});


// Update handler
map.on('draw.update', function (e) {
  const feature = e.features[0];
  const role = feature.properties?.role;
  const geometryType = feature.geometry?.type;

  if (!feature || !geometryType || !role) return;

  if (role === 'Envelope' && geometryType === 'Polygon') {
    updateEnvelopeSource(feature.geometry);
    handlePolygonGeometry(feature.geometry, role);
    showPolygonDimensions(feature.geometry, role);
  }

  else if (role === 'site' && geometryType === 'Polygon') {
    handlePolygonGeometry(feature.geometry, role);
    showPolygonDimensions(feature.geometry, role);
  }

  else if (role === 'block' && ['Polygon', 'LineString'].includes(geometryType)) {
    console.log('[Form IO] Block geometry updated:', feature);

    const allBlocks = draw.getAll().features.filter(f => f.properties?.role === 'block');
    const blockFeatures = allBlocks.map(f => ({
      type: "Feature",
      geometry: f.geometry,
      properties: f.properties || {}
    }));

    saveBlocksToProject(blockFeatures);

    if (DJ_SITE_ENVELOPE) {
      const blockStr = formatBlockVertices(blockFeatures, DJ_SITE_ENVELOPE);
      updateInputs({ block_vertices: blockStr });
      compute();
    }

    if (geometryType === 'Polygon') {
      showPolygonDimensions(feature.geometry, role);
    }
  }

  else {
    console.warn('[Form IO] Unhandled update:', role, geometryType);
  }
});



// Delete handler
map.on('draw.delete', function (e) {
  e.features.forEach(f => {
    const role = f.properties?.role;

    if (f.id === sitePolygonId && role === 'site') {
      sitePolygonId = null;
      clearMapLabels('site');
      console.warn('[Form IO] Site Bounds deleted');
    } else if (f.id === EnvelopePolygonId && role === 'Envelope') {
      EnvelopePolygonId = null;
      clearMapLabels('Envelope');
      console.warn('[Form IO] site_envelope deleted');
    }
    if (role === 'block') {
      const remainingBlocks = draw.getAll().features.filter(f => f.properties?.role === 'block');
      const features = remainingBlocks.map(f => ({
        type: "Feature",
        geometry: f.geometry,
        properties: f.properties || {}
      }));
      saveBlocksToProject(features); // ✅ correctly sends full Feature objects
    }

  });
});


  // Helper: update Envelope geojson source
  function updateEnvelopeSource(geometry) {
    const updatedFeature = {
      type: "Feature",
      geometry: geometry,
      properties: { role: "Envelope" }
    };
    const updatedGeojson = {
      type: "FeatureCollection",
      features: [updatedFeature]
    };
    const EnvelopeSource = map.getSource('Envelope');
    if (EnvelopeSource) {
      EnvelopeSource.setData(updatedGeojson);
    }
  }

map.on('draw.selectionchange', (e) => {
  const selected = e.features?.[0];

  if (!selected || !selected.id) {
    console.warn('[Form IO] Selection change triggered but no valid feature was selected.');
    return;
  }

  // Ensure properties object exists
  if (!selected.properties) {
    selected.properties = {};
  }

  // Assign role if missing and currentDrawRole is active
  if (!selected.properties.role && currentDrawRole) {
    selected.properties.role = currentDrawRole;
    draw.setFeatureProperty(selected.id, 'role', currentDrawRole);
  }

  // Envelope selection logic
  if (selected.properties.role === 'Envelope') {
    if (!isEnvelopeSelectable) {
      draw.changeMode('simple_select', { featureIds: [] });
      console.log('[Form IO] Envelope selection blocked');
      return;
    }

    const featureId = selected.id;
    setTimeout(() => {
      draw.changeMode('direct_select', { featureId });
      console.log('[Form IO] Switched to direct_select for Envelope');
    }, 0);
    return;
  }

  // Block selection logic
  if (selected.properties.role === 'block') {
    if (!isBlockSelectable) {
      draw.changeMode('simple_select', { featureIds: [] });
      console.log('[Form IO] Block selection blocked');
      return;
    }

    const featureId = selected.id;
    setTimeout(() => {
      draw.changeMode('direct_select', { featureId });
      console.log(`[Form IO] Block selected with ID: ${featureId}`);
    }, 0);
    return;
  }

  // Default case — unknown or unhandled role
  draw.changeMode('simple_select', { featureIds: [] });
  console.log('[Form IO] Selection cleared — invalid or unsupported role');
});






}



const customLayer = {
  id: 'rhino-layer',
  type: 'custom',
  renderingMode: '3d',
  onAdd: async function (_map, gl) {
    threeCamera = new THREE.Camera()
    threeScene = new THREE.Scene()

    threeRenderer = new THREE.WebGLRenderer({
      canvas: _map.getCanvas(),
      context: gl,
      antialias: true
    })
    threeRenderer.autoClear = false

    // ✅ Wait for input UI to be ready before computing
    await fetchGrasshopperInputs(data.definition);
    registerInputListeners(); // Attach events to newly created input elements
    preloadInputs(PROJECT_INPUTS); // Optional: load saved input values if available
    compute(); // Now inputs are ready and UI is populated
  },

  render: function (gl, matrix) {
    const m = new THREE.Matrix4().fromArray(matrix);

    // --- Origin from project polyline
    const originX = DJ_SITE_ENVELOPE?.origin?.x || 0;
    const originY = DJ_SITE_ENVELOPE?.origin?.y || 0;
    const mercOrigin = new mapboxgl.MercatorCoordinate(originX, originY);
    const originLngLat = mercOrigin.toLngLat();

    // --- Accurate Mercator scaling per meter
    const mercatorPerMeter = getMercatorUnitsPerMeterAtOrigin(originLngLat);
    const scale = new THREE.Matrix4().makeScale(mercatorPerMeter, mercatorPerMeter, mercatorPerMeter);

    // --- Rotation around Z-axis from polyline direction
    let rotationZ = 0;
    const points = DJ_SITE_ENVELOPE?.points;
    if (points?.length >= 2) {
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      rotationZ = Math.atan2(dy, dx);
    }

    // Rotation around Z (geometry lies in XY plane), and flip Z axis for Y-up to Z-up
    const rotateZ = new THREE.Matrix4().makeRotationZ(Math.PI*2);
    const rotateX = new THREE.Matrix4().makeRotationX(Math.PI); // Flip vertical orientation (Z-up)
    const flipY = new THREE.Matrix4().makeScale(1, 1, -1);       // Flip Y if required

    // --- Translation
    const translation = new THREE.Matrix4().makeTranslation(originX, originY, 0);

    // --- Final transformation matrix
    const modelTransform = new THREE.Matrix4()
      .multiply(translation)
      .multiply(rotateZ)
      .multiply(rotateX)
      .multiply(flipY)
      .multiply(scale);

    // --- Set the final camera matrix
    threeCamera.projectionMatrix = m.clone().multiply(modelTransform);

    threeRenderer.state.reset();
    threeRenderer.render(threeScene, threeCamera);
    map.triggerRepaint();
  }

}


function siteenvelopeToGeoJSON(path) {
  if (!path || !path.origin || !Array.isArray(path.points)) return null;

  const coords = path.points.map(p => [p.x + path.origin.x, p.y + path.origin.y]);

  // Ensure closed polygon
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);

  // Convert Mercator to LngLat
  const lngLatCoords = coords.map(pair => {
    const merc = new mapboxgl.MercatorCoordinate(pair[0], pair[1]);
    const { lng, lat } = merc.toLngLat();
    return [lng, lat];
  });


  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [lngLatCoords]
    }
  };
}


function saveSiteGeometry(geometry) {
  if (!PROJECT_ID) return;

  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: geometry,
        properties: {}
      }
    ]
  };

  const payload = {
    inputs: getInputs(),  // keep if needed
    site_bounds: geojson
  };

  fetch(`/api/projects/${PROJECT_ID}/save/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': getCSRFToken()
    },
    body: JSON.stringify(payload)
  }).then(res => {
    if (!res.ok) throw new Error('Site geometry save failed');
    console.log('[Form IO] Site Bounds updated successfully');
  }).catch(err => {
    console.error('[Form IO] Failed to save Site Bounds:', err);
  });
}



/**
 * Saves the site envelope to the backend.
 * Once the envelope is saved, refreshes the project polyline and re-fetches inputs.
 * This ensures inputs are always based on the latest geometry.
 */
/**
 * Save only the site_envelope field to the backend.
 * Does not modify or include `inputs` like envelope_origin or envelope_vertices.
 * 
 * @param {Object|string} SiteEvnelope - The site envelope object to save, or '' to clear it.
 */
async function saveSiteEvnelope(SiteEvnelope) {
  if (!PROJECT_ID) return;

  const payload = {
    site_envelope: SiteEvnelope || ''
  };

  try {
    const res = await fetch(`/api/projects/${PROJECT_ID}/save/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': getCSRFToken()
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Save failed');

    DJ_SITE_ENVELOPE = null;
    console.log('[Form IO] site_envelope saved successfully and local cache reset.');
  } catch (err) {
    console.error('[Form IO] Failed to save site_envelope:', err);
  }
}






function getPaddedBounds(bounds, paddingDegrees = 0.0006) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const paddedSw = new mapboxgl.LngLat(sw.lng - paddingDegrees, sw.lat - paddingDegrees);
  const paddedNe = new mapboxgl.LngLat(ne.lng + paddingDegrees, ne.lat + paddingDegrees);

  return new mapboxgl.LngLatBounds(paddedSw, paddedNe);
}

function getBoundsFromSiteGeometry(geojson) {
  const bbox = turf.bbox(geojson); // [minX, minY, maxX, maxY]

  // Get original bounds and center
  const sw = new mapboxgl.LngLat(bbox[0], bbox[1]);
  const ne = new mapboxgl.LngLat(bbox[2], bbox[3]);
  const bounds = new mapboxgl.LngLatBounds(sw, ne);
  const center = bounds.getCenter();

  // Compute half-widths
  const lngSpan = (ne.lng - sw.lng) / 2;
  const latSpan = (ne.lat - sw.lat) / 2;

  // Expand outward from center (2x scale)
  const scaledSW = new mapboxgl.LngLat(center.lng - lngSpan, center.lat - latSpan);
  const scaledNE = new mapboxgl.LngLat(center.lng + lngSpan, center.lat + latSpan);

  const scaledBounds = new mapboxgl.LngLatBounds(scaledSW, scaledNE);
  return {
    bounds: scaledBounds,
    center: [center.lng, center.lat]
  };
}



function getCSRFToken() {
  const name = 'csrftoken'
  const cookieValue = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)')
  return cookieValue ? cookieValue.pop() : ''
}


// Loader messages and logic
let loaderInterval;
const loaderMessages = ["Talking to OpenAI...", "Analyzing prompt", "Loading model"];
let currentLoaderIndex = 0;

function showLoader() {
    const loader = document.getElementById('loader');
    loader.style.display = 'block';
    loader.textContent = loaderMessages[currentLoaderIndex]; // Set initial message
    loaderInterval = setInterval(() => {
        currentLoaderIndex = (currentLoaderIndex + 1) % loaderMessages.length;
        loader.textContent = loaderMessages[currentLoaderIndex]; // Cycle through messages
    }, 1000); // Change message every 1 second
}

function hideLoader() {
    const loader = document.getElementById('loader');
    loader.style.display = 'none';
    clearInterval(loaderInterval);
    currentLoaderIndex = 0; // Reset index
}

function updateInputs(parameters) {
  Object.keys(parameters).forEach(key => {
    const inputElement = document.getElementById(key);
    if (inputElement) {
      inputElement.value = parameters[key];
    }

  });

  onSliderChange(); // Triggers recompute
}


    document.getElementById('send_prompt').addEventListener('click', async () => {
        const chatbox = document.getElementById('chatbox');
        const prompt = chatbox.value.trim();
        if (!prompt) return; // Prevent empty submissions
        // Add user prompt as chat-start bubble
        addChatMessage(prompt, false);
        // Clear the textarea
        chatbox.value = '';
        // Show the loader
        showLoader();
        try {
            const csrfToken = getCSRFToken(); // Ensure you have the CSRF token logic
            const response = await fetch('/api/openai/chat/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                },
                body: JSON.stringify({ prompt })
            });
            if (response.ok) {
                const data = await response.json();
                // Debugging: Check the received data in the console
                console.log("Response JSON:", data);
                console.log("Response Reasoning:", data.parameters.reasoning);
                console.log("Response Parameters:", data.parameters.parameters);
                // Check and add reasoning from the response as chat-end bubble
                if (data.parameters.reasoning) {
                    addChatMessage(data.parameters.reasoning, true);
                } else {
                    addChatMessage('Error: No reasoning found in the response.', true);
                }
                // Call updateInputs to update form fields with parameters from the response
                if (data.parameters) {
                    updateInputs(data.parameters.parameters);
                }
            } else {
                addChatMessage('Error: Unable to process the prompt.', true);
            }
        } catch (error) {
            console.error('Error during fetch:', error);
            addChatMessage('Error: Unable to reach the server.', true);
        } finally {
            // Hide the loader
            hideLoader();
        }
    });

// Function to append a chat message dynamically
function addChatMessage(message, isResponse = false) {
    const chatMessages = document.getElementById('chat-messages');
    // Create chat container
    const chat = document.createElement('div');
    chat.className = `chat ${isResponse ? 'chat-start' : 'chat-end'}`;
    // Create chat bubble
    const chatBubble = document.createElement('div');
    chatBubble.className = 'chat-bubble';
    chatBubble.innerHTML = message;
    // Append bubble to chat and chat to chat messages container
    chat.appendChild(chatBubble);
    chatMessages.appendChild(chat);
    // Scroll to the bottom of the chat box
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// Preload input values on page load
function preloadInputs(savedInputs) {
  if (!savedInputs || typeof savedInputs !== 'object') return;

  Object.entries(savedInputs).forEach(([key, value]) => {
    const element = document.getElementById(key);
    if (!element) return;

    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
  });

  console.log('[Form IO] Preloaded saved inputs for project:', PROJECT_ID);
}

async function saveInputsToProject(inputs) {
  if (!PROJECT_ID) return;

  try {
    await fetch(`/api/projects/${PROJECT_ID}/save/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': getCSRFToken(),
      },
      body: JSON.stringify({ inputs }),  // ✅ Correct structure
    });
    console.log('[Form IO] Inputs saved successfully for project:', PROJECT_ID);
  } catch (error) {
    console.warn('[Form IO] Failed to save inputs:', error);
  }
}


function onSliderChange() {
  console.log('[Form IO] Slider/input changed – recomputing...');
  compute();
  saveInputsToProject(getInputs());
  console.log('[Form IO] Inputs saved after slider change');
}

// Dynamically attach events to all inputs in overlay
function registerInputListeners() {
  document
    .querySelectorAll('#customise-inputs input, #customise-inputs textarea, #customise-inputs select')
    .forEach(input => {
      input.addEventListener('input', onSliderChange, false);
      input.addEventListener('change', onSliderChange, false);
      input.addEventListener('mouseup', onSliderChange, false);
      input.addEventListener('touchend', onSliderChange, false);
    });
}



async function fetchGrasshopperInputs(definitionFile) {
  try {
    console.log("definition",definitionFile)
    const response = await fetch(`/api/rhino/params/?file=${encodeURIComponent(definitionFile)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch inputs: ${response.statusText}`);
    }
    const data = await response.json();
    console.log("inputs",data)
    // Extract the parameter names from response (assuming same schema as Rhino Compute)
    const inputs = extractInputsFromGrasshopperData(data);
    populateInputsUI(inputs);

  } catch (error) {
    console.error("Error fetching GH params:", error);
  }
}

function extractInputsFromGrasshopperData(data) {
  const inputs = [];

  if (data && Array.isArray(data.InputNames) && Array.isArray(data.Inputs)) {
    for (let i = 0; i < data.InputNames.length; i++) {
      const inputName = data.InputNames[i];
      const inputMeta = data.Inputs[i];

      let defaultValue = 0;
      if (
        inputMeta &&
        inputMeta.Default &&
        inputMeta.Default.InnerTree &&
        inputMeta.Default.InnerTree["{0}"] &&
        inputMeta.Default.InnerTree["{0}"][0]
      ) {
        defaultValue = inputMeta.Default.InnerTree["{0}"][0].data;
      }

      // Force known system-generated fields as text
      let type = "number";
      if (["envelope_origin", "envelope_vertices","block_vertices"].includes(inputName)) {
        type = "text";
      } else {
        const paramType = inputMeta?.ParamType?.toLowerCase();
        if (paramType === "boolean") {
          type = "checkbox";
        } else if (paramType === "string") {
          type = "text";
        }
      }

      inputs.push({
        name: inputName,
        default: defaultValue,
        type: type
      });
    }
  }

  return inputs;
}


/**
 * Dynamically generates the input UI form in the overlay panel.
 * Supports number, checkbox, and text types (e.g. string parameters like envelope_vertices).
 *
 * @param {Array} inputs - Array of input objects with { name, default, type }
 */
function populateInputsUI(inputs) {
  const customiseContainer = document.getElementById('customise-inputs');
  customiseContainer.innerHTML = ''; // Clear previous inputs

  inputs.forEach(input => {
    const control = document.createElement('div');
    control.classList.add('form-control', 'text-xs'); // smaller text

    const label = document.createElement('label');
    label.classList.add('label', 'text-xs', 'font-medium', 'text-gray-500');
    label.textContent = input.name;

    let inputField;

    if (input.type === 'text' && typeof input.default === 'string' ) {
      inputField = document.createElement('textarea');
      inputField.rows = 2;
      inputField.classList.add('textarea', 'textarea-bordered', 'textarea-xs');
      inputField.readOnly = true;
    } else {
      inputField = document.createElement('input');
      inputField.type = input.type;
      inputField.classList.add('input', 'input-bordered', 'input-xs');
      if (input.type === 'text') {
        inputField.readOnly = true;
        inputField.style.display = 'none';
      }
    }

    inputField.id = input.name;
    inputField.name = input.name;
    inputField.value = input.default;

    control.appendChild(label);
    control.appendChild(inputField);
    customiseContainer.appendChild(control);
  });

  registerInputListeners();
}




document.addEventListener('DOMContentLoaded', async () => {
  preloadInputs(PROJECT_INPUTS);  // okay if these exist
  registerInputListeners();       // not harmful, but won't bind to anything yet

  // ✅ Load GH UI and compute when ready
  await fetchGrasshopperInputs(data.definition);
});

let labelMarkers = [];

function styleLabel(el) {
  el.style.padding = '2px 6px';
  el.style.background = 'white';
  el.style.borderRadius = '4px';
  el.style.fontSize = '12px';
  el.style.border = '1px solid #ccc';
  el.style.boxShadow = '0 0 2px rgba(0, 0, 0, 0.2)';
  el.style.pointerEvents = 'none';
}


function clearEnvelopeLabels() {
  EnvelopeLabelMarkers.forEach(m => m.remove());
  EnvelopeLabelMarkers = [];
}

function showSiteEvnelopeDimensions(geometry) {
  if (!geometry || geometry.type !== 'Polygon') return;

  clearEnvelopeLabels();

  const coords = geometry.coordinates[0];
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];

    const dist = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

    const el = document.createElement('div');
    el.innerText = `${dist.toFixed(1)} m`;
    styleLabel(el);

    const marker = new mapboxgl.Marker(el)
      .setLngLat(mid)
      .addTo(map);

    EnvelopeLabelMarkers.push(marker);
  }

  // Set Envelope area in UI
  const area = turf.area(geometry);
  const areaText = area > 10000
    ? `${(area / 10000).toFixed(2)} ha`
    : `${area.toFixed(1)} m²`;

  const EnvelopeLabelEl = document.getElementById('Envelope-area-label');
  if (EnvelopeLabelEl) {
    EnvelopeLabelEl.innerText = `Envelope Area: ${areaText}`;
  }
}



/**
 * Converts site_envelope points to relative distances using Turf.js, with the first point as origin.
 * Returns a semicolon-separated string of "x,y,z" in meters.
 * 
 * @param {Object} path - The site_envelope object with 'origin' and 'points' in Mercator meters.
 * @returns {string} - A string with each point as "x,y,z" in meters, separated by semicolons.
 */
function formatSiteEvnelopeWithTurfDistances(path) {
  if (!path || !Array.isArray(path.points) || path.points.length === 0) {
    console.warn("Invalid site_envelope.");
    return '';
  }

  // Compute absolute origin coordinate
  const absOriginX = path.points[0].x + path.origin.x;
  const absOriginY = path.points[0].y + path.origin.y;

  const originLngLat = new mapboxgl.MercatorCoordinate(absOriginX, absOriginY).toLngLat();
  const originPoint = [originLngLat.lng, originLngLat.lat];

  const result = path.points.map(pt => {
    const absX = pt.x + path.origin.x;
    const absY = pt.y + path.origin.y;

    const lngLat = new mapboxgl.MercatorCoordinate(absX, absY).toLngLat();
    const currentPoint = [lngLat.lng, lngLat.lat];

    const eastRef = [currentPoint[0], originPoint[1]];
    const xDist = turf.distance(originPoint, eastRef, { units: 'meters' });
    const x = currentPoint[0] >= originPoint[0] ? xDist : -xDist;

    const northRef = [originPoint[0], currentPoint[1]];
    const yDist = turf.distance(originPoint, northRef, { units: 'meters' });
    const y = currentPoint[1] >= originPoint[1] ? yDist : -yDist;

    const z = (pt.z || 0) - (path.points[0].z || 0);

    return `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  }).join(';');

  console.log('[Form IO] Turf-based relative site_envelope string:', result);
  return result;
}


/**
 * Converts site GeoJSON polygon to a semicolon-separated "x,y,z" string in meters,
 * relative to the first vertex (used as origin).
 *
 * @param {Object} siteGeoJSON - GeoJSON FeatureCollection with one Polygon feature.
 * @returns {string} - String of "x,y,z" coordinate entries separated by semicolons.
 */
function formatSiteBoundaryWithTurfDistances(siteGeoJSON) {
  if (
    !siteGeoJSON ||
    siteGeoJSON.type !== 'FeatureCollection' ||
    !Array.isArray(siteGeoJSON.features) ||
    siteGeoJSON.features.length === 0
  ) {
    console.warn("Invalid or missing site GeoJSON.");
    return '';
  }

  const polygon = siteGeoJSON.features[0].geometry;
  if (!polygon || polygon.type !== 'Polygon') {
    console.warn("Site geometry is not a polygon.");
    return '';
  }

  const coords = polygon.coordinates[0];
  if (!coords || coords.length < 3) {
    console.warn("Site polygon has too few coordinates.");
    return '';
  }

  const originLngLat = coords[0];

  const result = coords.map(pt => {
    const eastRef = [pt[0], originLngLat[1]];
    const xDist = turf.distance(originLngLat, eastRef, { units: 'meters' });
    const x = pt[0] >= originLngLat[0] ? xDist : -xDist;

    const northRef = [originLngLat[0], pt[1]];
    const yDist = turf.distance(originLngLat, northRef, { units: 'meters' });
    const y = pt[1] >= originLngLat[1] ? yDist : -yDist;

    return `${x.toFixed(3)},${y.toFixed(3)},0.000`; // z=0 for flat 2D site
  }).join(';');

  return result;
}

function showToast(id, message, type = 'info', duration) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Prevent duplicate toasts with the same ID
  if (document.getElementById(id)) return;

  console.log(`[Form IO] Toast shown: ${id} - ${message}`);

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `alert alert-${type}`;
  toast.id = id;
  toast.innerHTML = `<span>${message}</span>`;

  // Append the toast to the container
  container.appendChild(toast);

  // If duration is provided, automatically remove the toast after specified time
  if (typeof duration === 'number') {
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
        console.log(`[Form IO] Toast removed: ${id}`);
      }
    }, duration);
  }
}
/**
 * Removes a toast by its unique ID.
 * @param {string} id - The toast ID to remove.
 */
function removeToast(id) {
  const toast = document.getElementById(id);
  if (toast) toast.remove();
}

async function refreshProjectPolyline() {
  try {
    const res = await fetch(`/api/projects/${PROJECT_ID}/get_polyline/`);
    if (!res.ok) throw new Error('Fetch failed');
    const json = await res.json();
    DJ_SITE_ENVELOPE = json.DJ_SITE_ENVELOPE;
    console.log('[Form IO] DJ_SITE_ENVELOPE refreshed from backend');
  } catch (e) {
    console.error('Failed to refresh polyline:', e);
  }
}

async function refreshProjectBlocksAndEnvelope() {
  try {
    const res = await fetch(`/api/projects/${PROJECT_ID}/get_polyline/`);
    if (!res.ok) throw new Error('Fetch failed');
    const json = await res.json();

    DJ_SITE_ENVELOPE = json.DJ_SITE_ENVELOPE;
    DJ_BLOCKS_ENVELOPE = json.DJ_BLOCKS_ENVELOPE || [];
    console.log('[Form IO] DJ_SITE_ENVELOPE and DJ_BLOCKS_ENVELOPE refreshed from backend');
    // Optional: redraw blocks on map
    if (Array.isArray(DJ_BLOCKS_ENVELOPE)) {
      clearBlocksFromMap();
      DJ_BLOCKS_ENVELOPE.forEach(geometry => {
        draw.add({
          type: "Feature",
          geometry: geometry,
          properties: { role: "block" }
        });
      });

    }

    console.log('[Form IO] Blocks and Envelope refreshed from backend');
  } catch (e) {
    console.error('Failed to refresh polyline or blocks:', e);
  }
}


async function handlePolygonGeometry(geometry, role) {
  const coords = geometry.coordinates[0];
  const originLngLat = coords[0];

  const origin = mapboxgl.MercatorCoordinate.fromLngLat({
    lng: originLngLat[0],
    lat: originLngLat[1]
  });

  const points = coords.map(([lng, lat]) => {
    const point = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat });
    return {
      x: point.x - origin.x,
      y: point.y - origin.y,
      z: 0
    };
  });

  const relativePath = {
    origin: { x: origin.x, y: origin.y, z: 0 },
    points: points
  };

  if (role === 'Envelope') {
    await saveSiteEvnelope(relativePath);
    await refreshProjectBlocksAndEnvelope();

    if (!DJ_SITE_ENVELOPE || !Array.isArray(DJ_SITE_ENVELOPE.points)) {
      console.warn('[Form IO] DJ_SITE_ENVELOPE not ready after refresh');
      return;
    }

    const formatted = formatSiteEvnelopeWithTurfDistances(DJ_SITE_ENVELOPE);
    updateInputs({ envelope_vertices: formatted });
    compute();
  }

  // ✅ NEW BLOCK HANDLING
  else if (role === 'block') {
    // Save all block geometries
    const allBlocks = draw.getAll().features.filter(f => f.properties?.role === 'block');
    const blockFeatures = allBlocks.map(f => ({
      type: "Feature",
      geometry: f.geometry,
      properties: f.properties || {}
    }));

    await saveBlocksToProject(blockFeatures);

    // Format input string
    const formatted = formatBlockVertices(blockFeatures, DJ_SITE_ENVELOPE);
    updateInputs({ block_vertices: formatted });

    // Trigger recompute
    compute();
  }

  else if (role === 'site') {
    saveSiteGeometry(geometry);
  }
}




function clearMapLabels(role) {
  const markerArray = role === 'site' ? siteLabelMarkers : EnvelopeLabelMarkers;
  markerArray.forEach(m => m.remove());

  if (role === 'site') {
    siteLabelMarkers = [];
  } else {
    EnvelopeLabelMarkers = [];
  }
}

function showPolygonDimensions(geometry, role) {
  if (!geometry || geometry.type !== 'Polygon') return;

  clearMapLabels(role);

  const coords = geometry.coordinates[0];
  const labelMarkers = [];

  coords.slice(0, -1).forEach((p1, i) => {
    const p2 = coords[i + 1];
    const dist = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

    const el = document.createElement('div');
    el.innerText = `${dist.toFixed(1)} m`;
    styleLabel(el);

    const marker = new mapboxgl.Marker(el).setLngLat(mid).addTo(map);
    labelMarkers.push(marker);
  });

  const area = turf.area(geometry);
  const areaText = area > 10000 ? `${(area / 10000).toFixed(2)} ha` : `${area.toFixed(1)} m²`;
  const labelId = role === 'site' ? 'site-area-label' : 'Envelope-area-label';
  const labelEl = document.getElementById(labelId);
  if (labelEl) labelEl.innerText = `${role === 'site' ? 'Site' : 'Envelope'} Area: ${areaText}`;

  if (role === 'site') {
    siteLabelMarkers = labelMarkers;
  } else {
    EnvelopeLabelMarkers = labelMarkers;
  }
}

async function saveBlocksToProject(blockFeatures) {
  if (!PROJECT_ID) return;
  console.log('[Form IO] logging blockFeatures:', blockFeatures);

  try {
    await fetch(`/api/projects/${PROJECT_ID}/save/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': getCSRFToken()
      },
      body: JSON.stringify({ blocks_envelope: blockFeatures }) // ❌ Error: blockFeatures is not defined
    });

    console.log('[Form IO] Blocks saved successfully to project');
  } catch (err) {
    console.error('[Form IO] Failed to save blocks:', err);
  }
}

function clearBlocksFromMap() {
  if (!draw) {
    console.warn('[Form IO] draw is not initialized yet. Skipping clearBlocksFromMap().');
    return;
  }

  const blockIds = draw.getAll().features
    .filter(f => f.properties?.role === 'block')
    .map(f => f.id);

  if (blockIds.length) {
    draw.delete(blockIds);
  }
}


function drawBlocksFromBackend() {
  console.log('[Form IO] drawBlocksFromBackend called', DJ_BLOCKS_ENVELOPE);






  console.log('[Form IO] Re-rendered blocks from DJ_BLOCKS_ENVELOPE context');
}



function formatBlockVertices(blocks, envelopePath) {
  if (
    !envelopePath ||
    !envelopePath.origin ||
    !Array.isArray(envelopePath.points) ||
    envelopePath.points.length === 0
  ) {
    console.warn("Invalid envelope path for block formatting.");
    return '';
  }

  // Compute absolute origin in Mercator
  const absOriginX = envelopePath.points[0].x + envelopePath.origin.x;
  const absOriginY = envelopePath.points[0].y + envelopePath.origin.y;

  // Convert absolute Mercator to LngLat
  const originLngLat = new mapboxgl.MercatorCoordinate(absOriginX, absOriginY).toLngLat();
  const originPoint = [originLngLat.lng, originLngLat.lat];

  // Process each block
  const formattedBlocks = blocks.map(feature => {
    const geometry = feature.geometry;
    const coords = geometry.type === 'Polygon'
      ? geometry.coordinates[0]
      : geometry.coordinates;

    const relativePoints = coords.map(([lng, lat]) => {
      const currentPoint = [lng, lat];

      const eastRef = [currentPoint[0], originPoint[1]];
      const xDist = turf.distance(originPoint, eastRef, { units: 'meters' });
      const x = currentPoint[0] >= originPoint[0] ? xDist : -xDist;

      const northRef = [originPoint[0], currentPoint[1]];
      const yDist = turf.distance(originPoint, northRef, { units: 'meters' });
      const y = currentPoint[1] >= originPoint[1] ? yDist : -yDist;

      return `${x.toFixed(3)},${y.toFixed(3)},0.000`;
    });

    return relativePoints.join(';');
  });

  return formattedBlocks.join('/');
}


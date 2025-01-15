import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { Rhino3dmLoader } from 'three/examples/jsm/loaders/3DMLoader'
import rhino3dm from 'rhino3dm'

/* eslint no-undef: "off", no-unused-vars: "off" */

const loader = new Rhino3dmLoader()
loader.setLibraryPath( 'https://unpkg.com/rhino3dm@8.0.0-beta3/' )

const data = {
  definition: 'form_io_main_002.gh',
  inputs: getInputs()
}


// Setup input change events
const podium_length_input = document.getElementById('podium_length');
podium_length_input.addEventListener('mouseup', onSliderChange, false);
podium_length_input.addEventListener('touchend', onSliderChange, false);

const podium_width_input = document.getElementById('podium_width');
podium_width_input.addEventListener('mouseup', onSliderChange, false);
podium_width_input.addEventListener('touchend', onSliderChange, false);

const podium_no_of_floors_input = document.getElementById('podium_no_of_floors');
podium_no_of_floors_input.addEventListener('mouseup', onSliderChange, false);
podium_no_of_floors_input.addEventListener('touchend', onSliderChange, false);

const floor_height_input = document.getElementById('floor_height');
floor_height_input.addEventListener('mouseup', onSliderChange, false);
floor_height_input.addEventListener('touchend', onSliderChange, false);

const building_type_input = document.getElementById('building_type');
building_type_input.addEventListener('mouseup', onSliderChange, false);
building_type_input.addEventListener('touchend', onSliderChange, false);

const tower_num_floors_input = document.getElementById('tower_num_floors');
tower_num_floors_input.addEventListener('mouseup', onSliderChange, false);
tower_num_floors_input.addEventListener('touchend', onSliderChange, false);

const courtyard_offset_1_input = document.getElementById('courtyard_offset_1');
courtyard_offset_1_input.addEventListener('mouseup', onSliderChange, false);
courtyard_offset_1_input.addEventListener('touchend', onSliderChange, false);

const courtyard_offset_2_input = document.getElementById('courtyard_offset_2');
courtyard_offset_2_input.addEventListener('mouseup', onSliderChange, false);
courtyard_offset_2_input.addEventListener('touchend', onSliderChange, false);

const polyline_offset_input = document.getElementById('polyline_offset');
polyline_offset_input.addEventListener('mouseup', onSliderChange, false);
polyline_offset_input.addEventListener('touchend', onSliderChange, false);

const detail_mode_input = document.getElementById('detail_mode');
detail_mode_input.addEventListener('mouseup', onSliderChange, false);
detail_mode_input.addEventListener('touchend', onSliderChange, false);

// load the rhino3dm library
let doc

const rhino = await rhino3dm()
console.log('Loaded rhino3dm.')

init()
compute()



let _threeMesh, _threeMaterial

function getInputs() {
  const inputs = {
    podium_lenght: Number(document.getElementById('podium_length').value),
    podium_width: Number(document.getElementById('podium_width').value),
    podium_no_of_floors: Number(document.getElementById('podium_no_of_floors').value),
    floor_height: Number(document.getElementById('floor_height').value),
    building_type: Number(document.getElementById('building_type').value),
    tower_num_floors: Number(document.getElementById('tower_num_floors').value),
    courtyard_offset: Number(document.getElementById('courtyard_offset_1').value),
    staggered_offset: Number(document.getElementById('courtyard_offset_2').value),
    polyline_offset: Number(document.getElementById('polyline_offset').value),
    detail_mode:Number(document.getElementById('detail_mode').checked ? '0' : '1')
  };

  return inputs;
}


/**
 * Call appserver
 */
async function compute() {
  if (!scene) {
    console.error("Scene not ready for compute call.");
    return;
  }

  data.inputs = getInputs();

  const url = "/api/rhino/solve/";
  const formData = new FormData();
  formData.append("grasshopper_file_name", data.definition);
  formData.append("input_data", JSON.stringify(data.inputs));

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData,
      headers: {
        "X-CSRFToken": getCSRFToken(),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const responseJson = await response.json();


    console.log(responseJson);
    collectResults(responseJson);
  } catch (error) {
    console.error("Error during compute:", error);
    alert("Failed to process the request. Check the backend or network.");
    showSpinner(false);
  }
}


/**
 * Parse response
 */
function meshToThreejs(mesh) {
  let loader = new THREE.BufferGeometryLoader();
  let geometry = loader.parse(mesh.toThreejsJSON());

  // Create a material that uses vertex colors
  let material = new THREE.MeshBasicMaterial({
    vertexColors: true, // Enable vertex colors
    side: THREE.DoubleSide, // Double-sided rendering
    transparent: true,
    opacity: 0.5 // Adjust opacity as needed
  });
  return new THREE.Mesh(geometry, material);
}

// Store meshes separately to avoid conflicts
let meshb64Mesh, meshoutMesh, panelText;

// Modify replaceCurrentMesh to handle each mesh type independently
function replaceCurrentMesh(threeMesh, type) {
  // Remove the existing mesh of the specified type
  if (type === "meshb64" && meshb64Mesh) {
    scene.remove(meshb64Mesh);
    meshb64Mesh.geometry.dispose();
    meshb64Mesh.material.dispose();
    meshb64Mesh = null;
  } else if (type === "meshout" && meshoutMesh) {
    scene.remove(meshoutMesh);
    meshoutMesh.geometry.dispose();
    meshoutMesh.material.dispose();
    meshoutMesh = null;
  }
  // Add the new mesh to the scene and assign it to the corresponding variable
  if (type === "meshb64") {
    meshb64Mesh = threeMesh;
    meshb64Mesh.geometry.rotateX(Math.PI); 
    scene.add(meshb64Mesh);
  } else if (type === "meshout") {
    meshoutMesh = threeMesh;
    scene.add(meshoutMesh);
  }
  // remove all lines from the scene
  scene.children.forEach(child => {
    if (child.type === "Line") {
      scene.remove(child);
    }
  });
}

function zoomCameraToSelection(camera, controls, selection, fitOffset = 1.2) {
  const box = new THREE.Box3();

  // Calculate the bounding box for the entire selection
  selection.forEach(object => {
    if (!object.isLight) box.expandByObject(object);
  });

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = fitOffset * maxDim;

  // Check if the camera position and controls target are already set
  if (camera.position.length() > 0 && controls.target.length() > 0) {
    return; // Exit early if the camera position and target are already set
  }

  // Set the camera to a northeast view (e.g., [1, 1, 1] direction) if not already set
  camera.position.set(center.x + distance, center.y + distance, center.z + distance);
  controls.target.copy(center);

  // Adjust orthographic frustum based on model size
  const aspect = window.innerWidth / window.innerHeight;
  const frustumSize = maxDim * fitOffset;

  camera.left = (-frustumSize * aspect) / 2;
  camera.right = (frustumSize * aspect) / 2;
  camera.top = frustumSize / 2;
  camera.bottom = -frustumSize / 2;

  // Ensure near and far planes cover the model depth
  camera.near = 0.1;
  camera.far = distance * 10; // Increase for larger models
  camera.updateProjectionMatrix();

  // Update the controls for the new camera position and target
  controls.update();
}

function collectResults(responseJson) {
  const values = responseJson.values;
  console.log(values);

  if (doc !== undefined) doc.delete();
  doc = new rhino.File3dm();


  // Handle mesh outputs (if necessary)
  for (let i = 0; i < values.length; i++) {
    const output = values[i];

    if (output.ParamName === "RH_OUT:meshb64") {
      for (const path in output.InnerTree) {
        const branch = output.InnerTree[path];
        for (let j = 0; j < branch.length; j++) {
          const rhinoObject = decodeItem(branch[j]);
          if (rhinoObject) {
            const threeMesh = meshToThreejs(rhinoObject);
            replaceCurrentMesh(threeMesh, "meshb64");
            threeMesh.geometry.rotateX(-Math.PI / 2);
            doc.objects().add(rhinoObject, null);
          }
        }
      }
    }

    if (output.ParamName === "RH_OUT:meshout") {
      for (const path in output.InnerTree) {
        const branch = output.InnerTree[path];
        for (let j = 0; j < branch.length; j++) {
          const rhinoObject = decodeItem(branch[j]);
          if (rhinoObject) {
            const threeMesh = meshToThreejs(rhinoObject);
            replaceCurrentMesh(threeMesh, "meshout");
            threeMesh.geometry.rotateX(-Math.PI / 2);
            doc.objects().add(rhinoObject, null);

            const edges = new THREE.EdgesGeometry(threeMesh.geometry);
            const line = new THREE.LineSegments(
              edges,
              new THREE.LineBasicMaterial({ color: 0xD9D9D9 , linewidth: 3 })
            );
            line.material.depthTest = false;
            line.material.depthWrite = false;
            line.renderOrder = 1; // Prevent visual glitches
            threeMesh.add(line);
          }
        }
      }
    }
  }

  zoomCameraToSelection(camera, controls, scene.children, 1.8);

  if (doc.objects().count < 1) {
    console.error("No rhino objects to load!");
  }

  showSpinner(false);
}


/**
 * Shows or hides the loading spinner
 */
 function showSpinner(enable) {
  if (enable)
    document.getElementById('loader').style.display = 'block'
  else
    document.getElementById('loader').style.display = 'none'
}

/**
 * Attempt to decode data tree item to rhino geometry
 */
 function decodeItem(item) {
  const data = JSON.parse(item.data)
  if (item.type === 'System.String') {
    // hack for draco meshes
    try {
        return rhino.DracoCompression.decompressBase64String(data)
    } catch {} // ignore errors (maybe the string was just a string...)
  } else if (typeof data === 'object') {
    return rhino.CommonObject.decode(data)
  }
  return null
}

/**
 * Called when a slider value changes in the UI. Collect all of the
 * slider values and call compute to solve for a new scene
 */
function onSliderChange () {
  // show spinner
  showSpinner(true)
  compute()
}

// BOILERPLATE //

var scene, camera, renderer, controls

function init () {
  // Rhino models are z-up, so set this as the default
  THREE.Object3D.DefaultUp = new THREE.Vector3(0, 0, 1);

  scene = new THREE.Scene()
  scene.background = new THREE.Color('#eeeeee');

  const aspect = window.innerWidth / window.innerHeight;
  const frustumSize = 2000; // Adjusted for better model fitting

  camera = new THREE.OrthographicCamera(
    (frustumSize * aspect) / -2,
    (frustumSize * aspect) / 2,
    frustumSize / 2,
    frustumSize / -2,
    1,
    2500000  // Far clipping plane adjusted for model depth
  );

  // Position the camera for a better view
  camera.position.set(1000000, 1000000, 1000000); // Adjusted to have a clearer view of the model from an angle
  camera.lookAt(new THREE.Vector3(0, 0, 0)); // Center on the origin

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = true;
  controls.enablePan = true;


  window.addEventListener( 'resize', onWindowResize, false )

  animate()
}

function animate () {
  requestAnimationFrame( animate )
  controls.update()
  renderer.render( scene, camera )
}
  
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize( window.innerWidth, window.innerHeight )
  animate()
}

window.onSliderChange = onSliderChange
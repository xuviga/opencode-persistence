// XuViGaN Persistence Dashboard - Spatial Data Visualization
// Using Three.js for 3D visualization instead of traditional D3 graph

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;
let ws = null;
let scene, camera, renderer, controls;
let nodes = [], links = [];
let threeNodes = new Map(); // Map for 3D nodes
let threeLinks = []; // Array for 3D links

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Load saved theme
    const savedTheme = localStorage.getItem('persistence-theme');
    if (savedTheme === 'cyberpunk') {
        document.getElementById('theme-stylesheet').disabled = false;
    }

    initThreeJS();
    connectWebSocket();
    loadStats();
    initControls();
    initInterfaceSelector();
    initMatrixView();
    initWaveView();
    initCloudView();

    // Handle window resize
    window.addEventListener('resize', () => {
        if (!scene || !camera || !renderer) return;

        const container = document.getElementById('three-container');
        if (!container) return;

        const width = container.clientWidth;
        const height = container.clientHeight;

        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    });
});

// Three.js initialization for 3D visualization
function initThreeJS() {
    const container = document.getElementById('three-container');
    if (!container) {
        console.error('three-container element not found');
        return;
    }

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    try {
        // Create scene
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0a0a12);
        scene.fog = new THREE.FogExp2(0x0a0a12, 0.05);

        // Create camera
        camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        camera.position.z = 50;

        // Create renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(renderer.domElement);

        // Add ambient light
        const ambientLight = new THREE.AmbientLight(0x404040, 2);
        scene.add(ambientLight);

        // Add directional light
        const directionalLight = new THREE.DirectionalLight(0x00f0ff, 1);
        directionalLight.position.set(1, 1, 1);
        scene.add(directionalLight);

        // Add point lights for each color
        const colors = [0x00f0ff, 0x00ff88, 0x8866ff, 0xff3366, 0xffaa00];
        colors.forEach((color, i) => {
            const light = new THREE.PointLight(color, 1, 100);
            light.position.set(
                Math.cos(i * Math.PI * 2 / colors.length) * 30,
                Math.sin(i * Math.PI * 2 / colors.length) * 30,
                0
            );
            scene.add(light);
        });

        // Add particles background
        createParticleBackground();

        // Add controls
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.screenSpacePanning = false;
        controls.minDistance = 10;
        controls.maxDistance = 200;

        // Add fog for depth perception
        scene.fog = new THREE.FogExp2(0x0a0a12, 0.025);

        // Add starfield background
        createStarfield();

        // Add physics simulation for nodes
        initNodePhysics();

        // Animation loop
        animate();
    } catch (e) {
        console.error('Error initializing Three.js:', e);
    }
}

// Node physics simulation
function initNodePhysics() {
    // Create spring physics for nodes
    setInterval(() => {
        threeNodes.forEach((node3d, id) => {
            // Find connected nodes
            const connectedNodes = [];
            links.forEach(link => {
                if (link.source.id === id) {
                    const targetNode = threeNodes.get(link.target.id);
                    if (targetNode) connectedNodes.push(targetNode);
                }
                if (link.target.id === id) {
                    const sourceNode = threeNodes.get(link.source.id);
                    if (sourceNode) connectedNodes.push(sourceNode);
                }
            });

            // Apply spring forces to connected nodes
            connectedNodes.forEach(connectedNode => {
                const distance = node3d.position.distanceTo(connectedNode.position);
                const idealDistance = 20; // Ideal distance between connected nodes

                if (distance > idealDistance) {
                    // Calculate spring force
                    const force = (distance - idealDistance) * 0.01;
                    const direction = new THREE.Vector3()
                        .subVectors(connectedNode.position, node3d.position)
                        .normalize()
                        .multiplyScalar(force);

                    node3d.position.add(direction);
                }
            });
        });
    }, 16); // ~60fps
}

// Create starfield background
function createStarfield() {
    const starCount = 2000;
    const stars = new THREE.BufferGeometry();
    const positions = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
        const i3 = i * 3;

        // Positions in a sphere
        const radius = 150;
        const theta = 2 * Math.PI * Math.random();
        const phi = Math.acos(2 * Math.random() - 1);

        positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
        positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
        positions[i3 + 2] = radius * Math.cos(phi);
    }

    stars.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const starMaterial = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 1.5,
        transparent: true,
        opacity: 0.8
    });

    const starField = new THREE.Points(stars, starMaterial);
    scene.add(starField);
}

// Create particle background
function createParticleBackground() {
    const particleCount = 1000;
    const particles = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;

        // Positions
        positions[i3] = (Math.random() - 0.5) * 200;
        positions[i3 + 1] = (Math.random() - 0.5) * 200;
        positions[i3 + 2] = (Math.random() - 0.5) * 200;

        // Colors
        colors[i3] = 0;     // R
        colors[i3 + 1] = 0.9; // G
        colors[i3 + 2] = 1;   // B
    }

    particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particles.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const particleMaterial = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.7
    });

    const particleSystem = new THREE.Points(particles, particleMaterial);
    scene.add(particleSystem);
}

// Animation loop
function animate() {
    if (!scene || !camera || !renderer) {
        requestAnimationFrame(animate);
        return;
    }

    requestAnimationFrame(animate);

    // Update controls if available
    if (controls) {
        controls.update();
    }

    // Rotate data cube
    const cube = document.querySelector('.logo-cube');
    if (cube) {
        cube.style.transform = `rotateX(${Date.now() * 0.01}deg) rotateY(${Date.now() * 0.015}deg)`;
    }

    // Animate nodes if they exist
    threeNodes.forEach((node3d, id) => {
        // Find corresponding data node
        const nodeData = nodes.find(n => n.id === id);
        if (nodeData) {
            // Pulse animation
            const scale = 1 + Math.sin(Date.now() * 0.002 + parseInt(id.replace(/\D/g, ''))) * 0.1;
            node3d.scale.set(scale, scale, scale);

            // Rotate for type-specific animations
            if (nodeData.type === 'project') {
                node3d.rotation.y += 0.002;
            } else if (nodeData.type === 'session') {
                node3d.rotation.x += 0.003;
            }
        }
    });

    renderer.render(scene, camera);
}

// Create 3D nodes from data
function create3DNodes() {
    if (!scene || !renderer) {
        console.error('Three.js not initialized');
        return;
    }

    // Clear existing nodes
    threeNodes.forEach((node3d, id) => {
        scene.remove(node3d);
    });
    threeNodes.clear();

    // Clear existing links
    threeLinks.forEach(link => {
        scene.remove(link);
    });
    threeLinks = [];

    // Create clusters for related nodes
    const clusters = createNodeClusters();

    // Create nodes with cluster positions
    nodes.forEach(node => {
        let geometry, material, mesh;

        // Get cluster position if available
        const cluster = clusters[node.id];
        let basePosition = [0, 0, 0];
        if (cluster) {
            basePosition = cluster.center;
        }

        // Create different geometry based on node type
        switch (node.type) {
            case 'project':
                // Create a complex icosahedron for projects
                geometry = new THREE.IcosahedronGeometry(node.size / 10, 1);
                break;
            case 'session':
                // Create a torus knot for sessions
                geometry = new THREE.TorusKnotGeometry(node.size / 15, node.size / 30, 100, 16);
                break;
            case 'error':
                // Create a sharp octahedron for errors
                geometry = new THREE.OctahedronGeometry(node.size / 8, 1);
                break;
            case 'file':
                // Create a custom shape for files
                geometry = new THREE.BoxGeometry(node.size / 10, node.size / 10, node.size / 10);
                break;
            default:
                // Default sphere for actions
                geometry = new THREE.SphereGeometry(node.size / 10, 16, 16);
        }

        // Create material with glow effect
        material = new THREE.MeshPhongMaterial({
            color: node.color.replace('#', '0x'),
            emissive: node.color.replace('#', '0x'),
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.9,
            specular: 0xffffff,
            shininess: 30
        });

        // Create mesh
        mesh = new THREE.Mesh(geometry, material);

        // Position with some randomness around cluster center
        mesh.position.x = basePosition[0] + (Math.random() - 0.5) * 20;
        mesh.position.y = basePosition[1] + (Math.random() - 0.5) * 20;
        mesh.position.z = basePosition[2] + (Math.random() - 0.5) * 20;

        // Store reference
        mesh.userData = { id: node.id, type: node.type };

        // Add to scene and map
        scene.add(mesh);
        threeNodes.set(node.id, mesh);
    });

    // Create links between nodes
    links.forEach(link => {
        const sourceNode = threeNodes.get(link.source.id || link.source);
        const targetNode = threeNodes.get(link.target.id || link.target);

        if (sourceNode && targetNode) {
            // Create a curve for the link
            const curve = new THREE.QuadraticBezierCurve3(
                sourceNode.position,
                new THREE.Vector3(
                    (sourceNode.position.x + targetNode.position.x) / 2,
                    (sourceNode.position.y + targetNode.position.y) / 2,
                    (sourceNode.position.z + targetNode.position.z) / 2 + 10 // Curve upward
                ),
                targetNode.position
            );

            // Create tube geometry for the link
            const geometry = new THREE.TubeGeometry(curve, 20, 0.2, 8, false);
            const material = new THREE.MeshPhongMaterial({
                color: getLinkColor(link.type).replace('#', '0x'),
                transparent: true,
                opacity: 0.4,
                emissive: getLinkColor(link.type).replace('#', '0x'),
                emissiveIntensity: 0.3
            });

            const linkMesh = new THREE.Mesh(geometry, material);
            scene.add(linkMesh);
            threeLinks.push(linkMesh);

            // Add flow particles to links
            addFlowParticles(linkMesh, sourceNode, targetNode);
        }
    });
}

// Create clusters for related nodes
function createNodeClusters() {
    const clusters = {};
    const projectNodes = nodes.filter(n => n.type === 'project');

    // Create a cluster for each project
    projectNodes.forEach((project, index) => {
        const angle = (index / projectNodes.length) * Math.PI * 2;
        const radius = 50;
        const center = [
            Math.cos(angle) * radius,
            Math.sin(angle) * radius,
            0
        ];

        // Assign project to its cluster
        clusters[project.id] = { center };

        // Assign related sessions to the same cluster
        links.forEach(link => {
            if (link.type === 'contains' && link.source.id === project.id) {
                const sessionId = link.target.id;
                nodes.forEach(node => {
                    if (node.id === sessionId) {
                        clusters[node.id] = { center };
                    }
                });
            }
        });
    });

    return clusters;
}

// Add flow particles to links
function addFlowParticles(linkMesh, sourceNode, targetNode) {
    const particleCount = 20;
    const particles = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;
        const t = i / particleCount;

        // Position along the curve
        const point = linkMesh.geometry.parameters.path.getPoint(t);
        positions[i3] = point.x;
        positions[i3 + 1] = point.y;
        positions[i3 + 2] = point.z;
    }

    particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const particleMaterial = new THREE.PointsMaterial({
        color: 0x00f0ff,
        size: 1,
        transparent: true,
        opacity: 0.8
    });

    const particleSystem = new THREE.Points(particles, particleMaterial);
    scene.add(particleSystem);
    threeLinks.push(particleSystem);

    // Animate particles
    animateFlowParticles(particleSystem, sourceNode, targetNode);
}

// Animate flow particles
function animateFlowParticles(particleSystem, sourceNode, targetNode) {
    const positions = particleSystem.geometry.attributes.position.array;
    const particleCount = positions.length / 3;

    function animate() {
        for (let i = 0; i < particleCount; i++) {
            const i3 = i * 3;
            let t = (Date.now() * 0.001 + i / particleCount) % 1;

            // Get point along curve
            const sourcePos = new THREE.Vector3().copy(sourceNode.position);
            const targetPos = new THREE.Vector3().copy(targetNode.position);
            const controlPoint = new THREE.Vector3(
                (sourcePos.x + targetPos.x) / 2,
                (sourcePos.y + targetPos.y) / 2,
                (sourcePos.z + targetPos.z) / 2 + 10
            );

            const curve = new THREE.QuadraticBezierCurve3(sourcePos, controlPoint, targetPos);
            const point = curve.getPoint(t);

            positions[i3] = point.x;
            positions[i3 + 1] = point.y;
            positions[i3 + 2] = point.z;
        }

        particleSystem.geometry.attributes.position.needsUpdate = true;
        requestAnimationFrame(animate);
    }

    animate();
}

// Get color for link based on type
function getLinkColor(type) {
    const colors = {
        'contains': '#00f0ff',
        'executes': '#ffaa00',
        'modifies': '#ffcc00',
        'threw': '#ff0044'
    };
    return colors[type] || '#ffffff';
}

// WebSocket connection
function connectWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('Connected to dashboard server');
        addEvent('system', 'Connected to live feed');
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
            case 'init':
                updateGraph(msg.data);
                loadStats();
                break;
            case 'graph_update':
                updateGraph(msg.data);
                loadStats();
                break;
            case 'event':
                handleLiveEvent(msg.event, msg.data);
                break;
        }
    };

    ws.onclose = () => {
        console.log('Disconnected, reconnecting in 3s...');
        addEvent('system', 'Connection lost, reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// Update graph data
function updateGraph(data) {
    if (!data || !data.nodes) return;

    nodes = data.nodes;
    links = data.links;

    // Create 3D visualization
    create3DNodes();

    // Update matrix view if it's active
    if (document.getElementById('matrix-view').classList.contains('active')) {
        renderMatrixView();
    }

    // Update cloud view if it's active
    if (document.getElementById('cloud-view').classList.contains('active')) {
        renderCloudView();
    }
}

// Load statistics
function loadStats() {
    fetch('/api/stats')
        .then(r => r.json())
        .then(data => {
            document.getElementById('stat-projects').textContent = data.projects || 0;
            document.getElementById('stat-sessions').textContent = data.sessions || 0;
            document.getElementById('stat-actions').textContent = data.actions || 0;
            document.getElementById('stat-errors').textContent = data.errors || 0;
        });
}

// Handle live events
function handleLiveEvent(eventType, data) {
    const typeMap = {
        'session_start': { label: 'Session Started', class: 'session' },
        'session_end': { label: 'Session Ended', class: 'session' },
        'action': { label: data?.tool || 'Action', class: 'action' },
        'error': { label: data?.error_type || 'Error', class: 'error' },
        'file_edit': { label: 'File Modified', class: 'action' },
        'dialog': { label: 'Dialog Entry', class: 'session' }
    };

    const info = typeMap[eventType] || { label: eventType, class: 'session' };
    addEvent(info.class, info.label, data);

    // Play sound based on event type
    switch (eventType) {
        case 'session_start':
            playSound(440, 0.2); // A4 note
            break;
        case 'session_end':
            playSound(330, 0.2); // E4 note
            break;
        case 'action':
            playSound(523, 0.1); // C5 note
            break;
        case 'error':
            playSound(220, 0.3); // A3 note
            break;
        case 'file_edit':
            playSound(392, 0.15); // G4 note
            break;
    }

    // Flash effect on graph
    flashGraph();
}

// Add event to feed
function addEvent(type, label, data) {
    const feed = document.getElementById('events-feed');
    const item = document.createElement('div');
    item.className = `event-item ${type}`;

    const time = new Date().toLocaleTimeString();
    let detail = '';
    if (data) {
        if (data.summary) detail = data.summary.slice(0, 50);
        else if (data.project_dir) detail = data.project_dir.split(/[\\/]/).pop();
        else if (data.message) detail = data.message.slice(0, 50);
    }

    item.innerHTML = `
        <div class="event-time">${time}</div>
        <div class="event-type">${label}</div>
        ${detail ? `<div style="color: #888; font-size: 11px;">${detail}</div>` : ''}
    `;

    feed.insertBefore(item, feed.firstChild);

    // Limit feed
    while (feed.children.length > 20) {
        feed.removeChild(feed.lastChild);
    }
}

// Flash effect on graph
function flashGraph() {
    const container = document.getElementById('three-container');
    container.style.boxShadow = 'inset 0 0 100px rgba(0, 240, 255, 0.1)';
    setTimeout(() => {
        container.style.boxShadow = 'none';
    }, 300);
}

// Initialize controls
function initControls() {
    // Export PNG
    document.getElementById('btn-export-png').addEventListener('click', exportPNG);

    // Export JSON
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);

    // Toggle theme
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);

    // Toggle sound
    document.getElementById('btn-sound').addEventListener('click', toggleSound);

    // Toggle VR mode
    document.getElementById('btn-vr').addEventListener('click', toggleVRMode);

    // Toggle fullscreen
    document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

    // Reset view
    document.getElementById('btn-reset').addEventListener('click', resetView);

    // Search
    document.getElementById('search-box').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        searchNodes(term);
    });
}

// Initialize interface selector
function initInterfaceSelector() {
    document.querySelectorAll('.interface-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active class from all buttons
            document.querySelectorAll('.interface-btn').forEach(b => b.classList.remove('active'));

            // Add active class to clicked button
            e.target.classList.add('active');

            // Hide all visualizations
            document.querySelectorAll('.visualization').forEach(viz => viz.classList.remove('active'));

            // Show selected visualization
            const interfaceType = e.target.dataset.interface;
            document.getElementById(`${interfaceType}-view`).classList.add('active');

            // If switching to 3D graph, re-render
            if (interfaceType === 'graph') {
                camera.aspect = document.getElementById('three-container').clientWidth / document.getElementById('three-container').clientHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(document.getElementById('three-container').clientWidth, document.getElementById('three-container').clientHeight);
            }

            // If switching to matrix, re-render it
            if (interfaceType === 'matrix' && nodes.length > 0) {
                renderMatrixView();
            }

            // If switching to wave, start wave animation
            if (interfaceType === 'wave') {
                startWaveAnimation();
            }

            // If switching to cloud, render cloud
            if (interfaceType === 'cloud') {
                renderCloudView();
            }
        });
    });
}

// Matrix View Implementation
function initMatrixView() {
    // Will be populated when data is available
}

function renderMatrixView() {
    const matrixGrid = document.getElementById('matrix-grid');
    matrixGrid.innerHTML = '';

    // Group nodes by type
    const nodesByType = {};
    nodes.forEach(node => {
        if (!nodesByType[node.type]) {
            nodesByType[node.type] = [];
        }
        nodesByType[node.type].push(node);
    });

    // Create matrix items
    for (const type in nodesByType) {
        const typeHeader = document.createElement('div');
        typeHeader.className = 'matrix-header';
        typeHeader.textContent = type.toUpperCase();
        typeHeader.style.gridColumn = '1 / -1';
        typeHeader.style.color = getTypeColor(type);
        typeHeader.style.marginTop = '20px';
        typeHeader.style.marginBottom = '10px';
        typeHeader.style.fontSize = '18px';
        typeHeader.style.fontWeight = 'bold';
        matrixGrid.appendChild(typeHeader);

        // Create container for this type's items
        const typeContainer = document.createElement('div');
        typeContainer.className = 'matrix-type-container';
        typeContainer.style.display = 'grid';
        typeContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
        typeContainer.style.gap = '15px';
        typeContainer.style.marginBottom = '20px';

        nodesByType[type].forEach(node => {
            const matrixItem = document.createElement('div');
            matrixItem.className = 'matrix-item';
            matrixItem.textContent = node.label;
            matrixItem.style.borderColor = node.color;
            matrixItem.style.color = node.color;

            // Add size based on node size
            const size = Math.max(60, node.size * 4);
            matrixItem.style.width = `${size}px`;
            matrixItem.style.height = `${size}px`;

            // Add intensity based on activity (sessions count, actions count, etc.)
            let intensity = 0.5;
            if (node.sessions) intensity = Math.min(1, node.sessions / 10);
            else if (node.actions) intensity = Math.min(1, node.actions / 20);
            else if (node.edits) intensity = Math.min(1, node.edits / 15);

            matrixItem.style.background = `rgba(${hexToRgb(node.color)}, ${intensity * 0.3})`;

            // Add click event to show details
            matrixItem.addEventListener('click', () => {
                showNodeDetailsById(node.id);
                highlightConnectionsInMatrix(node.id);
            });

            typeContainer.appendChild(matrixItem);
        });

        matrixGrid.appendChild(typeContainer);
    }
}

function hexToRgb(hex) {
    // Remove # if present
    hex = hex.replace('#', '');

    // Parse hex values
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    return `${r}, ${g}, ${b}`;
}

function highlightConnectionsInMatrix(nodeId) {
    // Find connected node IDs
    const connectedIds = new Set();
    links.forEach(link => {
        if (link.source.id === nodeId) connectedIds.add(link.target.id);
        if (link.target.id === nodeId) connectedIds.add(link.source.id);
    });

    // Remove previous highlights
    document.querySelectorAll('.matrix-item').forEach(item => {
        item.style.boxShadow = '';
        item.style.transform = '';
    });

    // Highlight connected nodes
    document.querySelectorAll('.matrix-item').forEach(item => {
        const label = item.textContent;
        const node = nodes.find(n => n.label === label);

        if (node && (node.id === nodeId || connectedIds.has(node.id))) {
            item.style.boxShadow = '0 0 20px currentColor';
            item.style.transform = 'scale(1.1)';
        }
    });
}

function getTypeColor(type) {
    const colors = {
        'project': '#00f0ff',
        'session': '#8866ff',
        'action': '#ffaa00',
        'error': '#ff0044',
        'file': '#ffcc00'
    };
    return colors[type] || '#ffffff';
}

// Wave View Implementation
let waveAnimationId;
let mouseX = 0, mouseY = 0;

function initWaveView() {
    const canvas = document.getElementById('wave-canvas');
    canvas.width = document.getElementById('wave-view').clientWidth;
    canvas.height = document.getElementById('wave-view').clientHeight;

    // Add mouse move listener for interactive waves
    canvas.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });
}

function startWaveAnimation() {
    if (waveAnimationId) {
        cancelAnimationFrame(waveAnimationId);
    }

    const canvas = document.getElementById('wave-canvas');
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    function drawWave() {
        ctx.clearRect(0, 0, width, height);

        // Draw wave for each node type
        const types = ['project', 'session', 'action', 'error', 'file'];
        const colors = ['#00f0ff', '#8866ff', '#ffaa00', '#ff0044', '#ffcc00'];

        types.forEach((type, index) => {
            const typeNodes = nodes.filter(n => n.type === type);
            if (typeNodes.length === 0) return;

            ctx.beginPath();
            ctx.strokeStyle = colors[index];
            ctx.lineWidth = 3;

            const baseAmplitude = 20 + typeNodes.length;
            const baseFrequency = 0.02;
            const basePhase = Date.now() * 0.001 + index;

            for (let x = 0; x < width; x += 5) {
                // Base wave
                let y = height / 2 + Math.sin(x * baseFrequency + basePhase) * baseAmplitude;

                // Add mouse interaction
                const distanceToMouse = Math.abs(x - mouseX);
                if (distanceToMouse < 150) {
                    const mouseEffect = (1 - distanceToMouse / 150) * 50;
                    y += Math.sin(x * 0.05 + basePhase) * mouseEffect;
                }

                // Add secondary wave for complexity
                y += Math.sin(x * 0.01 + basePhase * 1.5) * 10;

                if (x === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }

            ctx.stroke();

            // Add particles on top of the wave
            drawWaveParticles(ctx, colors[index], width, height, baseAmplitude, baseFrequency, basePhase);
        });

        waveAnimationId = requestAnimationFrame(drawWave);
    }

    drawWave();
}

function drawWaveParticles(ctx, color, width, height, amplitude, frequency, phase) {
    const particleCount = 20;

    ctx.fillStyle = color;

    for (let i = 0; i < particleCount; i++) {
        const x = (i / particleCount) * width;
        const y = height / 2 + Math.sin(x * frequency + phase) * amplitude;

        // Draw particle with glow effect
        ctx.beginPath();
        ctx.arc(x, y, 3 + Math.sin(Date.now() * 0.005 + i) * 2, 0, Math.PI * 2);
        ctx.fill();

        // Draw glow
        ctx.beginPath();
        ctx.arc(x, y, 6 + Math.sin(Date.now() * 0.005 + i) * 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${hexToRgb(color)}, ${0.3 + Math.sin(Date.now() * 0.005 + i) * 0.2})`;
        ctx.fill();

        // Restore fill style for next particle
        ctx.fillStyle = color;
    }
}

// Cloud View Implementation
function initCloudView() {
    // Will be populated when data is available
}

function renderCloudView() {
    const cloudContainer = document.getElementById('cloud-container');
    cloudContainer.innerHTML = '';

    // Create a container for cloud items
    const cloudInner = document.createElement('div');
    cloudInner.className = 'cloud-inner';
    cloudContainer.appendChild(cloudInner);

    // Create word cloud based on node labels
    nodes.forEach(node => {
        const cloudItem = document.createElement('div');
        cloudItem.className = 'cloud-item';
        cloudItem.textContent = node.label;
        cloudItem.style.color = node.color;
        cloudItem.dataset.id = node.id;

        // Set size based on node size and type
        let size = 14 + node.size;
        if (node.type === 'project') size += 10;

        cloudItem.style.fontSize = `${size}px`;

        // Set initial position
        cloudItem.style.position = 'absolute';
        cloudItem.style.left = `${Math.random() * 70 + 15}%`;
        cloudItem.style.top = `${Math.random() * 70 + 15}%`;

        // Set initial velocity for animation
        cloudItem.dataset.vx = (Math.random() - 0.5) * 2;
        cloudItem.dataset.vy = (Math.random() - 0.5) * 2;

        // Add click event to show details
        cloudItem.addEventListener('click', () => {
            showNodeDetailsById(node.id);
            highlightConnectionsInCloud(node.id);
        });

        cloudInner.appendChild(cloudItem);
    });

    // Start cloud animation
    animateCloud();
}

function animateCloud() {
    const cloudItems = document.querySelectorAll('.cloud-item');
    const container = document.getElementById('cloud-container');
    const containerRect = container.getBoundingClientRect();

    function updatePositions() {
        cloudItems.forEach(item => {
            let left = parseFloat(item.style.left);
            let top = parseFloat(item.style.top);
            let vx = parseFloat(item.dataset.vx);
            let vy = parseFloat(item.dataset.vy);

            // Update position
            left += vx * 0.1;
            top += vy * 0.1;

            // Bounce off edges
            if (left < 10 || left > 90) {
                vx = -vx;
                left = Math.max(10, Math.min(90, left));
            }
            if (top < 10 || top > 90) {
                vy = -vy;
                top = Math.max(10, Math.min(90, top));
            }

            // Apply magnetic effect to nearby items
            cloudItems.forEach(otherItem => {
                if (item === otherItem) return;

                const otherLeft = parseFloat(otherItem.style.left);
                const otherTop = parseFloat(otherItem.style.top);

                const dx = otherLeft - left;
                const dy = otherTop - top;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 20) {
                    const force = (20 - distance) * 0.01;
                    vx -= dx * force;
                    vy -= dy * force;
                }
            });

            // Apply velocity limits
            vx = Math.max(-2, Math.min(2, vx));
            vy = Math.max(-2, Math.min(2, vy));

            // Update item position and data
            item.style.left = `${left}%`;
            item.style.top = `${top}%`;
            item.dataset.vx = vx;
            item.dataset.vy = vy;
        });

        requestAnimationFrame(updatePositions);
    }

    updatePositions();
}

function highlightConnectionsInCloud(nodeId) {
    // Find connected node IDs
    const connectedIds = new Set();
    links.forEach(link => {
        if (link.source.id === nodeId) connectedIds.add(link.target.id);
        if (link.target.id === nodeId) connectedIds.add(link.source.id);
    });

    // Remove previous highlights
    document.querySelectorAll('.cloud-item').forEach(item => {
        item.style.textShadow = '0 0 10px currentColor';
        item.style.transform = '';
    });

    // Highlight connected nodes
    document.querySelectorAll('.cloud-item').forEach(item => {
        const id = item.dataset.id;

        if (id === nodeId) {
            item.style.textShadow = '0 0 20px currentColor';
            item.style.transform = 'scale(1.5)';
        } else if (connectedIds.has(id)) {
            item.style.textShadow = '0 0 15px currentColor';
            item.style.transform = 'scale(1.2)';
        }
    });
}

// Export PNG
function exportPNG() {
    if (typeof html2canvas !== 'undefined') {
        html2canvas(document.getElementById('visualization-container')).then(canvas => {
            const link = document.createElement('a');
            link.download = `persistence-graph-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    } else {
        alert('html2canvas library not loaded. Cannot export PNG.');
    }
}

// Export JSON
function exportJSON() {
    const data = {
        nodes: nodes,
        links: links,
        timestamp: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.download = `persistence-graph-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    link.href = url;
    link.click();

    URL.revokeObjectURL(url);
}

// Toggle theme
function toggleTheme() {
    const themeLink = document.getElementById('theme-stylesheet');
    themeLink.disabled = !themeLink.disabled;

    // Save preference to localStorage
    localStorage.setItem('persistence-theme', themeLink.disabled ? 'default' : 'cyberpunk');
}

// Sound effects
let soundEnabled = false;
let audioContext = null;

function toggleSound() {
    soundEnabled = !soundEnabled;
    const btn = document.getElementById('btn-sound');
    btn.textContent = soundEnabled ? '🔊' : '🔇';

    if (soundEnabled && !audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Save preference
    localStorage.setItem('persistence-sound', soundEnabled);
}

function playSound(frequency, duration) {
    if (!soundEnabled || !audioContext) return;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);

    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
}

// VR Mode
let vrMode = false;
let vrRenderer = null;

function toggleVRMode() {
    vrMode = !vrMode;
    const btn = document.getElementById('btn-vr');

    if (vrMode) {
        btn.textContent = '🥽 ON';
        enableVRMode();
    } else {
        btn.textContent = '🥽';
        disableVRMode();
    }
}

function enableVRMode() {
    if (navigator.xr) {
        navigator.xr.requestSession('immersive-vr')
            .then(session => {
                // Set up VR renderer
                renderer.xr.enabled = true;
                renderer.xr.setSession(session);
            })
            .catch(err => {
                console.error('VR not supported:', err);
                alert('VR mode not supported in this browser');
                vrMode = false;
                document.getElementById('btn-vr').textContent = '🥽';
            });
    } else {
        alert('WebXR not supported in this browser');
        vrMode = false;
        document.getElementById('btn-vr').textContent = '🥽';
    }
}

function disableVRMode() {
    if (renderer && renderer.xr.enabled) {
        renderer.xr.enabled = false;
    }
}

// Fullscreen
function toggleFullscreen() {
    const doc = document.documentElement;

    if (!document.fullscreenElement) {
        if (doc.requestFullscreen) {
            doc.requestFullscreen();
        } else if (doc.webkitRequestFullscreen) { /* Safari */
            doc.webkitRequestFullscreen();
        } else if (doc.msRequestFullscreen) { /* IE11 */
            doc.msRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) { /* Safari */
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) { /* IE11 */
            document.msExitFullscreen();
        }
    }
}

// Reset view
function resetView() {
    // Reset camera position
    controls.reset();

    // Reset search
    document.getElementById('search-box').value = '';

    // Reset node highlighting
    threeNodes.forEach(node3d => {
        node3d.material.opacity = 0.9;
        node3d.material.emissiveIntensity = 0.5;
    });

    // Reset link highlighting
    threeLinks.forEach(link => {
        link.material.opacity = 0.4;
    });

    // Reset info panel
    document.getElementById('node-info').innerHTML = '<p class="placeholder">Select a node to view details</p>';
}

// Search nodes
function searchNodes(term) {
    if (!term) {
        threeNodes.forEach(node3d => {
            node3d.material.opacity = 0.9;
            node3d.material.emissiveIntensity = 0.5;
        });
        return;
    }

    // Find matching nodes
    const matchingIds = new Set();
    nodes.forEach(node => {
        if (node.label.toLowerCase().includes(term) ||
            (node.path && node.path.toLowerCase().includes(term)) ||
            (node.id && node.id.toLowerCase().includes(term))) {
            matchingIds.add(node.id);
        }
    });

    // Highlight matching nodes
    threeNodes.forEach((node3d, id) => {
        if (matchingIds.has(id)) {
            node3d.material.opacity = 1;
            node3d.material.emissiveIntensity = 1;
        } else {
            node3d.material.opacity = 0.3;
            node3d.material.emissiveIntensity = 0.2;
        }
    });
}

// Handle node click
function showNodeDetails(event) {
    // Raycast to find clicked node
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Calculate mouse position in normalized device coordinates
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update the picking ray with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Calculate objects intersecting the picking ray
    const intersects = raycaster.intersectObjects(scene.children);

    for (let i = 0; i < intersects.length; i++) {
        if (intersects[i].object.userData.id) {
            const nodeId = intersects[i].object.userData.id;
            const nodeData = nodes.find(n => n.id === nodeId);

            if (nodeData) {
                const info = document.getElementById('node-info');
                let html = `<span class="type-badge ${nodeData.type}">${nodeData.type}</span>`;
                html += `<h4 style="margin: 8px 0; color: ${nodeData.color}">${nodeData.label}</h4>`;

                const fields = {
                    project: ['path', 'sessions', 'actions'],
                    session: ['id', 'status', 'agent', 'model', 'actions', 'errors', 'duration', 'started'],
                    action: ['tool', 'summary', 'status', 'attempt', 'time'],
                    error: ['message', 'stack', 'time'],
                    file: ['path', 'edits']
                };

                const labels = {
                    path: 'Path', sessions: 'Sessions', actions: 'Actions',
                    id: 'Session ID', status: 'Status', agent: 'Agent',
                    model: 'Model', errors: 'Errors', duration: 'Duration (s)',
                    started: 'Started', tool: 'Tool', summary: 'Summary',
                    attempt: 'Attempts', time: 'Time', message: 'Message',
                    stack: 'Stack', edits: 'Edit Count'
                };

                fields[nodeData.type]?.forEach(f => {
                    const val = nodeData[f];
                    if (val !== undefined && val !== null) {
                        html += `<div class="field"><div class="key">${labels[f] || f}</div><div class="val">${String(val).slice(0, 300)}</div></div>`;
                    }
                });

                info.innerHTML = html;

                // Highlight connected nodes
                highlightConnectedNodes(nodeId);

                // Tunnel zoom effect
                tunnelZoom(intersects[i].object.position);
                break;
            }
        }
    }
}

// Tunnel zoom effect on node click
function tunnelZoom(targetPosition) {
    const startPosition = camera.position.clone();
    const endPosition = new THREE.Vector3(
        targetPosition.x,
        targetPosition.y,
        targetPosition.z + 20
    );

    const duration = 1500; // 1.5 seconds
    const startTime = Date.now();

    function zoomAnimation() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease in-out function
        const easeInOut = progress < 0.5
            ? 2 * progress * progress
            : 2 * progress * (2 - progress) - 1;

        camera.position.lerpVectors(startPosition, endPosition, easeInOut);
        camera.lookAt(targetPosition);

        if (progress < 1) {
            requestAnimationFrame(zoomAnimation);
        }
    }

    zoomAnimation();
}

// Highlight connected nodes
function highlightConnectedNodes(nodeId) {
    // Find connected node IDs
    const connectedIds = new Set();
    links.forEach(link => {
        if (link.source.id === nodeId) connectedIds.add(link.target.id);
        if (link.target.id === nodeId) connectedIds.add(link.source.id);
    });

    // Highlight nodes
    threeNodes.forEach((node3d, id) => {
        if (id === nodeId) {
            node3d.material.opacity = 1;
            node3d.material.emissiveIntensity = 1.5;
        } else if (connectedIds.has(id)) {
            node3d.material.opacity = 0.9;
            node3d.material.emissiveIntensity = 1;
        } else {
            node3d.material.opacity = 0.2;
            node3d.material.emissiveIntensity = 0.1;
        }
    });

    // Highlight links
    threeLinks.forEach(link => {
        // This is a simplification - in a real implementation, we'd need to track which links connect to which nodes
        link.material.opacity = 0.7;
    });
}

// Add event listener for node clicks
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('three-container').addEventListener('click', showNodeDetails);
});

// Show node details by ID (used by other views)
function showNodeDetailsById(nodeId) {
    const nodeData = nodes.find(n => n.id === nodeId);

    if (nodeData) {
        const info = document.getElementById('node-info');
        let html = `<span class="type-badge ${nodeData.type}">${nodeData.type}</span>`;
        html += `<h4 style="margin: 8px 0; color: ${nodeData.color}">${nodeData.label}</h4>`;

        const fields = {
            project: ['path', 'sessions', 'actions'],
            session: ['id', 'status', 'agent', 'model', 'actions', 'errors', 'duration', 'started'],
            action: ['tool', 'summary', 'status', 'attempt', 'time'],
            error: ['message', 'stack', 'time'],
            file: ['path', 'edits']
        };

        const labels = {
            path: 'Path', sessions: 'Sessions', actions: 'Actions',
            id: 'Session ID', status: 'Status', agent: 'Agent',
            model: 'Model', errors: 'Errors', duration: 'Duration (s)',
            started: 'Started', tool: 'Tool', summary: 'Summary',
            attempt: 'Attempts', time: 'Time', message: 'Message',
            stack: 'Stack', edits: 'Edit Count'
        };

        fields[nodeData.type]?.forEach(f => {
            const val = nodeData[f];
            if (val !== undefined && val !== null) {
                html += `<div class="field"><div class="key">${labels[f] || f}</div><div class="val">${String(val).slice(0, 300)}</div></div>`;
            }
        });

        info.innerHTML = html;
    }
}

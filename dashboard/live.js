// XuViGaN Persistence Dashboard - Elegant Graph Visualization
// Using D3.js for beautiful force-directed graph

const WS_URL = `ws://${window.location.hostname}:${window.location.port}/ws`;
let ws = null;
let simulation = null;
let svg, width, height;
let nodes = [], links = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initGraph();
    connectWebSocket();
    loadStats();
    initControls();

    // Handle window resize
    window.addEventListener('resize', () => {
        width = document.getElementById('graph-container').clientWidth;
        height = document.getElementById('graph-container').clientHeight;
        simulation.force('center', d3.forceCenter(width / 2, height / 2));
        simulation.alpha(0.3).restart();
    });
});

// Initialize graph
function initGraph() {
    svg = d3.select('#graph');
    width = document.getElementById('graph-container').clientWidth;
    height = document.getElementById('graph-container').clientHeight;

    // Add defs for glow effects and gradients
    const defs = svg.append('defs');

    // Glow filter
    const filter = defs.append('filter')
        .attr('id', 'glow')
        .attr('x', '-50%')
        .attr('y', '-50%')
        .attr('width', '200%')
        .attr('height', '200%');

    filter.append('feGaussianBlur')
        .attr('stdDeviation', '3')
        .attr('result', 'coloredBlur');

    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Gradients for different node types
    const gradients = [
        { id: 'project-gradient', color: '#00f0ff' },
        { id: 'session-gradient', color: '#8866ff' },
        { id: 'action-gradient', color: '#ffaa00' },
        { id: 'error-gradient', color: '#ff0044' },
        { id: 'file-gradient', color: '#ffcc00' }
    ];

    gradients.forEach(grad => {
        const gradient = defs.append('radialGradient')
            .attr('id', grad.id)
            .attr('cx', '50%')
            .attr('cy', '50%')
            .attr('r', '50%');

        gradient.append('stop')
            .attr('offset', '0%')
            .attr('stop-color', grad.color)
            .attr('stop-opacity', 0.8);

        gradient.append('stop')
            .attr('offset', '100%')
            .attr('stop-color', grad.color)
            .attr('stop-opacity', 0.2);
    });

    // Zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            container.attr('transform', event.transform);
        });

    svg.call(zoom);

    const container = svg.append('g').attr('class', 'container');

    // Arrow marker for links
    defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .append('path')
        .attr('d', 'M 0,-5 L 10,0 L 0,5')
        .attr('fill', 'rgba(0,240,255,0.3)');

    // Initialize force simulation
    simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(d => {
            if (d.type === 'contains') return 80;
            if (d.type === 'executes') return 40;
            if (d.type === 'modifies') return 60;
            return 50;
        }))
        .force('charge', d3.forceManyBody().strength(d => {
            if (d.type === 'project') return -400;
            if (d.type === 'session') return -200;
            return -50;
        }))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.size + 10))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05));
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

// Update graph
function updateGraph(data) {
    if (!data || !data.nodes) return;

    nodes = data.nodes;
    links = data.links;

    const container = svg.select('.container');

    // Update links
    let link = container.selectAll('.link')
        .data(links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);

    link.exit().remove();

    link = link.enter().append('line')
        .attr('class', 'link')
        .attr('stroke', d => getLinkColor(d.type))
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.4)
        .attr('marker-end', 'url(#arrowhead)')
        .merge(link);

    // Update nodes
    let node = container.selectAll('.node')
        .data(nodes, d => d.id);

    node.exit().remove();

    const nodeEnter = node.enter().append('g')
        .attr('class', 'node')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // Add glow effect
    nodeEnter.append('circle')
        .attr('r', d => d.size * 1.5)
        .attr('fill', 'none')
        .attr('stroke', d => d.color)
        .attr('stroke-width', 1)
        .attr('opacity', 0.3)
        .attr('filter', 'url(#glow)');

    // Add main circle with gradient
    nodeEnter.append('circle')
        .attr('r', d => d.size)
        .attr('fill', d => `url(#${d.type}-gradient)`)
        .attr('stroke', d => d.color)
        .attr('stroke-width', 1.5)
        .attr('stroke-opacity', 0.8)
        .attr('filter', 'url(#glow)');

    // Add inner circle for depth
    nodeEnter.append('circle')
        .attr('r', d => d.size * 0.6)
        .attr('fill', 'rgba(255,255,255,0.2)')
        .attr('stroke', 'rgba(255,255,255,0.5)')
        .attr('stroke-width', 0.5);

    nodeEnter.append('text')
        .attr('dy', d => d.size + 15)
        .text(d => d.label)
        .attr('font-size', d => Math.max(10, d.size / 2));

    node = nodeEnter.merge(node);

    // Interactions
    node.on('mouseover', showTooltip)
        .on('mouseout', hideTooltip)
        .on('click', showNodeDetails);

    // Update simulation
    simulation.nodes(nodes).on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);

        node.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    simulation.force('link').links(links);
    simulation.alpha(0.3).restart();
}

// Get color for link based on type
function getLinkColor(type) {
    const colors = {
        'contains': 'rgba(0, 240, 255, 0.6)',
        'executes': 'rgba(255, 170, 0, 0.6)',
        'modifies': 'rgba(255, 204, 0, 0.6)',
        'threw': 'rgba(255, 0, 68, 0.6)'
    };
    return colors[type] || 'rgba(255, 255, 255, 0.3)';
}

// Show tooltip
function showTooltip(event, d) {
    const tooltip = document.getElementById('tooltip');
    let content = `<div class="tooltip-title">${d.label}</div>`;

    if (d.type === 'project') {
        content += `<div class="tooltip-sub">${d.path}</div>`;
        content += `<div>Sessions: ${d.sessions} | Actions: ${d.actions}</div>`;
    } else if (d.type === 'session') {
        content += `<div class="tooltip-sub">${d.id}</div>`;
        content += `<div>Status: ${d.status} | Agent: ${d.agent}</div>`;
        content += `<div>Model: ${d.model}</div>`;
    } else if (d.type === 'action') {
        content += `<div class="tooltip-sub">${d.tool}</div>`;
        content += `<div>${d.summary}</div>`;
        if (d.status) content += `<div>Status: ${d.status}</div>`;
    } else if (d.type === 'error') {
        content += `<div class="tooltip-sub">${d.message}</div>`;
    } else if (d.type === 'file') {
        content += `<div class="tooltip-sub">${d.path}</div>`;
        content += `<div>Edits: ${d.edits}</div>`;
    }

    tooltip.innerHTML = content;
    tooltip.style.left = (event.pageX + 15) + 'px';
    tooltip.style.top = (event.pageY - 10) + 'px';
    tooltip.style.opacity = 1;
}

// Hide tooltip
function hideTooltip() {
    document.getElementById('tooltip').style.opacity = 0;
}

// Show node details
function showNodeDetails(event, d) {
    const info = document.getElementById('node-info');
    let html = `<span class="type-badge ${d.type}">${d.type}</span>`;
    html += `<h4 style="margin: 8px 0; color: ${d.color}">${d.label}</h4>`;

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

    fields[d.type]?.forEach(f => {
        const val = d[f];
        if (val !== undefined && val !== null) {
            html += `<div class="field"><div class="key">${labels[f] || f}</div><div class="val">${String(val).slice(0, 300)}</div></div>`;
        }
    });

    info.innerHTML = html;

    // Highlight connected nodes
    highlightConnections(d);
}

// Highlight connections
function highlightConnections(d) {
    const connectedIds = new Set();
    links.forEach(l => {
        if (l.source.id === d.id) connectedIds.add(l.target.id);
        if (l.target.id === d.id) connectedIds.add(l.source.id);
    });

    svg.selectAll('.node')
        .classed('dimmed', n => n.id !== d.id && !connectedIds.has(n.id))
        .classed('highlighted', n => n.id === d.id);

    svg.selectAll('.link')
        .classed('dimmed', l => l.source.id !== d.id && l.target.id !== d.id)
        .classed('highlighted', l => l.source.id === d.id || l.target.id === d.id);
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
    const container = document.getElementById('graph-container');
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

    // Reset view
    document.getElementById('btn-reset').addEventListener('click', resetView);

    // Search
    document.getElementById('search-box').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        searchNodes(term);
    });
}

// Export PNG
function exportPNG() {
    if (typeof html2canvas !== 'undefined') {
        html2canvas(document.getElementById('graph-container')).then(canvas => {
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

// Reset view
function resetView() {
    // Reset zoom
    svg.transition().duration(750).call(
        d3.zoom().transform,
        d3.zoomIdentity
    );

    // Reset node highlighting
    svg.selectAll('.node')
        .classed('dimmed', false)
        .classed('highlighted', false);

    svg.selectAll('.link')
        .classed('dimmed', false)
        .classed('highlighted', false);

    // Reset info panel
    document.getElementById('node-info').innerHTML = '<p class="placeholder">Select a node to view details</p>';

    // Reset search
    document.getElementById('search-box').value = '';
}

// Search nodes
function searchNodes(term) {
    if (!term) {
        svg.selectAll('.node').classed('search-match', false);
        return;
    }

    svg.selectAll('.node')
        .classed('search-match', d =>
            d.label.toLowerCase().includes(term) ||
            (d.path && d.path.toLowerCase().includes(term)) ||
            (d.id && d.id.toLowerCase().includes(term))
        );
}

// Drag functions
function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
}

function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
}

function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
}

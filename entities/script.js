const data = embeddedData;

const entities = data.entities;
const relationships = data.relationships;

// Add lease relationships to deck_family_trust
const productionEntities = [
  "ffcsa",
  "friends_marketing",
  "garden",
  "pork",
  "layers",
  "roasters",
  "grazers",
  "creamy_cow",
  "hyland_processing"
];

productionEntities.forEach(prod => {
  relationships.push({
    from: prod,
    to: "deck_family_trust",
    note: "lease"
  });
});

const elements = [];

// Y positions
const yTop = 0;
const yMiddle = 200;
const yBottom = 400;
const yBottom2 = 600;

// X positions
const nodePositions = {
  olympia_provisions:        { x: -500, y: yTop },
  garden_wholesale:          { x: 700,  y: yTop },
  farmers_market_customers:  { x: -200, y: yTop },
  wholesale_customers:       { x: 200,  y: yTop },
  ffcsa_members:             { x: 500,  y: yTop },

  friends_marketing:         { x: -200, y: yMiddle },
  ffcsa:                     { x: 300,  y: yMiddle },

  pork:                      { x: -500, y: yBottom },
  hyland_processing:         { x: -300, y: yBottom },
  layers:                    { x: -100, y: yBottom },
  roasters:                  { x: 100,  y: yBottom },
  grazers:                   { x: 300,  y: yBottom },
  creamy_cow:                { x: 500,  y: yBottom },
  garden:                    { x: 700,  y: yBottom },

  deck_family_trust:         { x: 100,  y: yBottom2 } // temporary, will update later
};

// Add nodes
for (const [id, position] of Object.entries(nodePositions)) {
  elements.push({
    data: {
      id,
      label: id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    },
    position
  });
}

// Add unplaced nodes
const placed = new Set(Object.keys(nodePositions));
for (const entity of entities) {
  if (!placed.has(entity)) {
    elements.push({
      data: {
        id: entity,
        label: entity.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      }
    });
  }
}

// Add edges and tag lease or percent
relationships.forEach(rel => {
  const id = `${rel.from}_${rel.to}`;
  const isLease = rel.to === "deck_family_trust" && rel.note === "lease";
  const isPercent = rel.percentage && !isLease;

  elements.push({
    data: {
      id,
      source: rel.from,
      target: rel.to,
      label: isLease ? "lease" : (rel.percentage ? `${rel.percentage}%` : ''),
      note: rel.note || '',
      ...(isLease && { lease: true }),
      ...(isPercent && { percent: true })
    }
  });
});

// Init Cytoscape
const cy = cytoscape({
  container: document.getElementById('cy'),
  elements,

  style: [
    {
      selector: 'node',
      style: {
        'background-color': '#2E86AB',
        'label': 'data(label)',
        'color': '#fff',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '20px',
        'shape': 'roundrectangle',
        'text-wrap': 'wrap',
        'text-max-width': '140px',
        'padding': '15px',
        'width': '140px',
        'height': '60px'
      }
    },
    {
      selector: 'node#deck_family_trust',
      style: {
        'background-color': '#4CAF50',
        'shape': 'roundrectangle',
        'label': 'data(label)',
        'color': '#fff',
        'font-size': '22px',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '10000px',
        'padding': '15px'
      }
    },
    {
      selector: 'edge[percent]',
      style: {
        'line-color': '#FFA500',
        'target-arrow-color': '#FFA500',
        'line-style': 'solid',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1.5,
        'curve-style': 'bezier',
        'label': 'data(label)',
        'font-size': '14px',
        'text-background-color': '#fff',
        'text-background-opacity': 1,
        'text-background-padding': '2px',
        'text-margin-y': -10,
        'text-rotation': 'horizontal'
      }
    },
    {
      selector: 'edge[lease]',
      style: {
        'line-color': '#4CAF50',
        'target-arrow-color': '#4CAF50',
        'line-style': 'dashed',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1.5,
        'curve-style': 'straight',
        'label': 'data(label)',
        'font-size': '14px',
        'text-background-color': '#fff',
        'text-background-opacity': 1,
        'text-background-padding': '2px',
        'text-margin-y': -10,
        'text-rotation': 'horizontal'
      }
    }
  ],

  layout: { name: 'preset' },
  userZoomingEnabled: true,
  userPanningEnabled: true,
  wheelSensitivity: 0.2
});

// Tooltip for edge note + hide leases by default
cy.ready(() => {
  const tooltip = document.createElement('div');
  tooltip.style.position = 'absolute';
  tooltip.style.padding = '6px 10px';
  tooltip.style.background = '#fff';
  tooltip.style.border = '1px solid #ccc';
  tooltip.style.borderRadius = '5px';
  tooltip.style.fontSize = '14px';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.display = 'none';
  tooltip.style.zIndex = 9999;
  document.body.appendChild(tooltip);

  cy.on('mouseover', 'edge', e => {
    const note = e.target.data('note');
    if (note) {
      tooltip.textContent = note;
      tooltip.style.display = 'block';
    }
  });

  cy.on('mouseout', 'edge', () => {
    tooltip.style.display = 'none';
  });

  cy.on('mousemove', e => {
    tooltip.style.left = `${e.originalEvent.pageX + 10}px`;
    tooltip.style.top = `${e.originalEvent.pageY + 10}px`;
  });

  // Stretch and center deck_family_trust
  const productionXs = productionEntities
    .map(id => cy.getElementById(id).position().x)
    .sort((a, b) => a - b);

  if (productionXs.length > 1) {
    const left = productionXs[0];
    const right = productionXs[productionXs.length - 1];
    const width = right - left + 200;
    const centerX = (left + right) / 2;

    const trustNode = cy.getElementById('deck_family_trust');
    trustNode.position({ x: centerX, y: yBottom2 });
    trustNode.style('width', `${width}px`);
  }

  const fitGraph = () => cy.fit(null, 80);
  window.addEventListener('resize', fitGraph);

  // Legend
  const legend = document.createElement('div');
  legend.style.position = 'absolute';
  legend.style.bottom = '20px';
  legend.style.left = '20px';
  legend.style.background = '#f9f9f9';
  legend.style.border = '1px solid #ccc';
  legend.style.padding = '10px 15px';
  legend.style.fontSize = '14px';
  legend.style.borderRadius = '5px';
  legend.style.boxShadow = '0 2px 5px rgba(0,0,0,0.1)';
  legend.innerHTML = `
    <strong>Legend:</strong><br>
    <svg height="10" width="40"><line x1="0" y1="5" x2="40" y2="5" stroke="#4CAF50" stroke-width="2" stroke-dasharray="5,5"/></svg> Lease<br>
    <svg height="10" width="40"><line x1="0" y1="5" x2="40" y2="5" stroke="#FFA500" stroke-width="2"/></svg> Percentage<br><br>
    <label style="font-weight:normal;">
      <input type="checkbox" id="toggleLease">
      Show Leases
    </label>
  `;
  document.body.appendChild(legend);

  // Toggle leases from checkbox
  const toggleCheckbox = document.getElementById('toggleLease');
  toggleCheckbox.addEventListener('change', () => {
    const show = toggleCheckbox.checked;
    cy.edges('[lease]').style('display', show ? 'element' : 'none');
    cy.getElementById('deck_family_trust').style('display', show ? 'element' : 'none');
    fitGraph();
  });

  // Default state: leases hidden, checkbox off
  cy.edges('[lease]').style('display', 'none');
  cy.getElementById('deck_family_trust').style('display', 'none');
  toggleCheckbox.checked = false;

  fitGraph();
});


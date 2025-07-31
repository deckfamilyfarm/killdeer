const fs = require('fs');
const path = require('path');

// Load base HTML (index.html)
const htmlPath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

// Load JS
const scriptPath = path.join(__dirname, 'script.js');
let script = fs.readFileSync(scriptPath, 'utf8');

// Load JSON data and stringify it for injection
const dataPath = path.join(__dirname, 'data', 'entity_graph.json');
let jsonData = fs.readFileSync(dataPath, 'utf8');

// Inject the data as a JS variable
const dataScript = `<script>const embeddedData = ${jsonData};</script>`;

// Replace <script src="script.js"></script> with inline script + data
html = html.replace(
  /<script\s+src=["']script\.js["']><\/script>/,
    `${dataScript}\n<script>\n${script}\n</script>`
	);

	// Output to ../killdeer/docs/entities.html
	const outputPath = path.join(__dirname, '../docs/entities.html');
	fs.writeFileSync(outputPath, html);

	console.log(`✅ Built self-contained entities.html at ${outputPath}`);


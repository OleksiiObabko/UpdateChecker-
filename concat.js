const fs = require('fs');
const path = require('path');

const outputFile = 'combined_code.js';

fs.writeFileSync(outputFile, '');

function appendFileContent(filePath) {
	if (fs.existsSync(filePath)) {
		const content = fs.readFileSync(filePath, 'utf8');
		fs.appendFileSync(outputFile, `\n\n// --- [FILE: ${filePath}] ---\n\n`);
		fs.appendFileSync(outputFile, content);
	} else {
		console.warn(`File not found: ${filePath}`);
	}
}

appendFileContent('index.js');
appendFileContent('.env-example');

function processDirectory(dirPath) {
	if (!fs.existsSync(dirPath)) {
		return;
	}

	const items = fs.readdirSync(dirPath);

	for (const item of items) {
		const fullPath = path.join(dirPath, item);
		const stat = fs.statSync(fullPath);

		if (stat.isDirectory()) {
			processDirectory(fullPath);
		} else {
			appendFileContent(fullPath);
		}
	}
}

processDirectory('services');

console.log(`All files have been merged into ${outputFile}`);

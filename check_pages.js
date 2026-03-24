const fs = require('fs');
const h = fs.readFileSync('public/dashboard.html', 'utf8');
const lines = h.split('\n');
let depth = 0;
let inMain = false;
let currentPage = null;

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('<main')) { inMain = true; console.log('MAIN OPEN at line ' + (i + 1)); }
  if (!inMain) continue;
  const opens = (l.match(/<div[\s>]/g) || []).length;
  const closes = (l.match(/<\/div>/g) || []).length;
  const prevDepth = depth;
  depth += opens - closes;

  // Track page open
  const pageMatch = l.match(/id="([^"]+)"\s+class="page/);
  if (pageMatch) {
    currentPage = pageMatch[1];
    console.log('PAGE OPEN: ' + currentPage + ' at line ' + (i + 1) + ' depth=' + depth);
  }

  // Track when depth returns to 0 (page close)
  if (prevDepth >= 1 && depth === 0 && closes > 0) {
    console.log('PAGE CLOSE: ' + (currentPage || '?') + ' at line ' + (i + 1));
    currentPage = null;
  }

  // Track "Análise de Indicadores"
  if (l.includes('Análise de Indicadores')) {
    console.log('*** ANALISE at line ' + (i + 1) + ' depth=' + depth + ' currentPage=' + currentPage);
  }

  // Warn if depth goes negative
  if (depth < 0) {
    console.log('!!! DEPTH NEGATIVE at line ' + (i + 1) + ': ' + depth);
  }

  if (l.includes('</main>')) {
    console.log('MAIN CLOSE at line ' + (i + 1) + ' depth=' + depth);
    break;
  }
}

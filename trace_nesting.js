const fs = require('fs');
const lines = fs.readFileSync('public/dashboard.html', 'utf8').split('\n');
let depth = 0;
let inMain = false;

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('<main')) inMain = true;
  if (!inMain) continue;
  
  const opens = (l.match(/<div[\s>]/g) || []).length;
  const closes = (l.match(/<\/div>/g) || []).length;
  depth += opens - closes;
  
  const show = l.includes('class="page') 
    || l.includes('</main')
    || l.includes('Análise de Indicadores')
    || depth < 0
    || (depth === 0 && (opens > 0 || closes > 0));
    
  if (show) {
    console.log((i+1) + ' [d=' + depth + '] ' + l.substring(0, 140));
  }
}
console.log('\nFinal depth:', depth);

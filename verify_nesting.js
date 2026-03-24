// Precise HTML tag parser - verifies nesting by parsing individual tags
const fs = require('fs');
const html = fs.readFileSync('public/dashboard.html', 'utf8');

// Find the indicadores page boundaries precisely
const indicStart = html.indexOf('<div id="indicadores"');
const mainClose = html.indexOf('</main>', indicStart);

// Find where the indicadores page div closes by counting open/close divs
let depth = 0;
let pos = indicStart;
let indicEnd = -1;

// State machine to parse tags
while (pos < mainClose) {
  const nextOpen = html.indexOf('<div', pos);
  const nextClose = html.indexOf('</div>', pos);
  
  if (nextOpen === -1 && nextClose === -1) break;
  
  if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
    // Opening div tag - verify it's a real tag (not inside an attribute or comment)
    depth++;
    pos = nextOpen + 4;
  } else if (nextClose !== -1) {
    depth--;
    if (depth === 0) {
      indicEnd = nextClose + 6; // past '</div>'
      break;
    }
    pos = nextClose + 6;
  }
}

// Now check if "Análise de Indicadores" is between indicStart and indicEnd
const analisePos = html.indexOf('Análise de Indicadores');
const line = html.substring(0, analisePos).split('\n').length;

console.log('=== INDICADORES PAGE BOUNDARIES ===');
console.log('Opens at char:', indicStart, '(line ' + html.substring(0, indicStart).split('\n').length + ')');
console.log('Closes at char:', indicEnd, '(line ' + html.substring(0, indicEnd).split('\n').length + ')');
console.log('');
console.log('=== ANALISE DE INDICADORES ===');
console.log('Found at char:', analisePos, '(line ' + line + ')');
console.log('Is INSIDE indicadores page:', analisePos > indicStart && analisePos < indicEnd);
console.log('');

// Also verify: what's the next page div AFTER indicadores?
const nextPage = html.indexOf('<div id="historico"', indicEnd);
console.log('=== NEXT PAGE (historico) ===');
console.log('Starts at char:', nextPage, '(line ' + html.substring(0, nextPage).split('\n').length + ')');
console.log('Gap between indicadores close and historico open:', nextPage - indicEnd, 'chars');
console.log('Content between:', JSON.stringify(html.substring(indicEnd, nextPage).trim()));

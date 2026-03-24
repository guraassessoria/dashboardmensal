// Test how the browser DOM parser actually renders the page
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('public/dashboard.html', 'utf8');
const dom = new JSDOM(html);
const doc = dom.window.document;

// Find the "Análise de Indicadores" element
const allElements = doc.querySelectorAll('*');
let analiseEl = null;
for (const el of allElements) {
  if (el.textContent.trim() === 'Análise de Indicadores' && el.className === 'ctitle') {
    analiseEl = el;
    break;
  }
}

if (!analiseEl) {
  console.log('ERROR: Could not find "Análise de Indicadores" element');
  process.exit(1);
}

console.log('=== BROWSER DOM TREE FOR "Análise de Indicadores" ===');
console.log('Element:', analiseEl.tagName, analiseEl.className);

// Walk up the DOM tree
let current = analiseEl;
let depth = 0;
while (current && current !== doc.body) {
  const id = current.id ? '#' + current.id : '';
  const cls = current.className ? '.' + current.className.split(' ').join('.') : '';
  const tag = current.tagName ? current.tagName.toLowerCase() : '?';
  console.log('  '.repeat(depth) + (depth === 0 ? '→ ' : '  ') + tag + id + cls);
  
  // Check if this is a .page element
  if (current.classList && current.classList.contains('page')) {
    console.log('\n*** FOUND .page ANCESTOR: ' + tag + '#' + current.id);
    console.log('*** This element is INSIDE the "' + current.id + '" page');
    break;
  }
  
  current = current.parentElement;
  depth++;
}

if (!current || !current.classList || !current.classList.contains('page')) {
  console.log('\n!!! WARNING: "Análise de Indicadores" is NOT inside any .page element!');
  console.log('!!! This means it will be VISIBLE on ALL tabs!');
}

// Also check: is the .page element the indicadores page?
console.log('\n=== ALL .page ELEMENTS ===');
doc.querySelectorAll('.page').forEach(p => {
  const childCount = p.querySelectorAll('.ctitle').length;
  const hasAnalise = p.innerHTML.includes('Análise de Indicadores');
  console.log(p.id + (p.classList.contains('active') ? ' [ACTIVE]' : '') + 
    ' - ctitles: ' + childCount + (hasAnalise ? ' *** HAS ANALISE ***' : ''));
});

const fs = require('fs');
const html = fs.readFileSync('public/dashboard-dev.html', 'utf8');
const lines = html.split('\n');
let depth = 0;
let minDepth = 0;
let minLine = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  
  if (opens > 0 || closes > 0) {
    depth += opens - closes;
    if (depth < minDepth) {
      minDepth = depth;
      minLine = i + 1;
    }
  }
}
console.log('Final div depth:', depth);
console.log('Min depth:', minDepth, 'at line:', minLine);
if (depth !== 0) console.log('WARNING: Unbalanced divs!');
else console.log('OK: All divs balanced.');

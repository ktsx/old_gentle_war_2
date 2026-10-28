// symbolize.js — put C++ names into a Release-build browser stack.
// The Release wasm has no name section, so stacks read "wasm-function[3659]:0x178431". The link
// emits GeneralsZH.js.symbols ("<index>:<mangled name>" per line, --emit-symbol-map); this replaces
// every wasm-function[N] in the input with the name (demangled when c++filt is available).
//
// usage: node symbolize.js <GeneralsZH.js.symbols> [log]     (reads stdin without a log file)
const fs = require('fs');
const { execFileSync } = require('child_process');

const [symFile, logFile] = process.argv.slice(2);
if (!symFile) { console.error('usage: node symbolize.js <GeneralsZH.js.symbols> [log]'); process.exit(2); }
const names = new Map();
for (const line of fs.readFileSync(symFile, 'utf8').split('\n')) {
  const i = line.indexOf(':');
  if (i > 0) names.set(Number(line.slice(0, i)), line.slice(i + 1));
}
const text = fs.readFileSync(logFile || 0, 'utf8');
const used = [...new Set([...text.matchAll(/wasm-function\[(\d+)\]/g)].map((m) => Number(m[1])))];
const pretty = new Map();
let demangled = [];
try {
  demangled = execFileSync('c++filt', { input: used.map((n) => names.get(n) || '?').join('\n') }).toString().split('\n');
} catch { /* no c++filt: keep mangled names */ }
used.forEach((n, k) => pretty.set(n, demangled[k] || names.get(n) || '?'));
process.stdout.write(text.replace(/wasm-function\[(\d+)\]/g, (m, n) => `${m} ${pretty.get(Number(n))}`));

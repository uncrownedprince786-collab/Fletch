'use strict';
// Runs every *.test.js in this folder in turn. Each one spins up its own
// throwaway HTTP server, so they are self-contained and need no network.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;

(async () => {
  for (const file of files) {
    process.stdout.write(`\n── ${file} ${'─'.repeat(Math.max(0, 54 - file.length))}\n`);
    const code = await new Promise((resolve) => {
      const child = execFile(process.execPath, [path.join(__dirname, file)], { timeout: 300000 },
        (_err, stdout, stderr) => {
          process.stdout.write(stdout);
          if (stderr.trim()) process.stderr.write(stderr);
        });
      child.on('close', resolve);
    });
    if (code !== 0) { failed++; process.stdout.write(`   ✗ ${file} exited with ${code}\n`); }
  }

  process.stdout.write(`\n${failed ? `✗ ${failed} suite(s) failed` : `✓ all ${files.length} suites passed`}\n`);
  process.exitCode = failed ? 1 : 0;
})();

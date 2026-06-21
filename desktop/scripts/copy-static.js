// Copy non-TS renderer assets (HTML, CSS) into dist/ after tsc runs.
// Keeps the build dependency-free (no bundler).
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src", "renderer");
const outDir = path.join(__dirname, "..", "dist", "renderer");

fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith(".html") || file.endsWith(".css")) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  }
}
console.log("copied renderer assets -> dist/renderer");

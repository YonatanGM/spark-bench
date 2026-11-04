// Copies the pinned runtime files from node_modules into vendor/ so the site
// runs as plain static files (GitHub Pages) without a bundler.
import { cpSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const copies = [
  ["node_modules/three/build/three.module.min.js", "vendor/three/three.module.min.js"],
  ["node_modules/three/build/three.core.min.js", "vendor/three/three.core.min.js"],
  ["node_modules/three/examples/jsm/postprocessing/Pass.js", "vendor/three/addons/postprocessing/Pass.js"],
  ["node_modules/three/LICENSE", "vendor/three/LICENSE"],
  ["node_modules/@sparkjsdev/spark/dist/spark.module.min.js", "vendor/spark/spark.module.min.js"],
  ["node_modules/@sparkjsdev/spark/LICENSE", "vendor/spark/LICENSE"],
];
for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  console.log(`${from} -> ${to}`);
}

// package.json is "type": "module", so the CommonJS electron entry must be .cjs
import { renameSync } from 'node:fs';
renameSync('dist-electron/main.js', 'dist-electron/main.cjs');

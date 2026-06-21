import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, renameSync, writeFileSync } from 'fs';

const rootDir = resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: {
      '@browser': resolve(rootDir, 'extension/src/browser'),
      '@mcp': resolve(rootDir, 'extension/src/mcp'),
    },
    conditions: ['browser', 'module', 'import', 'default'],
    mainFields: ['browser', 'module', 'main'],
  },
  plugins: [
    {
      name: 'copy-extension-assets',
      closeBundle() {
        // Copy manifest
        copyFileSync(
          resolve(rootDir, 'extension/manifest.json'),
          resolve(rootDir, 'dist/manifest.json'),
        );
        // Copy icons (generate simple PNG placeholders if they don't exist)
        for (const icon of ['icon-32.png', 'icon-128.png']) {
          const src = resolve(rootDir, 'extension/public', icon);
          const dst = resolve(rootDir, 'dist', icon);
          try {
            copyFileSync(src, dst);
          } catch {
            // Generate a minimal 1x1 PNG placeholder
            const png = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              'base64',
            );
            writeFileSync(dst, png);
          }
        }
        // Copy buildDomTree.js (already in dist via publicDir, but ensure)
        try {
          copyFileSync(
            resolve(rootDir, 'extension/public/buildDomTree.js'),
            resolve(rootDir, 'dist/buildDomTree.js'),
          );
        } catch {
          // may already exist
        }
        // Rename background.iife.js to background.js (for manifest reference)
        const iife = resolve(rootDir, 'dist/background.iife.js');
        const bg = resolve(rootDir, 'dist/background.js');
        try {
          renameSync(iife, bg);
        } catch {
          // already renamed or doesn't exist
        }
      },
    },
  ],
  build: {
    lib: {
      formats: ['iife'],
      entry: resolve(rootDir, 'extension/src/background.ts'),
      name: 'BackgroundScript',
      fileName: 'background',
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      external: ['chrome'],
    },
  },
  define: {
    'import.meta.env.DEV': 'false',
  },
});

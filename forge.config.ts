import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import { buildWebPasteWorker } from './scripts/build-web-paste-worker';
import { packagePlaywrightCore } from './scripts/package-playwright';
import electronChecksums from 'electron/checksums.json';
import electronMetadata from 'electron/package.json';
import { verifiedElectronChecksums } from './scripts/electron-checksums';
const config: ForgeConfig = {
  hooks: {
    postPackage: async (_config, result) => {
      for (const folder of result.outputPaths)
        await copyFile(
          join(__dirname, 'config', '上传等待设置.json'),
          join(folder, '上传等待设置.json'),
        );
    },
    packageAfterCopy: async (_config, buildPath) => {
      await packagePlaywrightCore(__dirname, buildPath);
    },
    preStart: async () => {
      await buildWebPasteWorker();
    },
    prePackage: async () => {
      await buildWebPasteWorker();
    },
  },
  packagerConfig: {
    // Use the pinned Electron package's checksums, including for cache hits.
    // The packager otherwise fetches remote SHASUMS even for a cached ZIP.
    download: {
      checksums: verifiedElectronChecksums(
        electronMetadata.version,
        electronChecksums,
      ),
    },
    // Native Windows image codecs need their adjacent libvips DLLs on disk.
    asar: {
      unpack: '{**/{.**,**}/**/*.dll,**/node_modules/playwright-core/**}',
    },
    executableName: 'draft-assistant',
    extraResource: [
      'src/infrastructure/persistence/migrations',
      '.cache/web-paste-worker/web-paste-worker.cjs',
    ],
  },
  // better-sqlite3 13 ships Node-API v10 binaries; validate in Electron rather
  // than compiling this ABI-stable addon with an unrelated system compiler.
  rebuildConfig: {
    ignoreModules: ['better-sqlite3', 'sharp', '@img/sharp-win32-x64'],
  },
  makers: [new MakerZIP({}, ['win32'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      devServer: { host: '127.0.0.1' },
      devContentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://localhost:3000 ws://127.0.0.1:3000; img-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'",
      renderer: {
        config: rendererConfig,
        nodeIntegration: false,
        entryPoints: [
          {
            name: 'main_window',
            html: './src/renderer/index.html',
            js: './src/renderer/main.tsx',
            preload: { js: './src/desktop/preload/index.ts' },
          },
        ],
      },
    }),
  ],
};
export default config;

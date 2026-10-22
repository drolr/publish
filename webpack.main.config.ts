import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';
export const mainConfig: Configuration = {
  entry: './src/desktop/main/index.ts',
  externals: { 'playwright-core': 'commonjs playwright-core' },
  module: {
    rules: [
      ...rules,
      { test: /native_modules[/\\].+\.node$/, use: 'node-loader' },
      {
        test: /\.([cm]?js|node)$/,
        parser: { amd: false },
        use: {
          loader: '@vercel/webpack-asset-relocator-loader',
          options: { outputAssetBase: 'native_modules' },
        },
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.ts', '.tsx'],
    // The approved build target is Windows x64. Use the driver's static
    // platform entry to avoid bundling its optional source-build fallback.
    alias: { 'better-sqlite3$': 'better-sqlite3/win32-x64' },
  },
  devtool: 'source-map',
};

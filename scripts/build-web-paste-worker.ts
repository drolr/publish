import { resolve } from 'node:path';
import webpack from 'webpack';
import { rules } from '../webpack.rules';

export async function buildWebPasteWorker(): Promise<void> {
  const compiler = webpack({
    mode: 'production',
    target: 'node',
    entry: resolve('src/infrastructure/content/web-paste-worker.ts'),
    output: {
      path: resolve('.cache/web-paste-worker'),
      filename: 'web-paste-worker.cjs',
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules },
    externalsPresets: { node: true },
    devtool: false,
  });
  await new Promise<void>((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError || !stats || stats.hasErrors())
          reject(new Error('Web paste worker build failed'));
        else resolve();
      });
    });
  });
}

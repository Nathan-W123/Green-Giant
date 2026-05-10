const esbuild = require('esbuild');
const path = require('path');

const options = {
  entryPoints: [path.join(__dirname, 'content.js')],
  bundle: true,
  format: 'iife',
  outfile: path.join(__dirname, 'content.bundle.js'),
};

async function main() {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[build] Watching content.js');
    return;
  }

  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

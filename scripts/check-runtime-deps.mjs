/**
 * Assert that everything the built application imports at runtime is declared
 * in "dependencies", not "devDependencies".
 *
 * This exists because of a real outage in the local stack. The runtime image
 * installs with `npm ci --omit=dev`, so a dev dependency reached for at runtime
 * is simply absent, and the container crash-loops on start. Typecheck could not
 * see it (the package is installed in development), and the unit tests could
 * not see it (they run with everything installed). It is only visible at the
 * boundary between the dependency graph and the deployment.
 *
 * The check is static and takes about a second, so it runs in CI on every push
 * rather than waiting for a container to fall over.
 *
 * Note it deliberately reads the COMPILED output, not the TypeScript source:
 * `import type` is erased at compile time and is therefore safe, and only the
 * compiled output knows the difference.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const dev = new Set(Object.keys(pkg.devDependencies ?? {}));

const outDir = mkdtempSync(join(tmpdir(), 'runtime-deps-'));

try {
  // --removeComments so a package name mentioned in a comment cannot be
  // mistaken for an import.
  execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', outDir, '--removeComments'],
    { stdio: 'inherit' },
  );

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(outDir);

  const problems = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const patterns = [
      /\bfrom\s*["']([^"']+)["']/g,
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
      /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;

        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];

        if (declared.has(name)) continue;

        const where = file.slice(outDir.length + 1);
        problems.push(
          dev.has(name)
            ? `${where}: imports "${name}", which is a devDependency and will be absent from a production install`
            : `${where}: imports "${name}", which is not declared in package.json at all`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error('Runtime dependency check failed:\n');
    for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
    console.error('\nMove the package into "dependencies", or stop importing it at runtime.');
    process.exit(1);
  }

  console.log(`Runtime dependency check passed: ${files.length} files, all imports declared.`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

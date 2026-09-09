import { fileURLToPath } from 'node:url';

/**
 * Load a `.env` file from the project root, if one exists.
 *
 * Importing this module is the whole API: it runs once, for its side effect.
 *
 * It exists because `.env.example` told you to copy it to `.env` and then
 * nothing read the result, so every host-run command failed on configuration
 * that was sitting right there in the file. Instructions that produce a file
 * nobody loads are worse than no instructions.
 *
 * `process.loadEnvFile` is built into Node, so this needs no dependency and no
 * command-line flag. Real environment variables already set are not
 * overwritten, so Docker and CI, which set them directly and ship no `.env`,
 * are unaffected.
 *
 * The path is resolved relative to this module rather than the working
 * directory, so it behaves the same whether invoked through npm from the
 * project root or by an absolute path from somewhere else.
 */
const envPath = fileURLToPath(new URL('../.env', import.meta.url));

try {
  process.loadEnvFile(envPath);
} catch {
  // No .env is the normal case in a deployment. Nothing to do.
}

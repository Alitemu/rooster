/**
 * Runs once when the Next.js server process boots - see
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 *
 * Next.js bundles this file for both the Node.js and Edge runtimes (proxy.ts
 * runs on Edge), even though register() only ever executes the Node.js path
 * at runtime - so the Node-only bootstrap logic (better-sqlite3,
 * child_process, ...) has to live in a separate module that's only ever
 * imported from inside the runtime check below. Importing those modules
 * directly in this file, even dynamically, makes Next.js try to include them
 * in the Edge bundle too and fail: see instrumentation-node.ts for what
 * actually runs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runStartupBootstrap } = await import('./instrumentation-node');
  await runStartupBootstrap();
}

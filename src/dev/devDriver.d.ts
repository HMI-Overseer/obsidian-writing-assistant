/**
 * The compile-time gate on the live scenario driver (RFC-0013).
 *
 * `esbuild.config.mjs` defines it as a literal: `true` for a development or driver build,
 * `false` for a release. It is a constant rather than a runtime check on purpose, so a release
 * artifact has no branch to take and nothing to shake around: every guarded call site becomes
 * `if (false)` before tree-shaking runs.
 */
declare const DEV_DRIVER: boolean;

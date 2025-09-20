/**
 * ESBuild plugin to fix ONNX Runtime and transformers.js compatibility in Obsidian.
 *
 * WHY THIS WORKS:
 *
 * The core issue is that @huggingface/transformers detects the environment using:
 *   const IS_NODE_ENV = typeof process !== 'undefined' && process?.release?.name === 'node'
 *
 * In Obsidian's Electron renderer process:
 * - `process` object EXISTS (from Electron)
 * - `process.release.name` is 'node' (inherited from Electron's Node.js)
 * - This causes transformers.js to think it's in Node.js environment
 * - It then tries to load 'onnxruntime-node' which uses Node.js-specific APIs
 * - These APIs don't work in the renderer process, causing crashes
 *
 * THE FIX:
 * 1. Set `process.release` to undefined in esbuild config
 *    - This makes IS_NODE_ENV evaluate to false
 *    - transformers.js then treats it as a browser environment
 *    - It attempts to load 'onnxruntime-web' instead
 *
 * 2. This plugin redirects any remaining 'onnxruntime-node' imports to 'onnxruntime-web'
 *    - Provides an extra safety net
 *    - Ensures we always use the browser-compatible version
 *
 * This two-part fix ensures transformers.js works correctly in Obsidian's
 * hybrid Electron environment where we have partial Node.js APIs but need
 * browser-compatible implementations for ONNX runtime.
 */

export const onnxRedirectPlugin = {
  name: 'onnx-redirect',
  setup(build) {
    // Redirect onnxruntime-node to onnxruntime-web for browser compatibility
    // This handles any imports that slip through despite the process.release fix
    build.onResolve({ filter: /^onnxruntime-node$/ }, () => {
      // eslint-disable-next-line no-undef
      console.log(
        '[onnx-redirect] Redirecting onnxruntime-nodew to onnxruntime-web'
      );
      return {
        path: 'onnxruntime-web',
        external: false,
      };
    });
  },
};

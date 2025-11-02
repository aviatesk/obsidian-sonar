export interface WebGPUProbeResult {
  available: boolean;
  reason?: string;
  adapter?: any;
  device?: any;
  isFallbackAdapter?: boolean;
  features?: string[];
  limits?: Record<string, number>;
}

export interface WebGLProbeResult {
  available: boolean;
  version?: 'webgl' | 'webgl2';
  reason?: string;
  vendor?: string;
  renderer?: string;
}

export interface GraphicsProbeResult {
  webgpu: WebGPUProbeResult;
  webgl: WebGLProbeResult;
}

/**
 * Probe WebGPU availability and capabilities
 */
export async function probeWebGPU(): Promise<WebGPUProbeResult> {
  // 1) Check if navigator.gpu exists
  if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
    return { available: false, reason: 'navigator.gpu is not present' };
  }

  // 2) Request adapter (try high-performance first, then low-power)
  const gpu = (navigator as any).gpu;
  let adapter =
    (await gpu.requestAdapter?.({ powerPreference: 'high-performance' })) ??
    (await gpu.requestAdapter?.({ powerPreference: 'low-power' }));

  if (!adapter) {
    return { available: false, reason: 'GPUAdapter could not be acquired' };
  }

  // 3) Get available features
  const allFeatures = Array.from(adapter.features.values()) as string[];
  const reqCandidates = [
    'shader-f16',
    'timestamp-query',
    'depth-clip-control',
    'indirect-first-instance',
    'bgra8unorm-storage',
    'float32-filterable',
  ] as const;
  const requiredFeatures = reqCandidates.filter(f =>
    adapter.features.has(f as any)
  );

  // 4) Request device
  let device: any;
  try {
    device = await adapter.requestDevice({
      requiredFeatures: requiredFeatures as any,
    });
  } catch (e: any) {
    return {
      available: false,
      reason: `GPUDevice request failed: ${e?.message ?? e}`,
    };
  }

  // 5) Test if command queue actually works
  try {
    const encoder = device.createCommandEncoder();
    const cmd = encoder.finish();
    device.queue.submit([cmd]);
  } catch (e: any) {
    return {
      available: false,
      reason: `Command submission failed: ${e?.message ?? e}`,
    };
  }

  // 6) Collect limits
  const limits: Record<string, number> = {};
  for (const k of Object.keys(adapter.limits as any)) {
    limits[k] = (adapter.limits as any)[k];
  }

  return {
    available: true,
    adapter,
    device,
    isFallbackAdapter: (adapter as any).isFallbackAdapter ?? false,
    features: allFeatures,
    limits,
  };
}

/**
 * Probe WebGL availability and version
 */
export function probeWebGL(): WebGLProbeResult {
  if (typeof document === 'undefined') {
    return { available: false, reason: 'document is not available' };
  }

  const canvas = document.createElement('canvas');

  // Try WebGL2 first
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null =
    canvas.getContext('webgl2');
  if (gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      available: true,
      version: 'webgl2',
      vendor: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : undefined,
      renderer: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : undefined,
    };
  }

  // Fall back to WebGL1
  gl =
    (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
    (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
  if (gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      available: true,
      version: 'webgl',
      vendor: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : undefined,
      renderer: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : undefined,
    };
  }

  return { available: false, reason: 'WebGL context could not be created' };
}

/**
 * Probe both WebGPU and WebGL
 */
export async function probeGraphics(): Promise<GraphicsProbeResult> {
  const [webgpu, webgl] = await Promise.all([
    probeWebGPU(),
    Promise.resolve(probeWebGL()),
  ]);

  return { webgpu, webgl };
}

/**
 * Simple check for WebGPU availability (lightweight)
 */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
}

/**
 * Simple check for WebGL availability (lightweight)
 */
export function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return !!(
    canvas.getContext('webgl2') ||
    canvas.getContext('webgl') ||
    canvas.getContext('experimental-webgl')
  );
}

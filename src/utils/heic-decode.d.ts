declare module "libheif-js/wasm-bundle" {
  /** libheif built to WebAssembly; HeifDecoder.decode lists a file's images and frees the previous call's context. */
  const libheif: { ready: Promise<unknown>; HeifDecoder: new () => unknown };
  export default libheif;
}

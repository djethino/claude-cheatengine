// Lua sources are embedded in the bundle as text (esbuild loader '.lua': 'text')
declare module '*.lua' {
  const source: string;
  export default source;
}

/** Injected from package.json by scripts/build.mjs. */
declare const __CEMCP_VERSION__: string;

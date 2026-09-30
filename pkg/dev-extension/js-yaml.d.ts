// js-yaml ships no types and the extension has no @types/js-yaml, so every `import jsyaml`
// is an implicit-any error under build-pkg's type check (the dev server only transpiles, which
// is why this only ever shows up in a package build).
declare module 'js-yaml';

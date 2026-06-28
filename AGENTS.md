# AGENTS.md

## Stack

- **Runtime**: Bun / Node.js (ESM)
- **Language**: TypeScript 5.x (strict mode)
- **Build**: tsup (esbuild-based bundler)
- **Target**: ES2022
- **Plugin SDK**: @opencode-ai/plugin >=1.0.0

## Commands

```bash
bun run build       # Build with tsup → dist/
bun run typecheck   # TypeScript type checking (tsc --noEmit)
bun run deploy      # Build + copy to ~/.config/opencode/plugins/model-failover.js
```

## Installation note

OpenCode discovers local plugins via glob `{plugin,plugins}/*.{ts,js}` — only direct files in `plugins/`, not subdirectories (issue [#6866](https://github.com/anomalyco/opencode/issues/6866)). The deploy script copies `dist/index.js` → `~/.config/opencode/plugins/model-failover.js`.

## Project structure

```
src/
├── index.ts       # Main plugin — event handlers, failover logic
├── config.ts      # Configuration loading & model parsing
├── constants.ts   # HTTP status codes, error patterns, timing
dist/              # Build output (gitignored)
```

## Conventions

- Tabs for indentation, Allman braces
- `public` keyword explicit, `readonly` where applicable
- `and`/`or` instead of `&&`/`||` in PHP (not applicable here)
- English-only artifacts (code, comments, docs)
- No comments unless strictly necessary

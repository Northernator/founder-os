#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Generate standard package.json + tsconfig.json for pure TS packages
# Args: pkg_name, deps (space-separated), extra_deps_json
make_pkg() {
  local pkg="$1"
  local internal_deps="$2"
  local extra_json="$3"

  local deps_json=""
  for dep in $internal_deps; do
    deps_json+="    \"@founder-os/$dep\": \"workspace:*\",\n"
  done
  if [ -n "$extra_json" ]; then
    deps_json+="$extra_json"
  fi
  # trim trailing comma+newline
  deps_json=$(echo -e "$deps_json" | sed -e '$ s/,$//')

  cat > "packages/$pkg/package.json" <<EOF
{
  "name": "@founder-os/$pkg",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json --noEmit",
    "test": "echo test $pkg",
    "clean": "rimraf dist"
  },
  "dependencies": {
$(echo -e "$deps_json")
  }
}
EOF

  cat > "packages/$pkg/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
EOF
}

# Package: domain (no deps)
cat > packages/domain/package.json <<'EOF'
{
  "name": "@founder-os/domain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json --noEmit",
    "test": "echo test domain",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "zod": "^3.23.8"
  }
}
EOF

# logger: only zod-ish
cat > packages/logger/package.json <<'EOF'
{
  "name": "@founder-os/logger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json --noEmit",
    "test": "echo test logger",
    "clean": "rimraf dist"
  },
  "dependencies": {}
}
EOF

# shared tsconfig for all packages
for pkg in domain logger; do
  cat > "packages/$pkg/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
EOF
done

make_pkg "audit-contract" "domain" '    "zod": "^3.23.8"'
make_pkg "artifacts-core" "domain" '    "zod": "^3.23.8"'
make_pkg "handoff-contract" "domain artifacts-core audit-contract" '    "zod": "^3.23.8"'
make_pkg "pipeline-core" "domain" ""
make_pkg "branding-core" "domain" ""
make_pkg "branding-assets" "domain branding-core" ""
make_pkg "workspace-core" "domain artifacts-core handoff-contract" ""
make_pkg "prompts" "domain pipeline-core branding-core artifacts-core handoff-contract" ""

# workspace-node (needs node fs types)
make_pkg "workspace-node" "workspace-core domain artifacts-core handoff-contract logger" '    "chokidar": "^4.0.1"'
# add devdep @types/node
node -e "
const f='packages/workspace-node/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.devDependencies={'@types/node':'^22.15.3'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

# workspace-tauri (needs tauri plugins)
make_pkg "workspace-tauri" "workspace-core domain artifacts-core handoff-contract logger" '    "@tauri-apps/api": "^2.1.1",
    "@tauri-apps/plugin-fs": "^2.0.3"'

# db - drizzle + better-sqlite3
make_pkg "db" "domain artifacts-core audit-contract handoff-contract logger" '    "drizzle-orm": "^0.36.4",
    "better-sqlite3": "^11.5.0"'
node -e "
const f='packages/db/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.devDependencies={'@types/better-sqlite3':'^7.6.12','drizzle-kit':'^0.28.1'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

make_pkg "artifacts-index" "artifacts-core workspace-core db logger domain" ""

make_pkg "handoff-desktop" "handoff-contract workspace-tauri artifacts-core db logger domain" ""

make_pkg "handoff-vscode" "handoff-contract workspace-node artifacts-core audit-contract logger domain" ""
node -e "
const f='packages/handoff-vscode/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.devDependencies={'@types/node':'^22.15.3'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

make_pkg "pipeline-runner" "pipeline-core branding-core branding-assets artifacts-core artifacts-index handoff-contract handoff-desktop audit-contract prompts workspace-core db logger domain" ""

make_pkg "state" "domain" '    "zustand": "^5.0.3"'
node -e "
const f='packages/state/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.peerDependencies={'react':'^19.1.0'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

make_pkg "query" "domain db artifacts-core audit-contract handoff-contract logger" '    "@tanstack/react-query": "^5.75.5"'
node -e "
const f='packages/query/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.peerDependencies={'react':'^19.1.0'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

# UI packages need react + tsx
make_pkg "ui" "domain" '    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.5",
    "lucide-react": "^0.460.0"'
node -e "
const f='packages/ui/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.peerDependencies={'react':'^19.1.0','react-dom':'^19.1.0'};
p.devDependencies={'@types/react':'^19.1.2','@types/react-dom':'^19.1.2'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

make_pkg "chat-ui" "ui state domain artifacts-core handoff-contract" ""
node -e "
const f='packages/chat-ui/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.peerDependencies={'react':'^19.1.0'};
p.devDependencies={'@types/react':'^19.1.2'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

make_pkg "graph-ui" "ui domain pipeline-core artifacts-core audit-contract" '    "@xyflow/react": "^12.3.5"'
node -e "
const f='packages/graph-ui/package.json';
const p=JSON.parse(require('fs').readFileSync(f));
p.peerDependencies={'react':'^19.1.0','react-dom':'^19.1.0'};
p.devDependencies={'@types/react':'^19.1.2'};
require('fs').writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

echo "All package.json + tsconfig.json files generated"

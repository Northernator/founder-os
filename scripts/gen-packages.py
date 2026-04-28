#!/usr/bin/env python3
"""Generate package.json + tsconfig.json for all shared packages."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent.parent
PKG_DIR = ROOT / "packages"

TSCONFIG = {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": {"rootDir": "src", "outDir": "dist"},
    "include": ["src"],
}


def make_pkg(name, internal_deps=None, external_deps=None, dev_deps=None, peer_deps=None):
    internal_deps = internal_deps or []
    external_deps = external_deps or {}
    dev_deps = dev_deps or {}
    peer_deps = peer_deps or {}

    deps = {f"@founder-os/{d}": "workspace:*" for d in internal_deps}
    deps.update(external_deps)

    pkg = {
        "name": f"@founder-os/{name}",
        "version": "0.1.0",
        "private": True,
        "type": "module",
        "main": "./src/index.ts",
        "types": "./src/index.ts",
        "exports": {".": "./src/index.ts"},
        "scripts": {
            "typecheck": "tsc -p tsconfig.json --noEmit",
            "build": "tsc -p tsconfig.json --noEmit",
            "test": f"echo test {name}",
            "clean": "rimraf dist",
        },
    }

    if deps:
        pkg["dependencies"] = deps
    if dev_deps:
        pkg["devDependencies"] = dev_deps
    if peer_deps:
        pkg["peerDependencies"] = peer_deps

    pkg_dir = PKG_DIR / name
    pkg_dir.mkdir(parents=True, exist_ok=True)
    (pkg_dir / "package.json").write_text(json.dumps(pkg, indent=2) + "\n")
    (pkg_dir / "tsconfig.json").write_text(json.dumps(TSCONFIG, indent=2) + "\n")


REACT_PEER = {"react": "^19.1.0"}
REACT_FULL_PEER = {"react": "^19.1.0", "react-dom": "^19.1.0"}
REACT_DEV = {"@types/react": "^19.1.2"}
REACT_FULL_DEV = {"@types/react": "^19.1.2", "@types/react-dom": "^19.1.2"}

# --- Level 1: base ---
make_pkg("domain", external_deps={"zod": "^3.23.8"})
make_pkg("logger")

# --- Level 2: pure contracts & schemas ---
make_pkg("audit-contract", ["domain"], {"zod": "^3.23.8"})
make_pkg("artifacts-core", ["domain"], {"zod": "^3.23.8"})
make_pkg("handoff-contract", ["domain", "artifacts-core", "audit-contract"], {"zod": "^3.23.8"})
make_pkg("pipeline-core", ["domain"])
make_pkg("branding-core", ["domain"])
make_pkg("branding-assets", ["domain", "branding-core"])
make_pkg("workspace-core", ["domain", "artifacts-core", "handoff-contract"])
make_pkg(
    "prompts", ["domain", "pipeline-core", "branding-core", "artifacts-core", "handoff-contract"]
)

# --- Level 3: runtime adapters ---
make_pkg(
    "workspace-node",
    ["workspace-core", "domain", "artifacts-core", "handoff-contract", "logger"],
    {"chokidar": "^4.0.1"},
    dev_deps={"@types/node": "^22.15.3"},
)

make_pkg(
    "workspace-tauri",
    ["workspace-core", "domain", "artifacts-core", "handoff-contract", "logger"],
    {"@tauri-apps/api": "^2.1.1", "@tauri-apps/plugin-fs": "^2.0.3"},
)

make_pkg(
    "db",
    ["domain", "artifacts-core", "audit-contract", "handoff-contract", "logger"],
    {"drizzle-orm": "^0.36.4", "better-sqlite3": "^11.5.0"},
    dev_deps={"@types/better-sqlite3": "^7.6.12", "drizzle-kit": "^0.28.1"},
)

# --- Level 4: orchestrators ---
make_pkg("artifacts-index", ["artifacts-core", "workspace-core", "db", "logger", "domain"])
make_pkg(
    "handoff-desktop",
    ["handoff-contract", "workspace-tauri", "artifacts-core", "db", "logger", "domain"],
)
make_pkg(
    "handoff-vscode",
    ["handoff-contract", "workspace-node", "artifacts-core", "audit-contract", "logger", "domain"],
    dev_deps={"@types/node": "^22.15.3"},
)

make_pkg(
    "pipeline-runner",
    [
        "pipeline-core",
        "branding-core",
        "branding-assets",
        "artifacts-core",
        "artifacts-index",
        "handoff-contract",
        "handoff-desktop",
        "audit-contract",
        "prompts",
        "workspace-core",
        "db",
        "logger",
        "domain",
    ],
    dev_deps={"@types/node": "^22.15.3"},
)

# --- Level 4: UI-facing ---
make_pkg("state", ["domain"], {"zustand": "^5.0.3"}, peer_deps=REACT_PEER)
make_pkg(
    "query",
    ["domain", "db", "artifacts-core", "audit-contract", "handoff-contract", "logger"],
    {"@tanstack/react-query": "^5.75.5"},
    peer_deps=REACT_PEER,
)

make_pkg(
    "ui",
    ["domain"],
    {
        "class-variance-authority": "^0.7.1",
        "clsx": "^2.1.1",
        "tailwind-merge": "^2.5.5",
        "lucide-react": "^0.460.0",
    },
    peer_deps=REACT_FULL_PEER,
    dev_deps=REACT_FULL_DEV,
)

make_pkg(
    "chat-ui",
    ["ui", "state", "domain", "artifacts-core", "handoff-contract"],
    peer_deps=REACT_PEER,
    dev_deps=REACT_DEV,
)

make_pkg(
    "graph-ui",
    ["ui", "domain", "pipeline-core", "artifacts-core", "audit-contract"],
    {"@xyflow/react": "^12.3.5"},
    peer_deps=REACT_FULL_PEER,
    dev_deps=REACT_DEV,
)

print(f"Generated {len(list(PKG_DIR.glob('*/package.json')))} package.json files")

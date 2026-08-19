#!/usr/bin/env bash
# Runs once after the container is created (and after every rebuild).
set -euo pipefail

# Named volumes are created root-owned, and mounting into ~/.cache makes it root-owned too;
# everything below runs as `node`.
sudo mkdir -p /home/node/.cache /home/node/.config
sudo chown -R node:node \
  node_modules \
  apps/*/node_modules \
  packages/*/node_modules \
  services/*/node_modules \
  /home/node/.cache \
  /home/node/.config

# The image ships its own pnpm in /usr/local/share/npm-global/bin, which comes first on PATH — so
# the corepack shim has to land there to win. The version comes from package.json#packageManager.
corepack enable --install-directory /usr/local/share/npm-global/bin
corepack install

# The store has to sit on the same filesystem as node_modules or pnpm cannot hardlink into it —
# with node_modules on a volume and $HOME on another, pnpm would silently fall back to a
# `.pnpm-store/` inside the bind-mounted repo, which then trips `pnpm format`. Inside the root
# node_modules volume it is on the right device and survives rebuilds.
pnpm config set store-dir "$PWD/node_modules/.pnpm-store"

pnpm install --frozen-lockfile

# devcontainer.json puts node_modules/.bin on PATH, but a login shell re-prepends the image's own
# npm-global bin afterwards — which would shadow the workspace eslint/prettier/tsc with the image's
# versions. The shell rc files run last, so re-assert it there.
PATH_LINE="export PATH=\"$PWD/node_modules/.bin:\$PATH\""
for RC in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$RC" ] || continue
  grep -qxF "$PATH_LINE" "$RC" || printf '\n%s\n' "$PATH_LINE" >>"$RC"
done

# All values are optional for the fixture-driven tests, but FIRESTORE_EMULATOR_HOST must be set:
# it is the only thing keeping the Admin SDK off production Firestore.
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "Created .env.local from .env.example."
fi

cat <<'EOF'

Ready. Next:
  pnpm emulators                      # Firestore :8080, UI :4000
  pnpm seed:lots
  pnpm --filter @app/api dev          # :8081
  pnpm --filter @app/web dev          # :5173
EOF

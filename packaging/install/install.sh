#!/bin/sh
# Brigade installer for macOS / Linux.
#
# 1. Ensures Node.js >= 22.12 (installs the latest LTS into ~/.brigade/runtime if
#    yours is missing or too old).
# 2. Installs @spinabot/brigade globally via npm.
# 3. Puts npm's REAL global bin dir on your PATH and persists it to your shell rc
#    (creating the rc if needed) so `brigade` works in every new terminal.
#
#   curl -fsSL https://brigade.spinabot.com/install.sh | sh
#
# (Or directly from GitHub:)
#   curl -fsSL https://raw.githubusercontent.com/spinabot/brigade/main/packaging/install/install.sh | sh
set -eu

BRIGADE_PKG="@spinabot/brigade"
MIN_MAJOR=22
MIN_MINOR=12
RUNTIME_DIR="${HOME}/.brigade/runtime"
FALLBACK_NODE="v22.18.0"
NODE_FRESHLY_INSTALLED=0

# ASCII-only output: piped via `curl | sh` the bytes may be rendered under a
# non-UTF-8 locale, turning Unicode glyphs into mojibake (e.g. box-drawing chars). Plain
# ASCII renders correctly everywhere.
info() { printf '\033[1;33m>>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

need() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  need node || return 1
  v=$(node -v 2>/dev/null | sed 's/^v//')
  [ -n "$v" ] || return 1
  maj=${v%%.*}
  rest=${v#*.}
  min=${rest%%.*}
  if [ "$maj" -gt "$MIN_MAJOR" ]; then return 0; fi
  if [ "$maj" -eq "$MIN_MAJOR" ] && [ "$min" -ge "$MIN_MINOR" ]; then return 0; fi
  return 1
}

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) err "Unsupported OS: $os. Install Node ${MIN_MAJOR}.${MIN_MINOR}+ manually, then: npm i -g ${BRIGADE_PKG}"; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) err "Unsupported architecture: $arch. Install Node manually, then: npm i -g ${BRIGADE_PKG}"; exit 1 ;;
  esac
}

latest_lts() {
  # Newest LTS version (vXX.YY.ZZ) from the official dist index. Empty on failure.
  curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null \
    | tr '}' '\n' | grep '"lts":"' | grep -o '"version":"v[^"]*"' \
    | head -1 | cut -d'"' -f4 || true
}

install_node() {
  need curl || { err "curl is required to install Node. Install curl, or install Node ${MIN_MAJOR}.${MIN_MINOR}+ yourself."; exit 1; }
  detect_platform
  NV=$(latest_lts)
  [ -n "${NV:-}" ] || NV="$FALLBACK_NODE"
  TARBALL="node-${NV}-${OS}-${ARCH}.tar.gz"
  URL="https://nodejs.org/dist/${NV}/${TARBALL}"
  info "Installing Node ${NV} (${OS}-${ARCH}) into ${RUNTIME_DIR} ..."
  rm -rf "$RUNTIME_DIR"
  mkdir -p "$RUNTIME_DIR"
  TMP=$(mktemp -d)
  curl -fsSL "$URL" -o "${TMP}/${TARBALL}" || { err "Download failed: $URL"; rm -rf "$TMP"; exit 1; }
  tar -xzf "${TMP}/${TARBALL}" -C "$RUNTIME_DIR" --strip-components=1 || { err "Extract failed: $URL"; rm -rf "$TMP"; exit 1; }
  rm -rf "$TMP"
  # Make the just-installed Node the one used for the rest of this script.
  PATH="${RUNTIME_DIR}/bin:${PATH}"
  export PATH
  # Drop any cached command lookups so the freshly-installed node/npm are seen
  # (some shells cache a negative lookup from before the install).
  hash -r 2>/dev/null || true
  NODE_FRESHLY_INSTALLED=1
  # Verify completeness by running the binaries directly (not just `command -v`),
  # so a partial extract or arch mismatch fails HERE with a clear message rather
  # than later inside npm.
  "${RUNTIME_DIR}/bin/node" -v >/dev/null 2>&1 || { err "Node install incomplete or wrong arch: ${RUNTIME_DIR}/bin/node won't run."; exit 1; }
  "${RUNTIME_DIR}/bin/npm" -v >/dev/null 2>&1 || { err "Node install incomplete: ${RUNTIME_DIR}/bin/npm won't run."; exit 1; }
}

# Where `npm i -g` actually drops executables - DERIVED from npm, never assumed.
# Correct for the bundled runtime, Homebrew, nvm, a system package, etc.
npm_global_bin() {
  p=$(npm prefix -g 2>/dev/null || true)
  [ -n "${p:-}" ] || p="$RUNTIME_DIR"
  printf '%s/bin' "$p"
}

# Add $1 to PATH now AND persist it to the user's shell rc (creating the rc for
# the login shell if it doesn't exist - a fresh macOS account often has no
# ~/.zshrc, so "only update what exists" would persist nothing).
ensure_on_path() {
  dir="$1"
  [ -n "$dir" ] || return 0
  case ":${PATH}:" in
    *":${dir}:"*) ;;
    *) PATH="${dir}:${PATH}"; export PATH ;;
  esac
  line="export PATH=\"${dir}:\$PATH\""
  case "${SHELL:-}" in
    *zsh)  primary="$HOME/.zshrc" ;;
    *bash) primary="$HOME/.bashrc" ;;
    *)     primary="$HOME/.profile" ;;
  esac
  for rc in "$primary" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ "$rc" = "$primary" ] || [ -e "$rc" ] || continue
    grep -qF "$dir" "$rc" 2>/dev/null && continue
    printf '\n# Brigade (Node global bin)\n%s\n' "$line" >> "$rc"
  done
}

main() {
  info "Brigade installer"
  if node_ok; then
    info "Node $(node -v) detected - good."
  else
    if need node; then
      info "Node $(node -v) is too old (need ${MIN_MAJOR}.${MIN_MINOR}+)."
    else
      info "Node not found."
    fi
    install_node
  fi

  need npm || { err "npm is not available even after installing Node. Please report this."; exit 1; }

  # Node must be PROPER and on PATH BEFORE we touch Brigade: prove it runs, then
  # persist its global bin to the shell rc. Only then install @spinabot/brigade.
  node -v >/dev/null 2>&1 || { err "node is on PATH but won't run. Aborting before Brigade install."; exit 1; }
  npm  -v >/dev/null 2>&1 || { err "npm is on PATH but won't run. Aborting before Brigade install."; exit 1; }
  info "Node ready: $(node -v) (npm $(npm -v)) at $(command -v node)"
  ensure_on_path "$(npm_global_bin)"

  info "Installing ${BRIGADE_PKG} ..."
  if ! npm i -g "$BRIGADE_PKG"; then
    # Most common cause on a system Node: the global prefix isn't writable
    # (would need sudo). Fall back to a private, hermetic Node runtime instead
    # of asking for root - then everything lives under ~/.brigade.
    if [ "$NODE_FRESHLY_INSTALLED" -eq 0 ]; then
      info "Global install failed with your existing Node (often a permissions issue)."
      info "Installing a private Node runtime for Brigade and retrying ..."
      install_node
      ensure_on_path "$(npm_global_bin)"
      npm i -g "$BRIGADE_PKG"
    else
      err "npm could not install ${BRIGADE_PKG}. See the error above."
      exit 1
    fi
  fi

  # Re-affirm PATH after install (covers the fallback that switched to the
  # bundled Node, and confirms the brigade bin dir is persisted).
  GBIN="$(npm_global_bin)"
  ensure_on_path "$GBIN"

  printf '\n\033[1;32mOK: Brigade installed.\033[0m  (%s/brigade)\n' "$GBIN"
  # `curl | sh` runs in a SUBSHELL, so it cannot change the PATH of the terminal
  # you ran it from. We persisted it to your shell profile so NEW terminals find
  # brigade automatically. To use it in the terminal you're in RIGHT NOW, load
  # it into this session first. (We deliberately do NOT gate this on
  # `command -v brigade` - that would check this script's own PATH, not your
  # interactive shell, and lie, which is exactly the bug that hid this hint.)
  printf '\n   New terminals will find brigade automatically.\n'
  printf '   To use it in THIS terminal now, run:\n\n'
  printf '       \033[1mexport PATH="%s:$PATH" && brigade onboard\033[0m\n' "$GBIN"
}

main

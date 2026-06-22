#!/usr/bin/env bash
# Build + deploy to the `gh-pages` branch.
#
# Uses a throwaway git worktree so the gh-pages branch never touches the
# regular working tree. Authors the commit with the user's existing git
# identity (no special config needed) and pushes via the same SSH command
# already configured on this repo.
#
# First-run behaviour: if `gh-pages` doesn't exist on the remote yet, we
# create it as an orphan branch and push it. After that the GitHub Pages
# settings page on the repo will show it as a selectable source.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Refuse to deploy a dirty tree — that would put code on gh-pages that
# doesn't correspond to any commit anyone can later check out. Commit
# (or stash) every change first so what we ship is reproducible from
# the source branch.
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Refusing to deploy: working tree has uncommitted changes." >&2
    echo "Commit them first so the deployed build matches a real commit." >&2
    git status --short >&2
    exit 1
fi

# Push the source branch BEFORE building the gh-pages payload. The
# cardinal sin we're guarding against: code goes live on gh-pages that
# was never pushed to the public source-of-truth branch, so the public
# repo lags the live site and nobody can reproduce the deployed build.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "HEAD" ]; then
    echo "Refusing to deploy from a detached HEAD." >&2
    exit 1
fi
echo "==> git push origin $CURRENT_BRANCH"
git push origin "$CURRENT_BRANCH"

# Build the static bundle into ./build-web/.
echo "==> yarn build-web"
yarn build-web

if [ ! -f build-web/index.html ] || [ ! -f build-web/browser.js ]; then
    echo "Build output missing — expected build-web/index.html and build-web/browser.js." >&2
    exit 1
fi

# Throwaway worktree outside the project so nothing here can accidentally
# stage gh-pages content into main.
WORKTREE_DIR=$(mktemp -d -t vidgrid-gh-pages-XXXXXXXXXX)
trap '
    git worktree remove "$WORKTREE_DIR" --force >/dev/null 2>&1 || true
    rm -rf "$WORKTREE_DIR"
' EXIT

# Fetch the remote gh-pages branch if it already exists; otherwise create an
# orphan branch in the worktree.
if git ls-remote --exit-code --heads origin gh-pages >/dev/null 2>&1; then
    echo "==> Fetching existing gh-pages branch"
    git fetch --no-tags origin gh-pages:refs/remotes/origin/gh-pages
    git worktree add -B gh-pages "$WORKTREE_DIR" origin/gh-pages
else
    echo "==> No remote gh-pages yet — creating it"
    git worktree add --detach "$WORKTREE_DIR"
    (
        cd "$WORKTREE_DIR"
        git checkout --orphan gh-pages
        git rm -rf . >/dev/null 2>&1 || true
    )
fi

# Wipe the worktree (except .git) so removed files don't linger.
find "$WORKTREE_DIR" -mindepth 1 -maxdepth 1 -not -name '.git' -exec rm -rf {} +

# Copy only the artifacts we want served. (Avoid copying anything else that
# might have ended up in build-web/ during development — fixtures, etc.)
cp build-web/index.html "$WORKTREE_DIR/"
for js in build-web/*.js; do
    cp "$js" "$WORKTREE_DIR/"
done
if [ -d build-web/assets ]; then
    cp -r build-web/assets "$WORKTREE_DIR/"
fi

# .nojekyll tells GitHub Pages not to run Jekyll on the branch (otherwise
# files / dirs starting with `_` would be hidden, and Jekyll would silently
# rewrite some assets).
touch "$WORKTREE_DIR/.nojekyll"

# Forward CNAME (custom domain) to the served branch — GitHub Pages reads
# this file from the branch it's serving.
if [ -f CNAME ]; then
    cp CNAME "$WORKTREE_DIR/"
fi

cd "$WORKTREE_DIR"
git add -A
if git diff --cached --quiet; then
    echo "==> No changes to deploy."
    exit 0
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
git commit -m "Deploy $TS"
git push -u origin gh-pages

echo ""
echo "Pushed to gh-pages. After GitHub Pages is enabled on this branch the"
echo "site will be served at:"
echo ""
echo "  https://sliftist.github.io/vidgrid/"

#!/usr/bin/env bash
# deploy.sh — publish to npm + sync all three opencode plugin locations
# Usage: ./deploy.sh
set -e

VERSION=$(node -p "require('./package.json').version")
echo "📦 Publishing opencode-chat-channel@$VERSION to npm..."
npm publish --access public

echo ""
echo "🔄 Syncing ~/.cache/opencode (opencode runtime cache)..."
cd ~/.cache/opencode
bun add "opencode-chat-channel@$VERSION"
cd - > /dev/null

echo ""
echo "✅ Done! All locations updated to $VERSION:"
echo "   npm registry          → $VERSION"
echo "   ~/.cache/opencode     → $(cat ~/.cache/opencode/node_modules/opencode-chat-channel/package.json | grep '\"version\"' | tr -d ' "version:,')"
echo ""
echo "👉 Restart opencode to load the new version."

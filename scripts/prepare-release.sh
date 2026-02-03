#!/bin/bash
set -euo pipefail

# Usage: ./scripts/prepare-release.sh [major|minor|patch]
# Prepares a new release by bumping version and updating CHANGELOG.md

BUMP_TYPE="${1:-}"

if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Usage: $0 [major|minor|patch]"
  exit 1
fi

# Run build, checks, and tests before proceeding
echo "Running build..."
npm run build
echo ""
echo "Running checks..."
npm run check
echo ""
echo "Running tests..."
npm run test
echo ""

# Get current version from manifest.json
CURRENT_VERSION=$(jq -r '.version' manifest.json)
echo "Current version: $CURRENT_VERSION"

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Bump version
case "$BUMP_TYPE" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

# Update manifest.json
MANIFEST_CONTENT=$(jq --arg v "$NEW_VERSION" '.version = $v' manifest.json)
echo "$MANIFEST_CONTENT" > manifest.json
echo "Updated manifest.json"

# Update package.json and package-lock.json
PACKAGE_CONTENT=$(jq --arg v "$NEW_VERSION" '.version = $v' package.json)
echo "$PACKAGE_CONTENT" > package.json
npm install --package-lock-only --silent
echo "Updated package.json and package-lock.json"

# Update CHANGELOG.md using awk
CHANGELOG_CONTENT=$(awk -v new_ver="$NEW_VERSION" '
/^## Unreleased$/ {
  # Print new Unreleased section
  print "## Unreleased"
  print ""
  print "Diff:"
  print "[`" new_ver "...HEAD`](https://github.com/aviatesk/obsidian-sonar/compare/" new_ver "...HEAD)"
  print ""
  # Print the new version header
  print "## " new_ver
  next
}
/\.\.\.HEAD`\]/ {
  # Update diff link from PREV...HEAD to PREV...new_ver
  gsub(/\.\.\.HEAD`\]/, "..." new_ver "`]")
}
/\.\.\.HEAD\)/ {
  # Update diff URL from PREV...HEAD to PREV...new_ver
  gsub(/\.\.\.HEAD\)/, "..." new_ver ")")
}
{ print }
' CHANGELOG.md)
echo "$CHANGELOG_CONTENT" > CHANGELOG.md
echo "Updated CHANGELOG.md"

# Show diff for review
echo ""
echo "=== Changes ==="
git --no-pager diff manifest.json package.json package-lock.json CHANGELOG.md

echo ""
echo "=== Next steps ==="
echo "1. Review the changes above"
echo "2. Run the following commands to complete the release:"
echo ""
echo "   git add manifest.json package.json package-lock.json CHANGELOG.md"
echo "   git commit -m \"release: Bump version to $NEW_VERSION\""
echo "   git tag $NEW_VERSION"
echo "   git push origin master --tags"

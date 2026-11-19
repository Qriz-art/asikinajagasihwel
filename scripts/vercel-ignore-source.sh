#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse HEAD^ >/dev/null 2>&1; then
  echo "No parent commit; building."
  exit 1
fi

changed="$(git diff --name-only HEAD^ HEAD)"

if [ -z "$changed" ]; then
  echo "No changed files; skipping build."
  exit 0
fi

while IFS= read -r file; do
  case "$file" in
    data/*)
      ;;
    .github/*)
      ;;
    README.md)
      ;;
    .gitignore)
      ;;
    .env.example)
      ;;
    *)
      echo "Build required: $file"
      exit 1
      ;;
  esac
done <<< "$changed"

echo "Only data or documentation changed; skipping build."
exit 0

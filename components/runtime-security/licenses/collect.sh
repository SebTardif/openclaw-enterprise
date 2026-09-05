#!/bin/sh
# Bundle notices from the actual linked module graph and selected Go toolchain.
# Run from the runtime-security module root after dependencies are downloaded.
set -eu

destination=$1
mkdir -p "$destination/modules" "$destination/openshell" "$destination/go"
cp openshell/pb/LICENSE openshell/pb/NOTICE.md "$destination/openshell/"
cp "$(go env GOROOT)/LICENSE" "$(go env GOROOT)/PATENTS" "$destination/go/"

listing=$(mktemp)
trap 'rm -f "$listing" "$listing.sorted" "$listing.notices"' EXIT
CGO_ENABLED=0 go list -mod=readonly -deps -f '{{if .Module}}{{if not .Module.Main}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}{{end}}' ./cmd/oce-runtime-security > "$listing"
sort -u "$listing" > "$listing.sorted"
: > "$destination/modules.tsv"
while read -r module version directory; do
  [ -n "$module" ] || continue
  [ -d "$directory" ]
  printf '%s\t%s\n' "$module" "$version" >> "$destination/modules.tsv"
  # Some linked packages carry their own notice, such as go-jose/json.
  find "$directory" -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -iname 'COPYING*' -o -name 'PATENTS' \) > "$listing.notices"
  [ -s "$listing.notices" ]
  while IFS= read -r notice; do
    relative=${notice#"$directory"/}
    target="$destination/modules/$module/$relative"
    mkdir -p "$(dirname "$target")"
    cp "$notice" "$target"
  done < "$listing.notices"
done < "$listing.sorted"

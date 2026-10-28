#!/usr/bin/env bash
set -euo pipefail

# Run from the project with: devenv shell -- bash papers/build.sh
# Install Typst and the TeX Gyre Termes and Cursor fonts first.
# Extra arguments, such as --font-path, go to each Typst call.
paper_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
typst_bin=${PAPERS_TYPST:-typst}
for paper_dir in "$paper_root"/[0-9][0-9]-*; do
  "$typst_bin" compile --root "$paper_dir" "$@" "$paper_dir/main.typ" "$paper_dir/paper.pdf"
  printf 'Built %s\n' "${paper_dir##*/}"
done
"$typst_bin" compile --root "$paper_root" "$@" "$paper_root/index.typ" "$paper_root/index.pdf"

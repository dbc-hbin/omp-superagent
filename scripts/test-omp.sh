#!/usr/bin/env bash
# Run CI with a stock release in a private directory, without replacing the user's OMP.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ $# -gt 1 || ${OMP_TEST_COMMAND+x} ]]; then
  echo 'Usage: bash scripts/test-omp.sh [release-tag]; use bun run test:ci for OMP_TEST_COMMAND overrides.' >&2
  exit 2
fi
tag=${1-"$(bun --no-env-file -p '"v" + require("./package.json").dependencies["@oh-my-pi/pi-coding-agent"]')"}
if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected an exact OMP release tag; got '$tag'." >&2
  exit 2
fi
# Install dependencies and build both Superagent executables before the test CLI exists.
bun install --frozen-lockfile
platform=$(bun --no-env-file -p '`${process.platform}-${process.arch}`')
for binary in "host-owner/bin/omp-host-owner-$platform" "gateway/bin/omp-gateway-$platform"; do
  if [[ ! -x $binary ]]; then
    echo "Source installation did not create an executable $binary." >&2
    exit 1
  fi
done
asset=$(bun --no-env-file -p '`omp-${process.platform}-${process.arch}`')
directory=$(mktemp -d "${TMPDIR:-/tmp}/omp-sa-test-cli.XXXXXXXX")
trap 'rm -rf -- "$directory"' EXIT
url="https://github.com/can1357/oh-my-pi/releases/download/$tag"
echo "Testing stock OMP $tag ($asset)"
for file in SHA256SUMS.txt "$asset"; do
  curl --fail --silent --show-error --location "$url/$file" --output "$directory/$file"
done
(
  cd -- "$directory"
  grep -E "^[[:xdigit:]]{64}  $asset\$" SHA256SUMS.txt | shasum -a 256 -c -
  mv -- "$asset" omp
  chmod 700 omp
)
actual=$("$directory/omp" --version)
if [[ $actual != "omp/${tag#v}" ]]; then
  echo "OMP release $tag reported '$actual'; refusing to test a different version." >&2
  exit 1
fi
# The frozen source install above already built and staged both native binaries.
PATH="$directory:$PATH" bun --no-env-file scripts/ci.ts

#!/bin/bash
# Build the Debian (trixie, arm64) root filesystem tarball for the
# ios-linuxkit Debian edition. Needs Docker on an arm64 Linux host
# (GitHub's ubuntu-24.04-arm runner) and passwordless sudo.
#
#   scripts/debian-rootfs/build.sh out/debian-arm64-rootfs.tar.gz
set -euo pipefail

out=$(realpath -m "${1:-debian-arm64-rootfs.tar.gz}")
here=$(cd "$(dirname "$0")" && pwd)
image=${DEBIAN_IMAGE:-debian:trixie-slim}
name=linuxkit-rootfs-$$
work=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; sudo rm -rf "$work"' EXIT

docker run --name "$name" --platform linux/arm64 \
    -v "$here/setup.sh:/linuxkit-setup.sh:ro" \
    "$image" bash /linuxkit-setup.sh

mkdir -p "$work/root"
docker export "$name" | sudo tar -xp --numeric-owner -C "$work/root"

# Docker leaves bind-mount placeholders and its own marker behind.
sudo rm -f "$work/root/.dockerenv" "$work/root/linuxkit-setup.sh"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tlinuxkit\n::1\t\tlocalhost ip6-localhost ip6-loopback\n' \
    | sudo tee "$work/root/etc/hosts" >/dev/null
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' \
    | sudo tee "$work/root/etc/resolv.conf" >/dev/null

# Sanity checks: right architecture, entry points present.
file -L "$work/root/usr/bin/bash" | grep -q 'ARM aarch64'
test -x "$work/root/usr/local/bin/linuxkit-login"
test -e "$work/root/usr/sbin/init"

mkdir -p "$(dirname "$out")"
sudo tar --numeric-owner -czf "$out" -C "$work/root" .
sudo chown "$(id -u):$(id -g)" "$out"
ls -lh "$out"
sha256sum "$out"

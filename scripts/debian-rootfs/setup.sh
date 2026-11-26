#!/bin/bash
# Runs INSIDE an arm64 debian:trixie-slim container and turns it into the
# ios-linuxkit Debian edition userland. See build.sh.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- App overlay files -----------------------------------------------------
# app/RootfsPatch.bundle/files is mounted at /linuxkit-overlay. The app also
# writes these into existing installs on update, so this is the single source
# for linuxkit-login, /etc/profile.d/linuxkit.sh, apt cache settings, ...
tar -C /linuxkit-overlay --exclude=./etc/resolv.conf -cf - . | tar -C / -xf - --keep-directory-symlink --no-same-owner  # resolv.conf is a Docker bind mount; build.sh writes it
chmod 755 /usr/local/bin/linuxkit-login

# --- apt/dpkg tuning for the emulator ------------------------------------
# Download as root (no privilege drop to _apt), no fsync storms, no recommends.
cat > /etc/apt/apt.conf.d/99linuxkit <<'EOF'
APT::Sandbox::User "root";
APT::Install-Recommends "false";
APT::Install-Suggests "false";
Acquire::Retries "3";
Acquire::Languages "none";
EOF
echo 'force-unsafe-io' > /etc/dpkg/dpkg.cfg.d/99linuxkit
# Keep indexes uncompressed (plain text) to avoid a decompression step on
# every apt run; downloads stay xz/gz.
rm -f /etc/apt/apt.conf.d/docker-gzip-indexes
cat > /etc/apt/apt.conf.d/98linuxkit-indexes <<'EOF'
Acquire::GzipIndexes "false";
Acquire::CompressionTypes::Order { "xz"; "gz"; };
EOF

apt-get update
apt-get install -y \
    bash bash-completion ca-certificates curl wget git nano less file \
    unzip xz-utils procps psmisc iproute2 iputils-ping netcat-openbsd \
    bind9-dnsutils nmap openssh-client python3 htop busybox tini

# --- PID 1 ---------------------------------------------------------------
# ios-linuxkit boots /sbin/init and parents every terminal to it, so init must
# stay alive and reap children. Prefer busybox init (what the Alpine image
# uses); fall back to tini if this busybox build has no init applet.
rm -f /usr/sbin/init
if busybox --list | grep -qx init; then
    ln -s /bin/busybox /usr/sbin/init
    printf '::sysinit:/bin/true\n' > /etc/inittab
else
    cat > /usr/sbin/init <<'EOF'
#!/bin/sh
exec /usr/bin/tini -- /bin/sh -c 'trap "" HUP INT; while :; do sleep 86400; done'
EOF
    chmod 755 /usr/sbin/init
fi

# --- fetch (areofyl/fetch, AUR fetch-git) -----------------------------------
# Animated 3D distro-logo fetch shown when a terminal starts (linuxkit-login).
FETCH_COMMIT=ce8b8dcdc62cfe552d0b810887504995daffe870
apt-get install -y gcc make libc6-dev
git clone https://github.com/areofyl/fetch.git /tmp/fetch
git -C /tmp/fetch checkout "$FETCH_COMMIT"
make -C /tmp/fetch PREFIX=/usr/local install
apt-get purge -y --auto-remove gcc make libc6-dev
rm -rf /tmp/fetch
/usr/local/bin/fetch --version

# --- Home directory ----------------------------------------------------------
# Shells start in /home/larp (root keeps uid 0, but this is its home).
mkdir -p /home/larp
cp -a /etc/skel/. /home/larp/ 2>/dev/null || true
cp -a /root/.bashrc /root/.profile /home/larp/ 2>/dev/null || true
# usermod refuses here (root is PID 1 in the build container); edit passwd.
sed -i -E 's|^(root:[^:]*:0:0:[^:]*:)/root:|\1/home/larp:|' /etc/passwd
grep -q '^root:[^:]*:0:0:[^:]*:/home/larp:' /etc/passwd

# Coloured prompt/ls for root.
cat >> /home/larp/.bashrc <<'EOF'
export LS_OPTIONS='--color=auto'
alias ls='ls $LS_OPTIONS'
alias ll='ls $LS_OPTIONS -l'
alias la='ls $LS_OPTIONS -A'
PS1='\[\e[1;31m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
[ -f /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion
EOF

echo linuxkit > /etc/hostname

# --- Shrink ----------------------------------------------------------------
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /tmp/* /var/tmp/* /var/log/*.log

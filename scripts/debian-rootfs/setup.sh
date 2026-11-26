#!/bin/bash
# Runs INSIDE an arm64 debian:trixie-slim container and turns it into the
# ios-linuxkit Debian edition userland. See build.sh.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- apt/dpkg tuning for the emulator ------------------------------------
# Download as root (no privilege drop to _apt), no fsync storms, no recommends.
cat > /etc/apt/apt.conf.d/99linuxkit <<'EOF'
APT::Sandbox::User "root";
APT::Install-Recommends "false";
APT::Install-Suggests "false";
Acquire::Retries "3";
Acquire::Languages "none";
// The emulator's mremap() cannot grow apt's cache map ("Dynamic MMap ran out
// of room" -> "Problem with MergeList"). Reserve enough up front that it never
// has to grow; guest address space is reserved lazily, so this is cheap.
APT::Cache-Start "268435456";
APT::Cache-Grow "0";
APT::Cache-Limit "536870912";
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

# --- Terminal session entry point ------------------------------------------
# The app starts each terminal with only TERM set. Debian's /bin/login needs
# PAM/loginuid, which the emulator does not provide, so log in by hand.
cat > /usr/local/bin/linuxkit-login <<'EOF'
#!/bin/sh
export HOME=/root USER=root LOGNAME=root SHELL=/bin/bash
export LANG=C.UTF-8
cd "$HOME" 2>/dev/null || cd /
exec /bin/bash -l
EOF
chmod 755 /usr/local/bin/linuxkit-login

cat > /etc/profile.d/linuxkit.sh <<'EOF'
# ios-linuxkit Debian edition
# User-installed tools (Claude Code's native installer, pipx, ...).
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
# iOS forbids raw sockets for every app, so nmap must use connect() scans.
alias nmap='nmap --unprivileged'
if [ -n "$PS1" ] && [ -z "$LINUXKIT_WELCOMED" ]; then
    export LINUXKIT_WELCOMED=1
    echo "Debian $(cat /etc/debian_version) (arm64) on ios-linuxkit"
    echo "Run 'apt update' before installing packages. nmap: use -sT (no raw sockets on iOS)."
fi
EOF

# Coloured prompt/ls for root.
cat >> /root/.bashrc <<'EOF'
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

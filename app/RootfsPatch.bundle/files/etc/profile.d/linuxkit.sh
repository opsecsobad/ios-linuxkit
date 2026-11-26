# ios-linuxkit Debian edition (shipped by the app's rootfs overlay).
# User-installed tools (Claude Code's native installer, pipx, ...).
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
# iOS forbids raw sockets for every app, so nmap must use connect() scans.
alias nmap='nmap --unprivileged'

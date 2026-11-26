# LinuxKit Debian edition

Fork of [rcarmo/ios-linuxkit](https://github.com/rcarmo/ios-linuxkit) (itself derived from iSH) that
ships an iOS terminal app whose default root filesystem is **Debian trixie arm64** with bash + apt.
Goal: a Termux-like terminal on a non-jailbroken iPhone — bash, apt, networking tools (nmap, curl,
git, ssh) and, ideally, the Claude Code CLI.

- Fork: `opsecsobad/ios-linuxkit`, working branch **`debian-edition`** (`master` tracks upstream).
- Upstream remote: `upstream` → `rcarmo/ios-linuxkit`. Keep our diff small and rebase-friendly.

## How it works

- The app runs **AArch64 Linux user space in an interpreter** (Asbestos threaded-code gadgets) with a
  userspace Linux syscall layer (`kernel/`, `fs/`). No JIT, no VM. Everything runs inside the iOS
  sandbox of one app process; guest "root" is only root inside the fakefs.
- Root filesystem: `scripts/debian-rootfs/setup.sh` (runs inside `debian:trixie-slim` arm64) +
  `scripts/debian-rootfs/build.sh` (docker export → `debian-arm64-rootfs.tar.gz`). The tarball is
  bundled as `LinuxKit.app/root.tar.gz` by `app/download-root.sh` (`ROOTFS_FILE` + `ROOTFS_SHA256`).
- Boot: `/sbin/init` = busybox init with a one-line `/etc/inittab`. Each terminal runs
  `/usr/local/bin/linuxkit-login` (sets HOME/USER, `exec bash -l`) — default set in
  `app/UserPreferences.m`. Debian's `/bin/login` is not used (PAM/loginuid don't work here).
- Storage: `ContainerURL()` in `app/AppGroup.m` falls back to Application Support when the
  app-group container is missing (SideStore signs without the app-group entitlement).
- Terminal UI: `app/Terminal.m` hosts xterm.js in a WKWebView (`app/terminal/xterm-term*.{html,js}`).

## Build — there is no Mac

The developer machine is Arch Linux x86_64; iOS builds only happen in GitHub Actions:

- `.github/workflows/build-debian-ipa.yml`: job `rootfs` (ubuntu-24.04-arm, Docker) → job `ipa`
  (macos-26, `xcodebuild -scheme iSH-ARM64 -configuration Release CODE_SIGNING_ALLOWED=NO`) →
  unsigned `LinuxKit-Debian.ipa`, published as pre-release `debian-build-<run_number>`.
- Push to `debian-edition` triggers it. Watch with
  `gh run watch <id> -R opsecsobad/ios-linuxkit --exit-status` (run it in the background; macOS runners queue).
- Never use the inherited Fastlane lanes (they target upstream iSH).

## Testing on the device

- Target: iPhone 12 Pro (iPhone13,3), iOS 27.0.1, connected over USB (libimobiledevice works).
- Install: user downloads the IPA from the GitHub release in Safari and installs with **SideStore**
  (free Apple ID: 3 sideloaded apps max, 7-day expiry). Uninstall the old build first.
- Crash logs: `idevicecrashreport -k -e -f LinuxKit <dir>`. Uncaught ObjC exceptions are encoded by
  iSH as one-letter stack frames — decode the faulting thread's symbols in order to read
  "Name|REASON__|message|BACKTRACE__|...".
- Live logs: `idevicesyslog -p LinuxKit`.
- I cannot see the phone screen; the user sends screenshots.

## Known iOS limits (not bugs)

- No raw sockets → nmap only with `--unprivileged` / `-sT` (aliased in `/etc/profile.d/linuxkit.sh`).
- No JIT → everything is interpreted and slow; V8/JSC run with JIT disabled.
- No real root over iOS, no monitor mode, no kernel modules, no Docker.

## Conventions

- Commit messages end with the Co-Authored-By line the session provides; push only to `debian-edition`.
- When changing guest-visible behaviour in the emulator (`kernel/`, `fs/`), match real Linux semantics
  (errno values, argument handling) — Debian's glibc binaries are less forgiving than Alpine's musl.
- Do not commit IPAs, rootfs tarballs or crash logs.

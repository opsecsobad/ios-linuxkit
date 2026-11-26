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
  `/usr/local/bin/linuxkit-login` (HOME=/home/larp, runs `fetch`, `exec bash -l`) — default set in
  `app/UserPreferences.m`. Debian's `/bin/login` is not used (PAM/loginuid don't work here).
- **Rootfs overlay = how changes reach existing installs.** Files in `app/RootfsPatch.bundle/files`
  listed in `manifest.plist` (optional octal `mode`) are written into the user's existing Debian on
  launch whenever `version` increases (`FsApplyOverlay` in `app/CurrentRoot.m`). Bump `version`
  for every change. `setup.sh` copies the same tree into fresh rootfs builds, so it is the single
  source for `linuxkit-login`, `/etc/profile.d/linuxkit.sh`, apt cache config. `fetch` (areofyl/fetch,
  pinned commit in `setup.sh`) is compiled in the rootfs job and injected into the bundle by CI.
- Scrolling: swipes scroll xterm's scrollback, except in full-screen/mouse-mode apps (Claude Code,
  less, tmux) where `sendWheel` dispatches wheel events (with `disableStdin` briefly lifted) so
  xterm encodes mouse-wheel reports / arrow keys. Selection: iOS-style handles in the same file.
- Files: app Documents is bind-mounted at `/mnt/iPhone` (`iosfs_init` in `app/iOSFS.m`), visible in
  Files → On My iPhone → LinuxKit; `~/iPhone` symlink from `linuxkit-login`. Settings → Mounts adds
  any Files folder under `/mnt/<name>`. Multiple shells: tmux (`/etc/tmux.conf` from the overlay).
- App QoL defaults: screen stays awake (`shouldDisableDimming` default YES), Fira Code Nerd Font,
  Ctrl+/Ctrl- font size, Ctrl+0 reset (`adjustFontSizeBy:`/`resetFontSize` in `app/TerminalView.m`), long-press menu "Copy All",
  background keep-alive via coarse location updates (`BackgroundKeepAlive` in `app/AppDelegate.m`),
  accessory-bar overlap fix (`updateAccessoryBarOverlap` in `app/TerminalViewController.m`).
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

## Linux smoke test (use this first)

`.github/workflows/smoke-test-debian.yml` builds the Linux CLI emulator on `ubuntu-24.04-arm`, imports
the same Debian rootfs and runs `scripts/debian-rootfs/smoke.sh` (threads, DNS, curl, apt, nmap,
Claude Code install). Failing tests are rerun with a `-Dlog=strace` build; logs are in the
`smoke-logs` artifact (`gh run download <id> -n smoke-logs`). Most guest bugs reproduce here — much
faster than an iPhone round-trip.

## Emulator bugs found so far

- `clone3` returned EINVAL → every glibc `pthread_create` failed. Now returns ENOSYS for anything
  `clone()` can't express so glibc falls back (`kernel/fork.c`).
- `mremap()` growth of an anonymous mapping returns EFAULT unless every page has identical pt flags
  (`kernel/mmap.c`). apt's cache hit this ("Dynamic MMap ran out of room" → "Problem with
  MergeList"); worked around with `APT::Cache-Start "268435456"` in `/etc/apt/apt.conf.d/99linuxkit`.
  A real fix in `sys_mremap` would help other programs too.
- (Earlier suspicion that lz4 decompression is broken was wrong — it was the mremap bug. Indexes
  are still stored uncompressed via `98linuxkit-indexes`.)
- `setsockopt(SO_BINDTODEVICE, "")` returned EINVAL (nmap error spam) — now accepted (`fs/sock.c`).

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

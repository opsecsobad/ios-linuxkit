#!/bin/bash
# Run the Debian edition rootfs inside the Linux CLI build of the emulator and
# exercise the things users hit first: threads, DNS, HTTPS, apt, nmap.
#   scripts/debian-rootfs/smoke.sh <ish-binary> <fakefs-dir> [<strace-ish-binary>]
set -uo pipefail
ish=$1 fs=$2 strace_ish=${3:-}

run() {
    local name=$1; shift
    echo "::group::$name"
    echo "\$ $*"
    timeout 600 "$ish" -f "$fs" /usr/bin/env -i HOME=/root TERM=dumb \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        /bin/bash -c "$*"
    local rc=$?
    echo "::endgroup::"
    echo "RESULT $name rc=$rc" | tee -a smoke-results.txt
    if [ $rc -ne 0 ] && [ -n "$strace_ish" ]; then
        echo "--- strace rerun of $name ---" > "strace-$name.log"
        timeout 600 "$strace_ish" -f "$fs" /usr/bin/env -i HOME=/root TERM=dumb \
            PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
            /bin/bash -c "$*" >> "strace-$name.log" 2>&1
        tail -n 60 "strace-$name.log"
    fi
}

: > smoke-results.txt
run uname       'uname -a; cat /etc/debian_version; ulimit -a'
run thread      'python3 -c "import threading; t=threading.Thread(target=lambda: print(\"thread ok\")); t.start(); t.join()"'
run dns         'getent hosts deb.debian.org'
run curl        'curl -sS -o /dev/null -w "%{http_code}\n" https://deb.debian.org/debian/'
run apt-update  'apt-get update'
run apt-install 'apt-get install -y sl && /usr/games/sl -h >/dev/null 2>&1; dpkg -s sl | head -2'
run nmap        'nmap --unprivileged -sT -Pn -p 22,80,443 scanme.nmap.org'
cat smoke-results.txt

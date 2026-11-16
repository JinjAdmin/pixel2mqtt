#!/bin/sh
# Host test: build pixeld (from a pixeld-h6631 checkout) for x86_64 with a stub panel and run it in an
# unprivileged user+mount+network namespace with a fake root, then run tests/test_host.py against it.
#
#   tests/run_pixeld_host.sh <pixeld-h6631 dir> [<usr/res mirror dir>]
#
# Needs: zig (ZIG env var, default ~/zig/zig), util-linux unshare, iproute2, python3 >= 3.8.
# The optional mirror is a copy of a display's /usr/res (stock artwork: keep it private). With it, the
# test also runs the built-in-artwork importer and checks the output against <mirror>/../anims and ../icons
# if those exist.
set -e
GPL=$(cd "$1" && pwd); RES=${2:+$(cd "$2" && pwd)}
HERE=$(cd "$(dirname "$0")/.." && pwd)
ZIG=${ZIG:-$HOME/zig/zig}
W=$(mktemp -d /tmp/p2mtest.XXXXXX)
echo "work dir $W"
"$ZIG" cc -target x86_64-linux-musl -static -O1 -DPIXELD_STUB_DISPLAY -o "$W/pixeld" "$GPL/src/pixeld.c" -lm
R=$W/root
mkdir -p $R/data/custom/sounds $R/mnt/UDISK/anims $R/mnt/UDISK/icons $R/usr/res $R/tmp $R/dev $R/sys/class/net/wlan0 $R/etc
cp "$W/pixeld" $R/pixeld
echo "02:00:00:aa:bb:cc" > $R/sys/class/net/wlan0/address
printf 'normal' > $R/tmp/wifi_mode
mkdir -p $R/mnt/UDISK/data/big_data            # fake Govee-app scene cache (synthetic bytes)
printf 'P]GIF89a-synthetic-test-data' > $R/mnt/UDISK/data/big_data/cached1
printf 'SQLite format 3' > $R/mnt/UDISK/data/multimedia.db
cat > $W/inner.sh <<EOF
set -e
ip link set lo up
mount --rbind /dev $R/dev
if [ -n "$RES" ]; then
  mount -t tmpfs tmpfs $R/usr/res
  for d in "$RES"/*; do mkdir -p "$R/usr/res/\$(basename "\$d")"; mount --bind "\$d" "$R/usr/res/\$(basename "\$d")"; done
fi
chroot $R /pixeld > $W/pixeld.log 2>&1 &
PID=\$!
sleep 1
cd "$HERE"
set +e
P2M_PIXELD_LOG=$W/pixeld.log P2M_RES_MIRROR="$RES" python3 tests/test_host.py
RC=\$?
kill \$PID; wait \$PID 2>/dev/null
exit \$RC
EOF
unshare -rmn sh $W/inner.sh
RC=$?
echo "--- pixeld log (tail)"; tail -15 $W/pixeld.log
exit $RC

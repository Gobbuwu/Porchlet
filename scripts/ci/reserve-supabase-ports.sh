#!/usr/bin/env bash
# Keeps the host ports of the local Supabase stack out of Linux's ephemeral port range, so no
# outgoing connection on the runner can take one before `supabase start` binds it. Without this,
# Docker can fail with "bind 0.0.0.0:54322: address already in use": 54320-54329 sit inside the
# default ephemeral range 32768-60999, and any connect() on the runner may be given one of them.
#
# The ports come from every uncommented `*port = N` line in supabase/config.toml, so a port added
# there later is covered too. Only ports inside the current ephemeral range need reserving; they
# are added to net.ipv4.ip_local_reserved_ports (existing entries are kept). A reservation only
# stops new automatic picks, so run it right after checkout, before npm ci and image pulls.
# Ports already in use when it runs are listed at the end.
#
# Usage: scripts/ci/reserve-supabase-ports.sh [config.toml]   (needs sudo, Linux only)
set -euo pipefail

config=${1:-supabase/config.toml}
[ -f "$config" ] || { echo "FAIL: $config not found"; exit 1; }

mapfile -t ports < <(sed -nE 's/^[[:space:]]*[a-z_]*port[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*(#.*)?$/\1/p' "$config" | sort -un)
[ "${#ports[@]}" -gt 0 ] || { echo "FAIL: no ports found in $config"; exit 1; }

read -r low high < /proc/sys/net/ipv4/ip_local_port_range
reserve=()
for p in "${ports[@]}"; do
  if [ "$p" -ge "$low" ] && [ "$p" -le "$high" ]; then reserve+=("$p"); fi
done
echo "Ports in $config: ${ports[*]}"
echo "Ephemeral range: $low-$high"

if [ "${#reserve[@]}" -gt 0 ]; then
  current=$(cat /proc/sys/net/ipv4/ip_local_reserved_ports)
  wanted=$(printf "%s\n" "${reserve[@]}" | paste -sd, -)
  sudo sysctl -q -w net.ipv4.ip_local_reserved_ports="${current:+$current,}$wanted"
fi
now=$(cat /proc/sys/net/ipv4/ip_local_reserved_ports)
echo "Reserved now: ${now:-none}"

# Check each port by reading the kernel's own list back, not by trusting sysctl's exit code.
in_list() { # in_list <port> <comma list of ports and ranges>
  local p=$1 item
  IFS=, read -ra items <<< "$2"
  for item in "${items[@]}"; do
    if [[ $item == *-* ]]; then
      [ "$p" -ge "${item%-*}" ] && [ "$p" -le "${item#*-}" ] && return 0
    else
      [ "$p" -eq "$item" ] && return 0
    fi
  done
  return 1
}
fail=0
for p in "${reserve[@]}"; do
  in_list "$p" "$now" || { echo "FAIL: port $p is not reserved"; fail=1; }
done

# A socket that took a port before the reservation still holds it; show any so a later bind
# failure has its cause in the log. Read /proc/net/tcp{,6} (local address is column 2, port in
# hex; state is column 4) so no extra tool is needed. TIME_WAIT (06) doesn't block Docker's
# listener, so it's only noted; any other state gets a warning annotation.
while read -r file port state; do
  [ -n "$file" ] || continue
  if [ "$state" = 06 ]; then
    echo "Note: port $port in TIME_WAIT ($file), which doesn't block a listener"
  else
    echo "::warning::Supabase port $port already in use before supabase start ($file, TCP state $state)"
  fi
done < <(awk -v list="${ports[*]}" 'BEGIN { n = split(list, a, " "); for (i = 1; i <= n; i++) want[sprintf("%04X", a[i])] = a[i] }
  FNR > 1 { split($2, l, ":"); if (l[2] in want) print FILENAME, want[l[2]], $4 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)
exit "$fail"

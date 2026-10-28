#!/usr/bin/env bash
# Read only the job container's resource counters, including after a failed build.
set -u

printf 'Build container resource limits and usage\n'
for resource in \
  /sys/fs/cgroup/memory.max \
  /sys/fs/cgroup/memory.current \
  /sys/fs/cgroup/memory.peak \
  /sys/fs/cgroup/memory.events \
  /sys/fs/cgroup/cpu.max \
  /sys/fs/cgroup/memory/memory.limit_in_bytes \
  /sys/fs/cgroup/memory/memory.max_usage_in_bytes \
  /sys/fs/cgroup/memory/memory.failcnt \
  /sys/fs/cgroup/memory/memory.oom_control \
  /sys/fs/cgroup/cpu/cpu.cfs_quota_us \
  /sys/fs/cgroup/cpu/cpu.cfs_period_us; do
  if [[ -r "$resource" ]]; then
    printf '%s: ' "$resource"
    cat "$resource" || true
  fi
done

#!/usr/bin/env bash
# Resource counters belong to a cgroup, not to a GitLab job name.
set -u

cgroup_mounts() {
  local file="$1" version="$2" controller="$3"
  awk -v version="$version" -v controller="$controller" '
    { for (i=7; i<=NF; i++) if ($i == "-") {
        if ((version == "2" && $(i+1) == "cgroup2") ||
            (version == "1" && $(i+1) == "cgroup" &&
             index("," $(i+3) ",", "," controller ",") > 0))
          print $4 "\t" $5
        break
      }
    }' "$file"
}

cgroup_directory() {
  local group="$1" root="$2" mount="$3"
  if [[ "$group" == "$root" || "$group" == / ]]; then
    printf '%s\n' "$mount"
  elif [[ "$root" == / ]]; then
    printf '%s%s\n' "$mount" "$group"
  elif [[ "$group" == "$root/"* ]]; then
    printf '%s%s\n' "$mount" "${group#"$root"}"
  else
    # A private cgroup namespace may make membership relative to the mount root.
    printf '%s%s\n' "$mount" "$group"
  fi
}

report_hierarchy() {
  local pid="$1" version="$2" controller="$3" group="$4" root="$5" mount="$6"
  local directory resource parent depth=0
  local -a resources
  case "$group" in
    /..|/../*|*/../*|*/..) printf 'Membership lies outside the visible namespace: %s\n' "$group"; return 0 ;;
  esac
  directory="$(cgroup_directory "$group" "$root" "$mount")"
  printf 'cgroup v%s controller=%s membership=%s mount_root=%s mount=%s resolved=%s\n' \
    "$version" "$controller" "$group" "$root" "$mount" "$directory"
  if [[ ! -d "$directory" ]]; then
    printf 'Resolved cgroup is not accessible; no counters inferred.\n'
    return 0
  fi
  if [[ -r "$directory/cgroup.procs" ]]; then
    if awk -v pid="$pid" '$1 == pid { found=1 } END { exit !found }' "$directory/cgroup.procs"; then
      printf 'Target PID membership verified.\n'
    else
      printf 'Target PID not visible in resolved cgroup; counters are unverified.\n'
    fi
  fi
  # Ancestors can impose the actual limit even when the leaf says "max".
  while [[ "$directory" == "$mount" || "$directory" == "$mount/"* ]]; do
    if [[ "$version" == 2 ]]; then
      resources=(memory.max memory.current memory.peak memory.events cpu.max)
    elif [[ "$controller" == memory ]]; then
      resources=(memory.limit_in_bytes memory.usage_in_bytes memory.max_usage_in_bytes memory.failcnt memory.oom_control)
    else
      resources=(cpu.cfs_quota_us cpu.cfs_period_us)
    fi
    for resource in "${resources[@]}"; do
      if [[ -r "$directory/$resource" ]]; then
        printf '%s: ' "$directory/$resource"
        cat "$directory/$resource" || true
      fi
    done
    [[ "$directory" != "$mount" && "$depth" -lt 32 ]] || break
    parent="${directory%/*}"
    [[ "$parent" != "$directory" ]] || break
    directory="$parent"
    depth=$((depth+1))
  done
}

report_resources() {
  local phase="$1" pid="$2" hierarchy controllers group version controller root mount
  printf 'Build resources phase=%s pid=%s parent_pid=%s\n' "$phase" "$pid" "$PPID"
  if [[ ! -r "/proc/$pid/cgroup" || ! -r "/proc/$pid/mountinfo" ]]; then
    printf 'Process cgroup metadata is unavailable on this host.\n'
    return 0
  fi
  printf 'cgroup namespace: '
  readlink "/proc/$pid/ns/cgroup" || true
  printf 'process membership:\n'
  cat "/proc/$pid/cgroup" || true
  while IFS=: read -r hierarchy controllers group; do
    if [[ "$hierarchy" == 0 && -z "$controllers" ]]; then
      version=2
    else
      version=1
    fi
    for controller in unified memory cpu; do
      if [[ "$version" == 2 ]]; then
        [[ "$controller" == unified ]] || continue
      else
        [[ ",$controllers," == *",$controller,"* ]] || continue
      fi
      while IFS=$'\t' read -r root mount; do
        # mountinfo escapes spaces, tabs and backslashes in these two fields.
        root="$(printf '%b' "$root")"
        mount="$(printf '%b' "$mount")"
        report_hierarchy "$pid" "$version" "$controller" "$group" "$root" "$mount"
      done < <(cgroup_mounts "/proc/$pid/mountinfo" "$version" "$controller")
    done
  done < "/proc/$pid/cgroup"
}

main() {
  if [[ "${1:-}" == --run ]]; then
    shift
    if [[ "$#" == 0 ]]; then
      printf 'A build command is required.\n' >&2
      return 64
    fi
    # This shell is the compiler's parent inside devenv. A separate after_script
    # may use a new cgroup and cannot establish this command's peak or OOM count.
    trap 'status=$?; trap - EXIT; printf "Build command exit status=%s\n" "$status"; report_resources exit "$$" || true; exit "$status"' EXIT
    report_resources start "$$" || true
    "$@"
    exit "$?"
  fi
  report_resources external "$$"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

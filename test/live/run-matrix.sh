#!/usr/bin/env bash
# Live test matrix: for each Overleaf CE version in versions.conf, start a
# throw-away instance, run the live suite against it from inside its sandbox
# network, and remove every trace of it.
#
#   test/live/run-matrix.sh                 # every version in versions.conf
#   test/live/run-matrix.sh 6.3.0 5.5.8     # just these
#   KEEP_IMAGES=1 test/live/run-matrix.sh   # don't remove the images this run pulled
#
# Run it on the Docker host (it bind-mounts the checkout read-only). Guarantees:
#   - no published ports: refused before start, verified after start;
#   - the instance's network is `internal`: verified after start;
#   - on exit — success, failure or Ctrl-C — containers, volumes and networks of
#     the run are removed, and so is every image this run pulled. Images that
#     were already on the host are never touched;
#   - nothing is built, so no build cache is created (checked at the end).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_ROOT="$(cd "$here/../.." && pwd)"
compose_file="$here/docker-compose.yml"
export NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
run_id="$$"

say() { printf '\n\033[1m[live-matrix] %s\033[0m\n' "$*"; }
die() { printf '[live-matrix] ERROR: %s\n' "$*" >&2; exit 2; }

command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose v2 not found"

# --- isolation: refuse to start anything that could publish a port or build -----
if grep -nE '^[[:space:]]*(ports|build|network_mode|container_name)[[:space:]]*:' "$compose_file"; then
  die "docker-compose.yml must not publish ports, build images, share the host network or fix container names"
fi

# --- which versions -------------------------------------------------------------
wanted=("$@")
rows=()
while read -r version image mongo shell redis envfile; do
  [[ -z "${version:-}" || "$version" == \#* ]] && continue
  if [[ ${#wanted[@]} -eq 0 ]] || printf '%s\n' "${wanted[@]}" | grep -qxF "$version"; then
    rows+=("$version $image $mongo $shell $redis $envfile")
  fi
done < "$here/versions.conf"
[[ ${#rows[@]} -gt 0 ]] || die "no matching versions in versions.conf (asked for: ${wanted[*]:-all})"

image_present() { docker image inspect "$1" >/dev/null 2>&1; }
build_cache() { docker system df --format '{{.Type}}={{.Size}}' | grep -i '^Build Cache' || true; }
cache_before="$(build_cache)"

current_project=""
pulled_images=()

teardown() {
  local project="$1"
  [[ -n "$project" ]] || return 0
  docker compose -p "$project" -f "$compose_file" --profile tools down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  # Belt and braces: anything still carrying the project label.
  local left
  left="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  [[ -z "$left" ]] || docker rm -f $left >/dev/null 2>&1 || true
  left="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  [[ -z "$left" ]] || docker volume rm -f $left >/dev/null 2>&1 || true
  left="$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
  [[ -z "$left" ]] || docker network rm $left >/dev/null 2>&1 || true
}

remove_pulled_images() {
  [[ "${KEEP_IMAGES:-0}" == "1" ]] && return 0
  local image
  for image in ${pulled_images[@]+"${pulled_images[@]}"}; do
    # Fails harmlessly if some other container started using it meanwhile.
    docker image rm "$image" >/dev/null 2>&1 && echo "  removed image $image" || echo "  left image $image (in use)"
  done
  pulled_images=()
}

on_exit() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "$current_project" ]]; then
    say "cleaning up $current_project"
    teardown "$current_project"
  fi
  remove_pulled_images
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# The mandatory env vars of the compose file, so `down` can parse it too.
export OVERLEAF_IMAGE=unused MONGO_IMAGE=unused MONGO_SHELL=unused REDIS_IMAGE=unused OVERLEAF_ENV_FILE="$here/env.overleaf"

results=()
failed=0
for row in "${rows[@]}"; do
  read -r version image mongo shell redis envfile <<<"$row"
  export OVERLEAF_VERSION="$version" OVERLEAF_IMAGE="$image" MONGO_IMAGE="$mongo" MONGO_SHELL="$shell" REDIS_IMAGE="$redis" OVERLEAF_ENV_FILE="$here/$envfile"
  project="olmcp-live-${version//./-}-$run_id"
  current_project="$project"
  dc() { docker compose -p "$project" -f "$compose_file" --profile tools "$@"; }

  say "Overleaf CE $version — $image + $mongo + $redis (project $project)"

  for needed in "$image" "$mongo" "$redis" "$NODE_IMAGE"; do
    if ! image_present "$needed"; then
      echo "  pulling $needed"
      docker pull --quiet "$needed" >/dev/null
      pulled_images+=("$needed")
    fi
  done

  status="FAIL"
  if dc up --detach --quiet-pull mongo redis sharelatex; then
    # --- isolation: verify what actually came up --------------------------------
    published="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}} {{.Ports}}' | grep -- '->' || true)"
    [[ -z "$published" ]] || die "a container published a port: $published"
    internal="$(docker network inspect "${project}_sandbox" --format '{{.Internal}}')"
    [[ "$internal" == "true" ]] || die "network ${project}_sandbox is not internal"
    echo "  isolation verified: no published ports, sandbox network is internal"

    echo "  preparing the test runner (npm ci + build, in a volume)"
    if dc run --rm --no-deps -T prepare >/dev/null; then
      if dc run --rm --no-deps -T runner; then
        status="PASS"
      fi
    else
      echo "  prepare step failed"
    fi

    # The server's own view: an OT error here means a client was (or would have been) kicked out of a doc.
    ot_errors="$(dc exec -T sharelatex sh -c 'cat /var/log/overleaf/real-time.log /var/log/overleaf/document-updater.log /var/log/sharelatex/real-time.log /var/log/sharelatex/document-updater.log 2>/dev/null | grep -c -E "otUpdateError|error applying|does not match deleted text" || true' 2>/dev/null | tr -d '[:space:]')"
    echo "  server-side OT errors logged: ${ot_errors:-unknown}"
    if [[ "${ot_errors:-0}" != "0" ]]; then
      status="FAIL"
      dc exec -T sharelatex sh -c 'cat /var/log/overleaf/*.log /var/log/sharelatex/*.log 2>/dev/null | grep -E "otUpdateError|error applying|does not match deleted text" | tail -5' || true
    fi
    if [[ "$status" != "PASS" ]]; then
      echo "  --- last lines of the web log ---"
      dc exec -T sharelatex sh -c 'tail -n 25 /var/log/overleaf/web.log 2>/dev/null || tail -n 25 /var/log/sharelatex/web.log' 2>/dev/null | cut -c1-400 || true
    fi
  else
    echo "  the instance did not start"
    dc logs --tail 40 2>/dev/null | cut -c1-300 || true
  fi

  [[ "$status" == "PASS" ]] || failed=1
  results+=("$version $status")

  say "cleaning up $project"
  teardown "$project"
  current_project=""
  remove_pulled_images
done

say "summary"
for result in "${results[@]}"; do printf '  %-8s %s\n' $result; done
leftovers="$(docker ps -aq --filter "label=com.docker.compose.project" --filter "name=olmcp-live-" | wc -l | tr -d ' ')"
echo "  leftover containers: $leftovers"
cache_after="$(build_cache)"
if [[ "$cache_before" == "$cache_after" ]]; then
  echo "  build cache unchanged (${cache_after:-none})"
else
  echo "  NOTE: the host's build cache changed during the run (${cache_before:-none} → ${cache_after:-none}); this suite builds nothing, so that came from elsewhere"
fi
exit "$failed"

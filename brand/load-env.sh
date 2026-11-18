# Loads machine-specific values from brand/.env.local (gitignored; see brand/.env.example).
# Source it from a bash script after you set BRAND to the brand/ folder:
#   . "$BRAND/load-env.sh"
# A variable that already has a value in the environment keeps that value.
# Write one KEY=value on each line, with no inline comment.
_env_file="${BRAND:?Set BRAND to the brand/ folder before you source load-env.sh}/.env.local"
if [ -f "$_env_file" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line=${_line#export }
    case "$_line" in ''|'#'*) continue ;; esac
    _k=${_line%%=*}
    [[ $_k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    _v=${_line#*=}
    _v=${_v#[\"\']}; _v=${_v%[\"\']}
    [ -n "${!_k:-}" ] || export "$_k=$_v"
  done < "$_env_file"
fi
unset _env_file _line _k _v

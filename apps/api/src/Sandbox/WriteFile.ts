export const WRITE_FILE = `mkdir -p "$(dirname "$1")" || exit 1
[ ! -e "$1" ] || [ -f "$1" ] || { echo "Not a regular file: $1" >&2; exit 1; }
exec dd of="$1" oflag=nonblock status=none`

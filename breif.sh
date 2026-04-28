
topic=$1
TOPIC="${1^^}"
TOPIC="${TOPIC//-/_}"
if [[ -f ~/storage/downloads/emu86-$1-brief.md ]]; then

cp ~/storage/downloads/emu86-$1-brief.md .
less emu86-$1-brief.md
claude --dangerously-skip-permissions "read emu86-$1-brief.md and follow it"                                      487  ls
cp ${TOPIC}_REPORT.md ~/storage/downloads
fi

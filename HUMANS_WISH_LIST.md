
- web serial ports map to /dev/ttyS1 etc
- hdb is visible from all tabs, which could be problematic if two tabs write during same session. proposal: each tab has it's own hdb, with 
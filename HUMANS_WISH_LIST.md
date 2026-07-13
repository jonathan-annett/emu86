
- web serial ports map to /dev/ttyS1 etc
- define block devices in browser so virtual drives can be made


browser side: block device #1 is 8192k (8192 x 1k blocks)

ELKS side:
mkfs /dev/browser1 8192 && mount /dev/browser1 /mnt/files


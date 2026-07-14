/*
 * ping.c - raw-frame ICMP ping for ELKS on the emu86 LAN (Phase 15 M3).
 *
 * ELKS ships no ping: ktcp's icmp.c is reply-only and exposes no ICMP
 * socket API. This tool goes UNDER the stack instead - it opens
 * /dev/eth directly and does its own ARP, ICMP, and checksums. That
 * means ktcp must not hold the device: run it before `net start`, or
 * after `net stop`.
 *
 * It is also the Phase 15 dogfooding exercise: this file is compiled
 * INSIDE the emulated machine by the on-disk C86 toolchain
 * (cpp -> c86 -> as -> ld), not cross-compiled. Everything it needs
 * from the OS is self-declared below because the hd32 image ships only
 * the c86 subset of /usr/include.
 *
 * Routing: /24 assumed. Off-subnet targets are sent to the gateway
 * (10.0.2.2), which on this LAN answers with an honest ICMP
 * host-unreachable - a browser cannot originate real ICMP, and emu86
 * does not fake RTTs.
 *
 * Usage: ping ADDR [count]     (default count 4)
 */

#include <stdio.h>

/* ---- self-declared ELKS ABI ---- */

#define O_RDWR             2
#define IOCTL_ETH_ADDR_GET 0x0901   /* linuxmt/ioctl.h */
#define MAX_ETH            1536     /* linuxmt/limits.h MAX_PACKET_ETH */

struct timeval {                    /* linuxmt/time.h: two longs */
    long tv_sec;
    long tv_usec;
};

/* ELKS fd_set is a 32-bit bitmask (linuxmt/posixtyp.h); fd < 20. */

extern int open();
extern int close();
extern int read();
extern int write();
extern int ioctl();
extern int select();
extern int gettimeofday();
extern int fflush();

/* ---- constants ---- */

#define PING_ID   0x8086            /* naturally */
#define DATA_LEN  32
#define ECHO_LEN  (8 + DATA_LEN)
#define IP_LEN    (20 + ECHO_LEN)
#define FRAME_LEN (14 + IP_LEN)

#define WAIT_REPLY_MS 2000L
#define WAIT_ARP_MS   1000L
#define GAP_MS        200L

/* ---- globals ---- */

static unsigned char my_mac[6];
static unsigned char my_ip[4]  = { 10, 0, 2, 15 };
static unsigned char gw_ip[4]  = { 10, 0, 2, 2 };
static unsigned char dst_ip[4];
static unsigned char hop_mac[6];
static unsigned char from_ip[4];    /* sender of the last reply/error */

static int ethfd = -1;
static unsigned char txf[MAX_ETH];
static unsigned char rxf[MAX_ETH];

/* ---- small helpers (no libc string deps) ---- */

static void bcopy6(unsigned char *d, unsigned char *s)
{
    int i;
    for (i = 0; i < 6; i++) d[i] = s[i];
}

static void bcopy4(unsigned char *d, unsigned char *s)
{
    int i;
    for (i = 0; i < 4; i++) d[i] = s[i];
}

static int eq4(unsigned char *a, unsigned char *b)
{
    return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3];
}

static void put16(unsigned char *p, unsigned int v)
{
    p[0] = (unsigned char)(v >> 8);
    p[1] = (unsigned char)(v & 0xff);
}

static char *fmt_ip(char *buf, unsigned char *ip)
{
    sprintf(buf, "%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3]);
    return buf;
}

static int parse_ip(char *s, unsigned char *out)
{
    int part, val, digits;
    part = 0;
    val = 0;
    digits = 0;
    for (;; s++) {
        if (*s >= '0' && *s <= '9') {
            val = val * 10 + (*s - '0');
            digits++;
            if (val > 255) return 0;
        } else if (*s == '.' || *s == '\0') {
            if (digits == 0 || part > 3) return 0;
            out[part] = (unsigned char)val;
            part++;
            val = 0;
            digits = 0;
            if (*s == '\0') break;
        } else {
            return 0;
        }
    }
    return part == 4;
}

static int parse_count(char *s)
{
    int v;
    v = 0;
    for (; *s >= '0' && *s <= '9'; s++) v = v * 10 + (*s - '0');
    return v;
}

/* RFC 1071 checksum over big-endian 16-bit words. */
static unsigned int cksum(unsigned char *p, int len)
{
    unsigned long sum;
    int i;
    sum = 0;
    for (i = 0; i + 1 < len; i += 2)
        sum += ((unsigned long)p[i] << 8) | p[i + 1];
    if (i < len)
        sum += (unsigned long)p[i] << 8;
    while (sum >> 16)
        sum = (sum & 0xffffL) + (sum >> 16);
    return (unsigned int)(~sum & 0xffffL);
}

static long ms_since(struct timeval *t0)
{
    struct timeval t1;
    gettimeofday(&t1, (char *)0);
    return (t1.tv_sec - t0->tv_sec) * 1000L + (t1.tv_usec - t0->tv_usec) / 1000L;
}

/* Wait up to `ms` for one frame into rxf; returns its length or 0. */
static int rx_frame(long ms)
{
    unsigned long rfds;
    struct timeval tv;
    int n;
    if (ms < 0) ms = 0;
    rfds = 1UL << ethfd;
    tv.tv_sec = ms / 1000L;
    tv.tv_usec = (ms % 1000L) * 1000L;
    n = select(ethfd + 1, &rfds, (unsigned long *)0, (unsigned long *)0, &tv);
    if (n <= 0) return 0;
    n = read(ethfd, rxf, MAX_ETH);
    return n > 0 ? n : 0;
}

static void idle_ms(long ms)
{
    struct timeval tv;
    tv.tv_sec = ms / 1000L;
    tv.tv_usec = (ms % 1000L) * 1000L;
    select(0, (unsigned long *)0, (unsigned long *)0, (unsigned long *)0, &tv);
}

/* ---- ARP ---- */

/* Resolve `ip` to hop_mac. Returns 1 on success. */
static int arp_resolve(unsigned char *ip)
{
    struct timeval t0;
    int tries, len, i;
    for (tries = 0; tries < 3; tries++) {
        /* ethernet: broadcast, from us, type 0x0806 */
        for (i = 0; i < 6; i++) txf[i] = 0xff;
        bcopy6(txf + 6, my_mac);
        txf[12] = 0x08; txf[13] = 0x06;
        /* arp: ethernet/IPv4 who-has */
        txf[14] = 0x00; txf[15] = 0x01;      /* htype */
        txf[16] = 0x08; txf[17] = 0x00;      /* ptype */
        txf[18] = 6;    txf[19] = 4;         /* hlen, plen */
        txf[20] = 0x00; txf[21] = 0x01;      /* op: request */
        bcopy6(txf + 22, my_mac);
        bcopy4(txf + 28, my_ip);
        for (i = 32; i < 38; i++) txf[i] = 0;
        bcopy4(txf + 38, ip);
        for (i = 42; i < 60; i++) txf[i] = 0; /* pad to minimum */
        write(ethfd, (char *)txf, 60);

        gettimeofday(&t0, (char *)0);
        while (ms_since(&t0) < WAIT_ARP_MS) {
            len = rx_frame(WAIT_ARP_MS - ms_since(&t0));
            if (len < 42) continue;
            if (rxf[12] != 0x08 || rxf[13] != 0x06) continue;  /* not ARP */
            if (rxf[20] != 0x00 || rxf[21] != 0x02) continue;  /* not reply */
            if (!eq4(rxf + 28, ip)) continue;                  /* not our target */
            bcopy6(hop_mac, rxf + 22);
            return 1;
        }
    }
    return 0;
}

/* ---- ICMP echo ---- */

static void send_echo(unsigned int seq)
{
    int i;
    unsigned char *ip;
    unsigned char *icmp;
    /* ethernet */
    bcopy6(txf, hop_mac);
    bcopy6(txf + 6, my_mac);
    txf[12] = 0x08; txf[13] = 0x00;
    /* IPv4 header */
    ip = txf + 14;
    ip[0] = 0x45; ip[1] = 0x00;
    put16(ip + 2, IP_LEN);
    put16(ip + 4, seq);            /* IP id: reuse the sequence */
    ip[6] = 0; ip[7] = 0;
    ip[8] = 64;                    /* TTL */
    ip[9] = 1;                     /* ICMP */
    ip[10] = 0; ip[11] = 0;
    bcopy4(ip + 12, my_ip);
    bcopy4(ip + 16, dst_ip);
    put16(ip + 10, cksum(ip, 20));
    /* ICMP echo request */
    icmp = ip + 20;
    icmp[0] = 8; icmp[1] = 0;
    icmp[2] = 0; icmp[3] = 0;
    put16(icmp + 4, PING_ID);
    put16(icmp + 6, seq);
    for (i = 0; i < DATA_LEN; i++)
        icmp[8 + i] = (unsigned char)(0x20 + i);
    put16(icmp + 2, cksum(icmp, ECHO_LEN));
    write(ethfd, (char *)txf, FRAME_LEN);
}

/* Wait for the answer to `seq`: 1 = reply, 2 = unreachable, 0 = timeout. */
static int wait_answer(unsigned int seq)
{
    struct timeval t0;
    int len, ihl;
    unsigned char *ip;
    unsigned char *icmp;
    gettimeofday(&t0, (char *)0);
    while (ms_since(&t0) < WAIT_REPLY_MS) {
        len = rx_frame(WAIT_REPLY_MS - ms_since(&t0));
        if (len < 14 + 28) continue;
        if (rxf[12] != 0x08 || rxf[13] != 0x00) continue;   /* not IPv4 */
        ip = rxf + 14;
        if ((ip[0] >> 4) != 4) continue;
        ihl = (ip[0] & 0x0f) * 4;
        if (ip[9] != 1) continue;                           /* not ICMP */
        if (!eq4(ip + 16, my_ip)) continue;                 /* not for us */
        icmp = ip + ihl;
        if (icmp[0] == 0) {                                 /* echo reply */
            if (((unsigned int)icmp[4] << 8 | icmp[5]) != PING_ID) continue;
            if (((unsigned int)icmp[6] << 8 | icmp[7]) != seq) continue;
            if (!eq4(ip + 12, dst_ip)) continue;
            bcopy4(from_ip, ip + 12);
            return 1;
        }
        if (icmp[0] == 3) {                                 /* dest unreachable */
            bcopy4(from_ip, ip + 12);
            return 2;
        }
    }
    return 0;
}

/* ---- main ---- */

int main(int argc, char **argv)
{
    char abuf[16];
    char bbuf[16];
    unsigned char *hop;
    int count, sent, got, res;
    unsigned int seq;
    long rtt;

    if (argc < 2 || !parse_ip(argv[1], dst_ip)) {
        printf("usage: ping ADDR [count]\n");
        printf("note: needs the raw eth device - run before net start (or net stop first)\n");
        return 1;
    }
    count = argc > 2 ? parse_count(argv[2]) : 4;
    if (count < 1) count = 1;

    /* /dev/ne0 on current images (ktcp.c:47); /dev/eth on older ones. */
    ethfd = open("/dev/ne0", O_RDWR);
    if (ethfd < 0) ethfd = open("/dev/eth", O_RDWR);
    if (ethfd < 0) {
        printf("ping: cannot open /dev/ne0 (is ktcp running? try: net stop)\n");
        return 1;
    }
    if (ioctl(ethfd, IOCTL_ETH_ADDR_GET, (char *)my_mac) < 0) {
        printf("ping: IOCTL_ETH_ADDR_GET failed\n");
        close(ethfd);
        return 1;
    }

    /* /24 routing: on-subnet direct, everything else via the gateway. */
    hop = (dst_ip[0] == my_ip[0] && dst_ip[1] == my_ip[1] && dst_ip[2] == my_ip[2])
        ? dst_ip : gw_ip;

    /* Banner before ARP, flushed: on a hang the transcript still shows
     * how far we got (stdio is fully buffered on this libc). */
    printf("PING %s from %s: %d data bytes\n",
           fmt_ip(abuf, dst_ip), fmt_ip(bbuf, my_ip), DATA_LEN);
    fflush(stdout);

    if (!arp_resolve(hop)) {
        printf("ping: no ARP reply from %s\n", fmt_ip(abuf, hop));
        close(ethfd);
        return 1;
    }

    sent = 0;
    got = 0;
    for (seq = 1; seq <= (unsigned int)count; seq++) {
        struct timeval t0;
        gettimeofday(&t0, (char *)0);
        send_echo(seq);
        sent++;
        res = wait_answer(seq);
        rtt = ms_since(&t0);
        if (res == 1) {
            got++;
            printf("%d bytes from %s: seq=%u time=%ld ms\n",
                   ECHO_LEN, fmt_ip(abuf, from_ip), seq, rtt);
        } else if (res == 2) {
            printf("From %s: Destination Host Unreachable\n", fmt_ip(abuf, from_ip));
        } else {
            printf("Request timed out (seq=%u)\n", seq);
        }
        fflush(stdout);
        if (seq < (unsigned int)count) idle_ms(GAP_MS);
    }

    printf("--- %s ping statistics ---\n", fmt_ip(abuf, dst_ip));
    printf("%d packets transmitted, %d received\n", sent, got);
    close(ethfd);
    return got > 0 ? 0 : 1;
}

/**
 * The `.tabs` namespace (Phase 15 M4 — Jonathan's design).
 *
 * Every tab on the Tab Area Network gets a deterministic short animal
 * name: the first tab is `mouse`, the next `cat`, then `dog`. The
 * gateway — invisible until now — is **`elk`** (ELK-S), and the DNS
 * pseudo-host that answers for all of them is `owl`, because it looks
 * things up.
 *
 * The names are a pure function of the host octet, and that is the
 * whole trick. It means:
 *
 *   - the DNS host can synthesize an answer without asking anyone;
 *   - the browser can title the tab before a single frame is sent;
 *   - and **`ping` can resolve a name with no network at all** — it
 *     carries this table compiled into it. That matters because ping
 *     cannot use DNS: the ELKS resolver speaks DNS-over-TCP through
 *     ktcp, and ktcp is precisely the process that must not be running
 *     while ping owns the NIC. A pure function needs no daemon.
 *
 * `web/guest/ping.c` mirrors this list in C, and
 * `tests/unit/tan-names.test.ts` pins the two together so they cannot
 * drift.
 */

import { formatIp, type Ipv4 } from './wire.js';

/** DNS-ish suffix. `cat` and `cat.tabs` are the same host. */
export const TAB_DOMAIN = 'tabs';

/** Host octets the TAN lease draws from — must match `tan.ts`. */
export const OCTET_MIN = 16;
export const OCTET_MAX = 199;

/**
 * One name per host octet, `TAB_NAMES[octet - OCTET_MIN]`. Short,
 * lowercase, distinct, and in a deliberate order: the friendly,
 * memorable ones come first, because the first tabs to open get them.
 */
export const TAB_NAMES: readonly string[] = [
  // 16..
  'mouse', 'cat', 'dog', 'fox', 'bear', 'wolf', 'deer', 'hare',
  'crow', 'duck', 'swan', 'frog', 'toad', 'newt', 'lynx', 'mole',
  'vole', 'seal', 'otter', 'stoat', 'weasel', 'badger', 'rabbit', 'ferret',
  'hamster', 'gerbil', 'shrew', 'bat', 'hedgehog', 'squirrel', 'beaver', 'marten',
  'mink', 'polecat', 'raccoon', 'skunk', 'possum', 'wombat', 'koala', 'quokka',
  'wallaby', 'kangaroo', 'platypus', 'echidna', 'dingo', 'emu', 'kiwi', 'kea',
  'robin', 'wren', 'finch', 'sparrow', 'starling', 'magpie', 'jackdaw', 'rook',
  'raven', 'jay', 'thrush', 'blackbird', 'swallow', 'martin', 'swift', 'lark',
  'pipit', 'wagtail', 'dunnock', 'warbler', 'chiffchaff', 'goldcrest', 'nuthatch', 'treecreeper',
  'woodpecker', 'kingfisher', 'heron', 'egret', 'stork', 'crane', 'ibis', 'spoonbill',
  'grebe', 'coot', 'moorhen', 'rail', 'snipe', 'curlew', 'godwit', 'plover',
  'lapwing', 'dunlin', 'sanderling', 'turnstone', 'oystercatcher', 'avocet', 'gull', 'tern',
  'skua', 'puffin', 'guillemot', 'razorbill', 'gannet', 'cormorant', 'shag', 'fulmar',
  'petrel', 'albatross', 'pelican', 'flamingo', 'falcon', 'kestrel', 'merlin', 'hobby',
  'buzzard', 'harrier', 'osprey', 'eagle', 'kite', 'goshawk', 'sparrowhawk', 'vulture',
  'condor', 'toucan', 'macaw', 'parrot', 'budgie', 'cockatoo', 'lorikeet', 'rosella',
  'quail', 'grouse', 'pheasant', 'partridge', 'peacock', 'turkey', 'goose', 'gosling',
  'heifer', 'bullock', 'donkey', 'mule', 'pony', 'foal', 'lamb', 'piglet',
  'gecko', 'skink', 'iguana', 'chameleon', 'monitor', 'python', 'adder', 'viper',
  'cobra', 'mamba', 'boa', 'krait', 'turtle', 'tortoise', 'terrapin', 'gharial',
  'caiman', 'axolotl', 'salamander', 'tadpole', 'perch', 'roach', 'rudd', 'tench',
  'carp', 'bream', 'barbel', 'chub', 'dace', 'gudgeon', 'minnow', 'stickleback',
  'salmon', 'trout', 'grayling', 'pike', 'eel', 'lamprey', 'sturgeon', 'burbot',
];

/** The gateway. ELK-S — it was there all along, just nameless. */
export const GATEWAY_NAME = 'elk';
/** The DNS pseudo-host at 10.0.2.3. It looks things up. */
export const DNS_NAME = 'owl';

/**
 * Fixed names outside the tab range: the LAN's permanent residents,
 * plus the conventional aliases people will try first.
 */
export const FIXED_HOSTS: ReadonlyMap<string, Ipv4> = new Map<string, Ipv4>([
  [GATEWAY_NAME, [10, 0, 2, 2]],
  ['gateway', [10, 0, 2, 2]],
  [DNS_NAME, [10, 0, 2, 3]],
  ['dns', [10, 0, 2, 3]],
]);

/** The name of the tab at `octet`, or null if it is outside the lease range. */
export function nameForOctet(octet: number): string | null {
  if (!Number.isInteger(octet) || octet < OCTET_MIN || octet > OCTET_MAX) return null;
  return TAB_NAMES[octet - OCTET_MIN] ?? null;
}

/**
 * Resolve a name to an address. Accepts `cat`, `cat.tabs`, and any
 * case; returns null for anything not in the namespace (the DNS host
 * then falls through to the real internet).
 */
export function addressForName(name: string): Ipv4 | null {
  const host = normalize(name);
  if (host === null) return null;

  const fixed = FIXED_HOSTS.get(host);
  if (fixed !== undefined) return fixed;

  const index = TAB_NAMES.indexOf(host);
  if (index < 0) return null;
  return [10, 0, 2, OCTET_MIN + index];
}

/**
 * Strip a trailing `.tabs` (and any trailing dot), lowercase, and
 * reject anything with further structure — `cat.tabs` is ours,
 * `cat.example.com` is the internet's.
 */
function normalize(name: string): string | null {
  let host = name.toLowerCase().replace(/\.$/, '');
  const suffix = `.${TAB_DOMAIN}`;
  if (host.endsWith(suffix)) host = host.slice(0, -suffix.length);
  if (host.length === 0 || host.includes('.')) return null;
  return host;
}

/** Every name we answer for, with its address — for /etc/hosts-style dumps and tests. */
export function allKnownHosts(): Array<{ name: string; ip: Ipv4; dotted: string }> {
  const out: Array<{ name: string; ip: Ipv4; dotted: string }> = [];
  for (const [name, ip] of FIXED_HOSTS) {
    out.push({ name, ip, dotted: formatIp(ip) });
  }
  TAB_NAMES.forEach((name, i) => {
    const ip: Ipv4 = [10, 0, 2, OCTET_MIN + i];
    out.push({ name, ip, dotted: formatIp(ip) });
  });
  return out;
}

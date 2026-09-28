import { getDbVendorRules } from './lib/deviceRulesCache.js';

export interface DeviceClassification {
  category: string;
  subcategory: string;
  vendor: string;
  isRandom?: boolean;
  needsLabel?: boolean;
  /** True for categories where an owner identity is expected (personal devices,
   *  computers). Used by the route to flag devices for the triage queue even
   *  when they have a recognized vendor category. */
  ownerRequired?: boolean;
}

/** Categories where we want a human to assign an owner label. */
const OWNER_REQUIRED_CATEGORIES = new Set([
  'People / Personal Devices',
  'Computers & Laptops',
  'Mobile Phones & Tablets',
  'Unknown / Uncategorized',
]);

/** The catch-all category that still needs human triage to get a real category. */
export const UNCATEGORIZED_CATEGORY = 'Unknown / Uncategorized';

/** True for categories where an owner identity is expected. Computed off the
 *  EFFECTIVE category (post-override) so admin recategorization is respected. */
export function isOwnerRequiredCategory(category: string | null | undefined): boolean {
  return category != null && OWNER_REQUIRED_CATEGORIES.has(category);
}

interface TypeRule {
  category: string;
  subcategory: string;
  vendor: string;
  keywords: string[];
}

const TYPE_RULES: TypeRule[] = [
  { category: 'Network Infrastructure', subcategory: 'Access Points', vendor: 'Ruckus', keywords: ['ruckus'] },
  { category: 'Network Infrastructure', subcategory: 'Access Points', vendor: 'Aruba', keywords: ['aruba'] },
  { category: 'Network Infrastructure', subcategory: 'Access Points', vendor: 'Ubiquiti', keywords: ['ubiquiti', 'unifi'] },
  { category: 'Network Infrastructure', subcategory: 'Switches', vendor: 'Cisco', keywords: ['cisco', 'meraki'] },
  { category: 'Network Infrastructure', subcategory: 'Firewalls', vendor: 'Fortinet', keywords: ['fortinet', 'fortigate'] },
  { category: 'Network Infrastructure', subcategory: 'Switches', vendor: 'Netgear', keywords: ['netgear', 'orbi'] },
  { category: 'Network Infrastructure', subcategory: 'Switches', vendor: 'CommScope', keywords: ['commscope'] },

  { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Verkada', keywords: ['verkada'] },
  { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Axis', keywords: ['axis'] },
  { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Hikvision', keywords: ['hikvision'] },
  { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Dahua', keywords: ['dahua'] },
  { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Ring', keywords: ['ring'] },

  { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Roku', keywords: ['roku'] },
  { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Amazon', keywords: ['fire tv', 'firetv'] },
  { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Google', keywords: ['chromecast'] },

  { category: 'Smart Speakers', subcategory: 'Smart Speakers', vendor: 'Sonos', keywords: ['sonos'] },
  { category: 'Smart Speakers', subcategory: 'Smart Speakers', vendor: 'Amazon', keywords: ['echo', 'alexa'] },

  { category: 'Thermostats', subcategory: 'Thermostats', vendor: 'Ecobee', keywords: ['ecobee'] },

  { category: 'Lighting & Switches', subcategory: 'Lighting & Switches', vendor: 'Lutron', keywords: ['lutron'] },
  { category: 'Lighting & Switches', subcategory: 'Lighting & Switches', vendor: 'Philips Hue', keywords: ['philips hue', 'signify'] },

  { category: 'AV Systems', subcategory: 'AV Systems', vendor: 'Crestron', keywords: ['crestron'] },
  { category: 'AV Systems', subcategory: 'AV Systems', vendor: 'Sonance', keywords: ['sonance'] },
  { category: 'AV Systems', subcategory: 'AV Systems', vendor: 'SnapAV', keywords: ['snapav', 'snap av', 'wirepath', 'wyrestorm', 'binary'] },
  { category: 'AV Systems', subcategory: 'AV Systems', vendor: 'Control4', keywords: ['control4', 'control 4'] },

  { category: 'Printers', subcategory: 'Printers', vendor: 'Epson', keywords: ['epson'] },
  { category: 'Printers', subcategory: 'Printers', vendor: 'Canon', keywords: ['canon'] },
  { category: 'Printers', subcategory: 'Printers', vendor: 'Brother', keywords: ['brother'] },
  { category: 'Printers', subcategory: 'Printers', vendor: 'Konica Minolta', keywords: ['konica', 'minolta', 'bizhub'] },

  { category: 'Gaming Consoles', subcategory: 'Gaming Consoles', vendor: 'Microsoft', keywords: ['xbox'] },
  { category: 'Gaming Consoles', subcategory: 'Gaming Consoles', vendor: 'Sony', keywords: ['playstation', 'ps4', 'ps5'] },
  { category: 'Gaming Consoles', subcategory: 'Gaming Consoles', vendor: 'Nintendo', keywords: ['nintendo', 'switch'] },

  { category: 'Virtual Machines', subcategory: 'VMware', vendor: 'VMware', keywords: ['vmware'] },
  { category: 'Virtual Machines', subcategory: 'VirtualBox', vendor: 'VirtualBox', keywords: ['virtualbox', 'vbox'] },

  { category: 'Cars', subcategory: 'Cars', vendor: 'Tesla', keywords: ['tesla'] },

  { category: 'Electricity Monitoring', subcategory: 'Electricity Monitoring', vendor: 'Emporia', keywords: ['emporia'] },

  { category: 'IoT Devices', subcategory: 'IoT Devices', vendor: 'Tuya', keywords: ['tuya'] },
  { category: 'Smart Gate Devices', subcategory: 'Smart Gate Devices', vendor: 'Chamberlain', keywords: ['chamberlain', 'liftmaster', 'myq'] },

  { category: 'Smart Sprinklers', subcategory: 'Smart Sprinklers', vendor: 'RainBird', keywords: ['rainbird', 'rain bird'] },
];

interface OuiEntry {
  prefix: string;
  vendor: string;
  category: string;
  subcategory: string;
}

const OUI_MAP: OuiEntry[] = [
  { prefix: '00:17:f2', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '00:1c:b3', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '00:25:00', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '28:cf:e9', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '3c:22:fb', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: 'a4:c3:61', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: 'f0:18:98', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '8c:85:90', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '4c:b1:cd', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: 'a8:51:5b', vendor: 'Apple', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '00:1a:11', vendor: 'Google', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '54:60:09', vendor: 'Google', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: 'f4:f5:d8', vendor: 'Google', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '94:eb:2c', vendor: 'Google', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '48:d6:d5', vendor: 'Google', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: 'f4:f5:e8', vendor: 'Google', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '18:b4:30', vendor: 'Google Nest', category: 'Thermostats', subcategory: 'Thermostats' },
  { prefix: '00:17:88', vendor: 'Philips Hue', category: 'Lighting & Switches', subcategory: 'Lighting & Switches' },
  { prefix: 'ec:b5:fa', vendor: 'Philips Hue', category: 'Lighting & Switches', subcategory: 'Lighting & Switches' },
  { prefix: '00:0c:29', vendor: 'VMware', category: 'Virtual Machines', subcategory: 'VMware' },
  { prefix: '00:50:56', vendor: 'VMware', category: 'Virtual Machines', subcategory: 'VMware' },
  { prefix: '08:00:27', vendor: 'VirtualBox', category: 'Virtual Machines', subcategory: 'VirtualBox' },
  { prefix: '00:1c:42', vendor: 'Parallels', category: 'Virtual Machines', subcategory: 'Parallels' },
  { prefix: 'b4:fb:e4', vendor: 'Ruckus', category: 'Network Infrastructure', subcategory: 'Access Points' },
  { prefix: '94:18:65', vendor: 'Netgear', category: 'Network Infrastructure', subcategory: 'Switches' },
  { prefix: '00:23:7a', vendor: 'Crestron', category: 'AV Systems', subcategory: 'AV Systems' },
  { prefix: '00:10:7f', vendor: 'Crestron', category: 'AV Systems', subcategory: 'AV Systems' },
  { prefix: '00:0f:ec', vendor: 'Verkada', category: 'Security Cameras', subcategory: 'Security Cameras' },
  { prefix: 'fc:cc:ba', vendor: 'Sonos', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '94:9f:3e', vendor: 'Sonos', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '5c:aa:fd', vendor: 'Sonos', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '00:0e:58', vendor: 'Sonos', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '78:28:ca', vendor: 'Sonos', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: 'b8:e9:37', vendor: 'Amazon', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: 'f0:81:73', vendor: 'Amazon', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '44:65:0d', vendor: 'Amazon', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '74:75:48', vendor: 'Amazon', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: 'fc:65:de', vendor: 'Amazon', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '00:9b:08', vendor: 'Amazon', category: 'Smart Speakers', subcategory: 'Smart Speakers' },
  { prefix: '00:14:5e', vendor: 'Samsung', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '00:23:39', vendor: 'Samsung', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: 'f4:42:8f', vendor: 'Samsung', category: 'Mobile Phones & Tablets', subcategory: 'Mobile Phones & Tablets' },
  { prefix: '78:bd:bc', vendor: 'Samsung', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '00:4b:12', vendor: 'Emporia', category: 'Electricity Monitoring', subcategory: 'Electricity Monitoring' },
  { prefix: '6c:c8:40', vendor: 'Emporia', category: 'Electricity Monitoring', subcategory: 'Electricity Monitoring' },
  { prefix: '7c:1e:b3', vendor: '2N', category: 'Smart Gate Devices', subcategory: 'Smart Gate Devices' },
  { prefix: '4c:bb:47', vendor: 'NVIDIA', category: "Tony's Systems", subcategory: "Tony's Systems" },
  { prefix: 'ac:3a:7a', vendor: 'Roku', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: 'b0:09:da', vendor: 'Ring', category: 'Security Cameras', subcategory: 'Security Cameras' },
  { prefix: '44:61:32', vendor: 'Ecobee', category: 'Thermostats', subcategory: 'Thermostats' },
  { prefix: '00:1b:78', vendor: 'HP', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '70:5a:0f', vendor: 'HP', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '00:1c:62', vendor: 'LG', category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming' },
  { prefix: '00:14:22', vendor: 'Dell', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '00:21:cc', vendor: 'Lenovo', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '00:15:5d', vendor: 'Microsoft', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: 'a4:c1:38', vendor: 'Govee', category: 'Lighting & Switches', subcategory: 'Lighting & Switches' },
  { prefix: 'd4:a6:51', vendor: 'Govee', category: 'Lighting & Switches', subcategory: 'Lighting & Switches' },
  { prefix: '00:1b:21', vendor: 'Intel', category: 'Computers & Laptops', subcategory: 'Computers & Laptops' },
  { prefix: '14:33:5c', vendor: 'RainBird', category: 'Smart Sprinklers', subcategory: 'Smart Sprinklers' },
];

function normalizeOui(mac: string | null): string | null {
  if (!mac) return null;
  const cleaned = mac.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length < 6) return null;
  const hex = cleaned.slice(0, 6).toLowerCase();
  return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`;
}

/**
 * Returns true when the MAC address has the locally-administered (LA) bit set —
 * the second-least-significant bit of the first octet. Apple, Android, Windows
 * all use LA MACs for privacy randomization. OUI lookups are meaningless for
 * these devices; hostname / fingerprint is the only reliable classifier.
 */
export function isRandomizedMac(mac: string | null): boolean {
  if (!mac) return false;
  const cleaned = mac.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length < 2) return false;
  const firstByte = parseInt(cleaned.slice(0, 2), 16);
  return (firstByte & 0x02) !== 0;
}

function classifyByFields(vendor: string | null, deviceType: string | null, osType: string | null, hostname: string | null): DeviceClassification | null {
  const haystack = [vendor, deviceType, osType, hostname].filter(Boolean).join(' ').toLowerCase();
  if (!haystack) return null;

  // Hostname-priority rules — these run BEFORE OUI so a spoofed/recycled OUI
  // (e.g. Konica-Minolta vendor string but "ALARM" hostname) classifies correctly.

  if (/\balarm\b/i.test(haystack)) {
    return { category: 'Smart Gate Devices', subcategory: 'Access Control', vendor: detectVendorName(vendor) || 'Unknown' };
  }

  if (/\btony\b/i.test(haystack)) {
    return { category: "Tony's Systems", subcategory: "Tony's Systems", vendor: detectVendorName(vendor) || vendor || 'Unknown' };
  }

  if (/nvidia/i.test(haystack)) {
    return { category: "Tony's Systems", subcategory: "Tony's Systems", vendor: 'NVIDIA' };
  }

  if (/iphone/i.test(haystack)) {
    return { category: 'Mobile Phones & Tablets', subcategory: 'Mobile Phones & Tablets', vendor: 'Apple' };
  }
  if (/ipad/i.test(haystack)) {
    return { category: 'Mobile Phones & Tablets', subcategory: 'Mobile Phones & Tablets', vendor: 'Apple' };
  }

  if (/apple.?tv/i.test(haystack)) {
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Apple' };
  }

  if (/nest\s*(thermostat|hub|cam)/i.test(haystack) || /nest.*(cam|thermostat)/i.test(haystack)) {
    if (/cam/i.test(haystack)) {
      return { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Google' };
    }
    return { category: 'Thermostats', subcategory: 'Thermostats', vendor: 'Google' };
  }
  if (/google.?home|nest.?hub|nest.?mini|nest.?audio/i.test(haystack)) {
    return { category: 'Smart Speakers', subcategory: 'Smart Speakers', vendor: 'Google' };
  }
  if (/google|nest/i.test(haystack) && /thermostat/i.test(haystack)) {
    return { category: 'Thermostats', subcategory: 'Thermostats', vendor: 'Google' };
  }
  if (/nest/i.test(haystack)) {
    return { category: 'Smart Speakers', subcategory: 'Smart Speakers', vendor: 'Google' };
  }
  if (/google/i.test(haystack)) {
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Google' };
  }

  if (/samsung.*(tv|smart.?tv|uhd|qled|oled|frame)/i.test(haystack) || /smart.?tv.*samsung/i.test(haystack)) {
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Samsung' };
  }
  if (/samsung.*(galaxy|phone|s\d+|a\d+|note)/i.test(haystack) || /android.*samsung/i.test(haystack)) {
    return { category: 'Mobile Phones & Tablets', subcategory: 'Mobile Phones & Tablets', vendor: 'Samsung' };
  }
  if (/samsung/i.test(haystack)) {
    const isPhoneHint = /android|mobile|galaxy|phone/i.test(haystack);
    if (isPhoneHint) return { category: 'Mobile Phones & Tablets', subcategory: 'Mobile Phones & Tablets', vendor: 'Samsung' };
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Samsung' };
  }

  if (/oneplus|xiaomi|oppo|motorola|huawei|pixel/i.test(haystack)) {
    const v = /oneplus/i.test(haystack) ? 'OnePlus' : /xiaomi/i.test(haystack) ? 'Xiaomi' : /oppo/i.test(haystack) ? 'Oppo' : /motorola/i.test(haystack) ? 'Motorola' : /huawei/i.test(haystack) ? 'Huawei' : 'Google';
    return { category: 'Mobile Phones & Tablets', subcategory: 'Mobile Phones & Tablets', vendor: v };
  }

  if (/sony/i.test(haystack) && /android|bravia/i.test(haystack) && !/playstation|ps4|ps5/i.test(haystack)) {
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Sony' };
  }

  if (/\b2n\b/i.test(haystack)) {
    return { category: 'Smart Gate Devices', subcategory: 'Smart Gate Devices', vendor: '2N' };
  }

  if (/amazon.*echo|echo.*dot|amazon.*alexa/i.test(haystack)) {
    return { category: 'Smart Speakers', subcategory: 'Smart Speakers', vendor: 'Amazon' };
  }
  if (/amazon.*fire|fire.?tv|kindle|firestick/i.test(haystack)) {
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Amazon' };
  }
  if (/ring/i.test(haystack)) {
    return { category: 'Security Cameras', subcategory: 'Security Cameras', vendor: 'Ring' };
  }
  if (/amazon/i.test(haystack)) {
    return { category: 'Smart Speakers', subcategory: 'Smart Speakers', vendor: 'Amazon' };
  }

  if (/macbook|imac|mac pro|mac mini|macintosh|macos|mac os/i.test(haystack)) {
    return { category: 'Computers & Laptops', subcategory: 'Computers & Laptops', vendor: 'Apple' };
  }

  if (/hp.*(laserjet|officejet|deskjet|envy.*printer|printer)|laserjet|officejet|deskjet|mfp|printer/i.test(haystack)) {
    const v = /epson/i.test(haystack) ? 'Epson' : /canon/i.test(haystack) ? 'Canon' : /brother/i.test(haystack) ? 'Brother' : /hp|hewlett/i.test(haystack) ? 'HP' : 'Unknown';
    return { category: 'Printers', subcategory: 'Printers', vendor: v };
  }

  if (/access.?point|ap-\d|aap\d/i.test(haystack)) {
    const v = detectVendorName(vendor);
    return { category: 'Network Infrastructure', subcategory: 'Access Points', vendor: v || 'Unknown' };
  }

  if (/switch/i.test(haystack) && !/crestron|lutron/i.test(haystack)) {
    const v = detectVendorName(vendor);
    return { category: 'Network Infrastructure', subcategory: 'Switches', vendor: v || 'Unknown' };
  }

  if (/router|firewall|gateway|fortigate/i.test(haystack)) {
    const v = detectVendorName(vendor);
    return { category: 'Network Infrastructure', subcategory: 'Firewalls', vendor: v || 'Unknown' };
  }

  if (/hp|hewlett/i.test(haystack)) {
    return { category: 'Computers & Laptops', subcategory: 'Computers & Laptops', vendor: 'HP' };
  }

  if (/dell/i.test(haystack)) {
    return { category: 'Computers & Laptops', subcategory: 'Computers & Laptops', vendor: 'Dell' };
  }

  if (/lenovo/i.test(haystack)) {
    return { category: 'Computers & Laptops', subcategory: 'Computers & Laptops', vendor: 'Lenovo' };
  }

  if (/microsoft|windows/i.test(haystack)) {
    return { category: 'Computers & Laptops', subcategory: 'Computers & Laptops', vendor: 'Microsoft' };
  }

  // Apple TV / Apple streaming boxes frequently report only vendor "Apple"
  // with a room/TV-style hostname (e.g. "FAM-TV", "Home-Theater") and no
  // device_type, so the explicit "apple tv" rule above misses them.
  if (/apple/i.test(haystack) && /\btv\b|home.?theater|theater/i.test(haystack)) {
    return { category: 'Smart TVs & Streaming', subcategory: 'Smart TVs & Streaming', vendor: 'Apple' };
  }

  if (/apple/i.test(haystack)) {
    return { category: 'Computers & Laptops', subcategory: 'Computers & Laptops', vendor: 'Apple' };
  }

  for (const rule of TYPE_RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw)) {
        return { category: rule.category, subcategory: rule.subcategory, vendor: rule.vendor };
      }
    }
  }

  return null;
}

function detectVendorName(vendor: string | null): string | null {
  if (!vendor) return null;
  for (const rule of TYPE_RULES) {
    const v = vendor.toLowerCase();
    for (const kw of rule.keywords) {
      if (v.includes(kw)) return rule.vendor;
    }
  }
  return vendor;
}

/** Check vendor_category_rules rows loaded from DB (supplemental, lower-priority
 *  than the in-code rules above). Returns null if no row matches. */
function classifyByDbRules(
  vendor: string | null,
  deviceType: string | null,
  osType: string | null,
  hostname: string | null,
): DeviceClassification | null {
  const rules = getDbVendorRules();
  if (rules.length === 0) return null;
  const haystack = [vendor, deviceType, osType, hostname]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  for (const rule of rules) {
    if (haystack.includes(rule.matchKeyword.toLowerCase())) {
      return {
        category: rule.category,
        subcategory: rule.subcategory ?? rule.category,
        vendor: rule.vendorLabel ?? vendor ?? 'Unknown',
      };
    }
  }
  return null;
}

function classifyByOui(mac: string | null): DeviceClassification | null {
  const prefix = normalizeOui(mac);
  if (!prefix) return null;
  const entry = OUI_MAP.find(e => e.prefix === prefix);
  if (!entry) return null;
  return { category: entry.category, subcategory: entry.subcategory, vendor: entry.vendor };
}

export function classifyDevice(
  hardwareVendor: string | null,
  deviceType: string | null,
  osType: string | null,
  hostname: string | null,
  mac: string | null,
): DeviceClassification {
  const isRandom = isRandomizedMac(mac);

  // Helper that annotates a classification with ownerRequired based on category.
  function annotate(cls: DeviceClassification, extraIsRandom?: boolean): DeviceClassification {
    const cat = cls.category;
    return {
      ...cls,
      isRandom: extraIsRandom ?? cls.isRandom,
      ownerRequired: OWNER_REQUIRED_CATEGORIES.has(cat),
    };
  }

  // Rule 1: hostname regex rules run BEFORE OUI so spoofed/recycled OUIs
  // (e.g. Konica-Minolta vendor with "ALARM" hostname) classify correctly.
  const byFields = classifyByFields(hardwareVendor, deviceType, osType, hostname);
  if (byFields) return annotate({ ...byFields, isRandom });

  // Rule 2: DB-backed vendor rules (supplement the in-code TYPE_RULES; allow
  // category updates without a code deploy). Checked before OUI so that a
  // DB rule for a known keyword beats a generic OUI fallback.
  const byDb = classifyByDbRules(hardwareVendor, deviceType, osType, hostname);
  if (byDb) return annotate({ ...byDb, isRandom });

  // Rule 3: OUI lookup — only meaningful for globally-administered MACs.
  // Skip for randomized MACs since their OUI is meaningless.
  if (!isRandom) {
    const byOui = classifyByOui(mac);
    if (byOui) return annotate({ ...byOui, isRandom: false });
  }

  // Rule 4: randomized MAC with a hostname → "People / Personal Devices".
  // The hostname is enough for the family to recognize the device, so
  // needsLabel stays false here — ownerRequired will still surface it in the
  // triage queue until an owner label is set.
  if (isRandom && hostname) {
    return {
      category: 'People / Personal Devices',
      subcategory: 'People / Personal Devices',
      vendor: hardwareVendor || 'Unknown',
      isRandom: true,
      needsLabel: false,
      ownerRequired: true,
    };
  }

  // Rule 5: randomized MAC with no hostname → Unknown, needs human triage.
  if (isRandom) {
    return {
      category: 'Unknown / Uncategorized',
      subcategory: 'Unknown',
      vendor: hardwareVendor || 'Unknown',
      isRandom: true,
      needsLabel: true,
      ownerRequired: true,
    };
  }

  // Rule 6: globally-administered MAC but no rule matched → Unknown, needs triage.
  return {
    category: 'Unknown / Uncategorized',
    subcategory: 'Unknown',
    vendor: hardwareVendor || 'Unknown',
    isRandom: false,
    needsLabel: true,
    ownerRequired: true,
  };
}

export interface CategoryNode {
  category: string;
  subcategory: string;
  vendor: string;
  total: number;
  active: number;
}

export interface CategoryTree {
  category: string;
  total: number;
  active: number;
  subcategories: {
    subcategory: string;
    total: number;
    active: number;
    vendors: {
      vendor: string;
      total: number;
      active: number;
    }[];
  }[];
}

function isActive(lastSeen: number | null): boolean {
  if (lastSeen === null) return false;
  const nowSec = Date.now() / 1000;
  return nowSec - lastSeen < 300;
}

export interface CategorizedDevice {
  hostname: string | null;
  ip: string | null;
  mac: string | null;
  interface: string | null;
  last_seen: number | null;
  os_type: string | null;
  hardware_vendor: string | null;
  device_type: string | null;
  tx_bytes: number | null;
  rx_bytes: number | null;
  category: string;
  subcategory: string;
  vendor: string;
}

export function buildCategoryTree(devices: CategorizedDevice[]): CategoryTree[] {
  const catMap = new Map<string, Map<string, Map<string, { total: number; active: number }>>>();

  for (const d of devices) {
    if (!catMap.has(d.category)) catMap.set(d.category, new Map());
    const subMap = catMap.get(d.category)!;
    if (!subMap.has(d.subcategory)) subMap.set(d.subcategory, new Map());
    const vendorMap = subMap.get(d.subcategory)!;
    if (!vendorMap.has(d.vendor)) vendorMap.set(d.vendor, { total: 0, active: 0 });
    const entry = vendorMap.get(d.vendor)!;
    entry.total++;
    if (isActive(d.last_seen)) entry.active++;
  }

  const result: CategoryTree[] = [];

  for (const [category, subMap] of catMap) {
    let catTotal = 0;
    let catActive = 0;
    const subcategories: CategoryTree['subcategories'] = [];

    for (const [subcategory, vendorMap] of subMap) {
      let subTotal = 0;
      let subActive = 0;
      const vendors: CategoryTree['subcategories'][0]['vendors'] = [];

      for (const [vendor, counts] of vendorMap) {
        vendors.push({ vendor, total: counts.total, active: counts.active });
        subTotal += counts.total;
        subActive += counts.active;
      }

      vendors.sort((a, b) => b.total - a.total);
      subcategories.push({ subcategory, total: subTotal, active: subActive, vendors });
      catTotal += subTotal;
      catActive += subActive;
    }

    subcategories.sort((a, b) => b.total - a.total);
    result.push({ category, total: catTotal, active: catActive, subcategories });
  }

  result.sort((a, b) => {
    if (a.category === 'Unknown / Uncategorized') return 1;
    if (b.category === 'Unknown / Uncategorized') return -1;
    if (a.category === 'People / Personal Devices') return 1;
    if (b.category === 'People / Personal Devices') return -1;
    return b.total - a.total;
  });

  return result;
}

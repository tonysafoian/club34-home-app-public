/**
 * Runtime cache for vendor_category_rules loaded from DB at startup.
 *
 * The in-code TYPE_RULES and OUI_MAP take precedence (they run first in
 * classifyDevice). The DB rules serve as a data-driven supplement: any row
 * whose match_keyword appears in the combined haystack (vendor + device_type
 * + hostname) triggers a category match for devices that the hardcoded rules
 * miss. They can also be updated without a code deploy.
 */

import { query } from './db.js';

interface DbVendorRule {
  matchKeyword: string;
  category: string;
  subcategory: string | null;
  vendorLabel: string | null;
  priority: number;
}

let _rules: DbVendorRule[] = [];

export function getDbVendorRules(): DbVendorRule[] {
  return _rules;
}

export async function loadVendorRulesFromDb(): Promise<void> {
  try {
    const { rows } = await query<{
      match_keyword: string;
      category: string;
      subcategory: string | null;
      vendor_label: string | null;
      priority: number;
    }>(
      `SELECT match_keyword, category, subcategory, vendor_label, priority
       FROM vendor_category_rules
       ORDER BY priority ASC, id ASC`,
    );
    _rules = rows.map(r => ({
      matchKeyword: r.match_keyword,
      category: r.category,
      subcategory: r.subcategory,
      vendorLabel: r.vendor_label,
      priority: r.priority,
    }));
    console.log(`[deviceRulesCache] Loaded ${_rules.length} vendor category rules from DB.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[deviceRulesCache] Failed to load vendor rules (table may not exist yet): ${msg}`);
  }
}

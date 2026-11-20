/**
 * Everything shop-specific lives here. cod.js / rebook.js / abandon.js call these hooks
 * and never touch your courier, stock or admin code directly.
 *
 * Copy this file, fill in the hooks, and pass the object as `shop` to every call.
 */
export const shop = {
  name: 'Example Shop',
  site: 'https://shop.example',
  currency: '₹',

  // Meta template names + language, exactly as approved in WhatsApp Manager.
  templates: {
    codQuestion: 'cod_order_confirm',     // UTILITY · quick replies: "Yes, confirm order" / "No, cancel order"
    addressQuestion: 'address_confirm',   // UTILITY · quick replies: "Address is correct" / "Change address"
    rebook: 'order_rebook',               // MARKETING · URL button with {{1}} suffix
    bagReminder: ['bag_reminder_v2', 'bag_reminder'],   // MARKETING · newest first; next one is used while the newest is in review
    lang: 'en',
  },

  // Business numbers that must never get automatic messages (owner, staff, test phones).
  ownPhones: [],

  /** JPG/PNG URL for the template's image header (WebP is refused by WhatsApp). '' = logo. */
  photoFor(order) { return this.site + '/logo.png'; },

  /**
   * Is the address too weak for a courier? Return '' when fine, else a short reason.
   * Typical India COD rule: line1 needs a house/flat/door number and ≥ 3 words.
   */
  addressWeak(order) {
    const a = order.address || {};
    const line = [a.line1, a.line2].filter(Boolean).join(' ');
    if (!/\d/.test(line)) return 'no house / flat number';
    if (line.trim().split(/\s+/).length < 3) return 'address too short';
    if (!/^\d{6}$/.test(String(a.pin || ''))) return 'PIN code missing';
    return '';
  },

  /** Book the courier. Return { ok, awb?, error? }. Called once, after the customer taps Yes. */
  async book(env, db, order) { return { ok: false, error: 'book() not wired yet' }; },

  /** Undo stock etc. for a cancelled order. Order status is already 'cancelled' when this runs. */
  async cancel(env, db, order, reason) { return { ok: true }; },

  /** Which of these items can still be bought (for "order again"). */
  async inStock(env, db, items) { return items; },

  /** URL suffix for the rebook template's URL button, restoring the bag: https://shop.example/cart?restore={{1}} */
  cartSuffix(items) { return items.map((i) => encodeURIComponent(i.sku) + '-' + (i.qty || 1)).join(','); },

  /**
   * Tell the owner. NEVER put the customer's phone number in Discord/Slack: they are
   * third-party processors (GDPR / India DPDP minimisation). Name + order id is enough;
   * the number is in your admin.
   */
  async alertOwner(env, title, body) {
    if (!env.OWNER_WEBHOOK) return;
    await fetch(env.OWNER_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, content: ('**' + title + '**\n' + body).slice(0, 1900) }) }).catch(() => {});
  },
};

# WhatsApp templates to submit

WhatsApp Manager → Message templates → Create. Language: English (`en`), or add
a translation per language you support. Body variables are `{{1}}`, `{{2}}`, …
in this order. **Use the category given.** Meta re-checks it, and a mismatch is
rejected or switched to MARKETING.

Give Meta a realistic example value for every variable. Bare "{{1}}" examples
are a common reason for rejection.

---

## 1. `cod_order_confirm` · UTILITY
**Header:** Image (example: a product photo, JPG/PNG)
**Body:**
```
Hi {{1}}, thank you for your order {{2}} from <Shop Name>.

Item: {{3}}
Amount to pay at delivery: {{4}}
Deliver to: {{5}}

Please confirm so we can ship it today.
```
**Buttons (Quick reply):** `Yes, confirm order` · `No, cancel order`
Order matters: index 0 = Yes (`CODY|<id>`), index 1 = No (`CODN|<id>`).

## 2. `address_confirm` · UTILITY
**Header:** Image
**Body:**
```
Hi {{1}}, before we ship order {{2}}, please check your delivery address:

{{3}}

Is it complete, with house / flat number?
```
**Buttons (Quick reply):** `Address is correct` · `Change address`

## 3. `order_rebook` · MARKETING
**Header:** Image
**Body:**
```
Hi {{1}}, we could not confirm your earlier order, so it was cancelled.

{{2}} is still available. Tap below to get the same bag back - it takes a few seconds.
```
**Footer:** `Reply STOP to stop offers`
**Buttons:** URL, dynamic: `https://<your-site>/cart?restore={{1}}` with the label `Order again`
(The code passes the suffix, e.g. `SKU1-1,SKU2-2`, so the cart page must accept that format.)

## 4. `bag_reminder_v2` · MARKETING
**Header:** Image (your logo or a product photo)
**Body:**
```
Hi {{1}}, you left {{2}} in your bag at <Shop Name>.

It is saved for you - tap below to finish your order.
```
**Footer:** `Reply STOP to stop offers`
**Buttons:** URL, dynamic: `https://<your-site>/cart?restore={{1}}`, label `Complete my order`

Keep the **previous** version (`bag_reminder`) approved when you edit the copy. The code
uses it while the new one is in review (`shop.templates.bagReminder` = newest first).

---

## Tips that get templates approved
- No "payment failed", "urgent" or pressure wording in UTILITY. Most shoppers never even tried to pay, they just closed the window. "You left X in your bag" is both true and approvable.
- Don't put prices or discounts in a UTILITY template. Those make it marketing.
- One clear purpose per template. A confirmation should not also sell.
- A UTILITY template rejected as MARKETING: reword it as a transaction step ("before we ship"), with no offers.

## Rough costs (India, check current Meta pricing)
- UTILITY inside an open customer-service window: free. Otherwise about ₹0.1–0.2 each.
- MARKETING: about ₹0.8 each. Meta may also *decline to deliver* marketing to people who already get a lot of it (error `131049`). That isn't your fault, but don't resend straight away.

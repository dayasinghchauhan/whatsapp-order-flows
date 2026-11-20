# Why each rule exists

These rules come from running COD confirmation over WhatsApp.
Each one prevents a common failure.

| Rule | The failure it prevents |
|---|---|
| Ask before booking the courier | An unconfirmed COD parcel that comes back costs forward + return shipping, with nothing earned. |
| Address question **before** the COD question | A "Yes" on an address with no house number still fails at the door. A weak address is asked first, and the COD question follows once it's settled. |
| Show the full address in the question | If the address in the question is shortened, the customer confirms an address they can't fully see. Show all of it; drop filler lines like "Street" / "NA" instead. |
| Keep city / state / PIN from checkout when saving a typed address | Those decided the courier and the COD fee. A *different* PIN in the reply means a different place, so the owner handles it. |
| Location pin after "Yes" when the address is still weak | The tap opens the 24 h window, so the free-form "Send location" button is allowed straight away. |
| Button acts only from the order's own phone | Forwarded messages and family phones exist. A tap from another number must not confirm or cancel someone else's order. |
| Compare-and-set status | Double taps, Meta webhook retries and the owner pressing Cancel in the admin at the same moment. |
| Late tap → one polite reply | Customers tap "Yes" days after the owner cancelled. Reply once ("already cancelled"), never re-open. |
| 131026 → owner now | Some numbers aren't on WhatsApp. Waiting 6 h for a reminder that fails the same way, then 24 h for the alert, loses a day. |
| No auto-cancel | Many silent buyers answer a phone call. The owner decides. |
| "Order again" chosen by events | Owners type free-text cancel reasons ("cust not responding", "no reply"…). Matching text misses half of them. The `cod_noreply_alert` event is exact. |
| Once per number, ever | A second "order again" is spam, and it gets your number quality-rated down. |
| Bag reminder waits (15 / 30 / 60 min) | A shopper whose UPI failed is often retrying right then. A message mid-retry looks like a bot and interrupts the purchase. |
| A cancelled order doesn't block the bag reminder | A COD order cancelled after the try means the bag is open again. |
| Second reminder allowed after a new try | A shopper who comes back after the first message is *more* interested. Capped at 2 per 7 days, 24 h apart. |
| A refused send doesn't count toward the cap | If a `131049` (Meta chose not to deliver) counted toward the cap, one refused send would block an interested buyer for a week. |
| …but it does count for the 24 h gap | Otherwise a `131049` number is retried every 30 min. |
| Warm-buyer alert (3rd try in 7 days) | These are the most valuable people to call. Send name + bag, never the number. |
| Template not ready = wait | Templates spend hours to days in review. Marking jobs "done" on `132001` silently drops every customer from that period. |
| Owner's own numbers excluded | Test orders from the owner's phone shouldn't trigger marketing or alerts. |
| No phone numbers in Discord / Slack | They're third-party processors. Under the DPDP Act / GDPR, minimise. Name + order id is enough, and the number stays in your admin. |
| Signature check, 200 on ignore | Unsigned bodies must not write to the DB. A non-200 makes Meta retry for days. |

## Meta error codes used
| Code | Meaning | What the code does |
|---|---|---|
| 131026 | Message undeliverable (not on WhatsApp, old app, blocked) | owner alert now |
| 131047 | Re-engagement: > 24 h since the customer last wrote | only templates may go |
| 131049 | Meta chose not to deliver (ecosystem / marketing limit) | logged as failed, counts for the gap only |
| 131050 | User stopped marketing messages | treat as opted out |
| 131048 / 130429 / 80007 | Spam rate / throughput / account rate limit | stop this run |
| 132000 / 132001 / 132005 / 132007 / 132015 / 132016 | Template params mismatch / doesn't exist (in this language) / text too long / policy / paused / disabled | job waits, nothing marked |

## Opt-out
"STOP" (or "unsubscribe", "stop offers") → `wa_optin = 'out'`. Marketing (order again,
bag reminder) never goes to opted-out numbers. Order updates (UTILITY) still do,
because they're about an order the customer placed.

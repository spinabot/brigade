---
name: lead-scout
description: How to find and VERIFY business leads (any niche, any city) using web_search, browser-rendered map listings, and primary sources. Use whenever the user asks to find businesses, shops, vendors, professionals, or sales leads in a location — especially "businesses without a website" prospecting.
metadata:
  {
    "brigade":
      {
        "emoji": "🎯",
      },
  }
---

# Lead Scout

Goal: a VERIFIED lead = business name + phone/address confirmed on a primary source, with a source URL per fact. Needs no API key — the browser tool does all the heavy lifting.

## The ladder (stop at the first level that yields verified leads)

1. **Search first.** `web_search`: `"<niche> in <city> contact number"`, `"<niche> <city> site:.in"`, `"<city> <trade> phone"`. Open the top organic hits that are the business's OWN site or social page.
2. **Search dead (rate-limited / empty)?** Run the same query in the browser: `navigate` to `https://www.bing.com/search?q=<query>` (or `https://duckduckgo.com/html/?q=<query>`, `https://www.google.com/search?q=<query>`), then `snapshot`. Search engines render fine in the browser — never declare them a dead end.
3. **Map listings — the best business source.** `navigate` to `https://www.google.com/maps/search/<niche>+in+<city>`, then `snapshot` the results panel. Click a listing (use snapshot refs) and `snapshot` again to read its panel: name, rating, review count, address, phone — and a **Website link only when the business has one**.
   - Prospecting for businesses that NEED a website: a listing with a phone number but NO Website link is exactly that lead. Listings whose "website" is only a social page are the next-best segment.
   - Map pages never go network-idle; navigate with default `domcontentloaded` (or `waitUntil: "commit"` if it hangs) and just snapshot.
4. **A places/maps tool or skill in your list?** Prefer it over any page scraping — structured place data beats snapshots.
5. **Verify before reporting.** Cross-check phone/address on the business's own site or social page when one exists. Report each lead with the source URL per fact.

## Anti-patterns

- Do NOT start at aggregator/directory listing sites. They are bot-walled, stale, and list call-tracking numbers instead of the business's real phone. Use one only as a last-resort pointer, then verify on a primary source.
- Do NOT declare a search engine or map "JS-heavy" and give up — the browser renders JS by definition; snapshot the page.
- Do NOT report a lead without a source URL, and never invent phone numbers from memory.
- Do NOT hammer one site with rapid repeated navigations; pace requests like a human reading pages.

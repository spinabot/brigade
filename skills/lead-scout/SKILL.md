---
name: lead-scout
description: How to find and VERIFY business leads (any niche, any city) — especially "businesses without a website" prospecting. Decides "no website" by SEARCHING the business name, not by a map button. Use whenever the user asks to find businesses, shops, vendors, professionals, or sales leads in a location. No API key needed — web_search + the browser do everything.
metadata:
  {
    "brigade":
      {
        "emoji": "🎯",
      },
  }
---

# Lead Scout

Goal: a **verified lead = a business that has NO website of its own**, confirmed by *searching for it* — the use case is selling websites to businesses that don't have one. Keyless: `web_search` + the browser do all the work, no API key.

## The rule — what counts as "having a website"
A business has a website only if it has its **own site**: an official domain (e.g. `cafeborkar.com`, `artjuna.in`). These do **NOT** count as a website:
- **Social pages** — instagram.com, facebook.com
- **Aggregators / directories** — zomato, swiggy, justdial, tripadvisor, magicpin, dineout
- Its **Google Maps / Google Business** listing

So if searching for the business surfaces **only** those, it has **no website → it's a lead**.

## Method — decide by SEARCH, never by a map button
1. **Get candidate names — `web_search` FIRST** (don't drive Maps unless search is unavailable):
   - `web_search "<niche> in <city>"` returns businesses + their domains. Often this single search already answers it — a business appearing only on aggregators/social with no own domain is your lead.
   - ONLY if `web_search` is down/rate-limited: browser `navigate` to `https://www.google.com/maps/search/<niche>+in+<city>`, then **one** `snapshot` (snapshotFormat:`"text"`)/`evaluate` to read the whole list at once (never screenshot or click each listing). `scroll` (to:`"bottom"`) + snapshot again for more.
2. **Decide per business with a search** — THIS is the step that determines "no website":
   - `web_search "<business name> <city>"`. (If `web_search` is rate-limited, run the same query in the browser: navigate to a Bing / DuckDuckGo-html / Google results URL, then `snapshot`.)
   - Scan the results: is any result the business's **own domain** (per the rule above)?
     - **Yes** → it HAS a website — skip it, not a lead.
     - **Only** social / aggregator / Maps results → **no website → it's a lead.**
   - Not sure which result is theirs? Open the top non-social hit and `snapshot` to confirm whose site it is.
3. **Report** each lead with the **evidence**: name, area/address + phone if found, and *why* it's a lead — e.g. *"searched 'Cafe Borkar Panaji' — only an Instagram page and a Zomato listing came up, no own website."*

## Phone / address
Read them from the search results or the business's own social page. Google Maps hides the phone behind a sign-in in its UI — don't fight that panel; the number is usually right there in the search results or on their Instagram/Facebook.

## Anti-patterns
- **NEVER decide "no website" from a missing Google Maps "Website" button.** That only means nobody linked a site to Google — the business may well have one. The ONLY valid way to decide is to **search the business name** and see whether its own site appears.
- Don't screenshot a listing and read it visually, and don't click into each listing one-by-one — read a list with ONE `snapshot`/`evaluate`, then decide by search.
- Don't spawn a sub-agent just to look up or verify a list — do it inline; a lookup doesn't need a crew.
- Don't report a lead you haven't actually searched for; never invent phone numbers from memory.
- If you find yourself repeating the same action without new results, STOP and report what you have so far.
- Don't treat an aggregator/directory page as the business's website or as the source of truth.

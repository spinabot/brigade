---
name: oauth-setup
description: Connect an OAuth 2.0 service (Gmail, Google APIs, etc.) using the built-in oauth_authorize tool — get a click-to-authorize link, auto-capture the code, and seal the tokens. Use whenever the operator asks to connect Gmail / a Google API / any OAuth account.
metadata:
  {
    "brigade":
      {
        "emoji": "🔐",
      },
  }
---

# OAuth setup

Use the **`oauth_authorize`** tool — NEVER hand-roll an `http` listener in bash. It opens a one-shot loopback listener on a free port (no EADDRINUSE, no port juggling), captures the code, and seals the tokens into the credential store.

## The two mistakes to avoid (they cost a whole session once)

1. **Use a Desktop-app OAuth client**, not a Web client. In Google Cloud Console → Credentials → Create OAuth client ID → **Application type: Desktop app**. Desktop clients accept ANY `http://127.0.0.1:<port>` loopback redirect with **no redirect-URI registration**. A *Web* client requires the exact redirect URI pre-registered, which is what causes `redirect_uri_mismatch`.
2. **Use the real scope.** Gmail send is `https://www.googleapis.com/auth/gmail.send` (NOT `https://gmail.com/...`, which doesn't exist). Add `openid https://www.googleapis.com/auth/userinfo.email` if you want the account address auto-filled.

## Flow

1. Ask the operator to create a **Desktop-app** OAuth client (Gmail API enabled, consent screen in Testing with themselves as a test user) and paste the **client id + secret**.
2. **Start** the flow:
   ```
   oauth_authorize({
     action: "start",
     provider: "google-gmail",
     authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
     tokenEndpoint: "https://oauth2.googleapis.com/token",
     userInfoEndpoint: "https://www.googleapis.com/oauth2/v3/userinfo",
     clientId: "<id>", clientSecret: "<secret>",
     scopes: ["https://www.googleapis.com/auth/gmail.send", "openid", "https://www.googleapis.com/auth/userinfo.email"],
     extraAuthParams: { access_type: "offline", prompt: "consent" }
   })
   ```
   `access_type=offline` + `prompt=consent` are required for a **refresh token** (otherwise re-auth is needed when the access token expires).
3. Send the operator the returned `authUrl` to click.
4. **Await** the redirect — it exchanges the code and seals the tokens:
   ```
   oauth_authorize({ action: "await", flowId: "<flowId from start>" })
   ```
   If it returns status `pending`, the operator hasn't clicked yet — tell them, then call `await` again.

## Using a connected account (sending mail)

The tokens are sealed in the credential store — you can't read them from a file or the DB, and you shouldn't try. To use a connected account:

1. **Check what's connected:** `oauth_authorize({ action: "status" })` → lists each account (provider, email, scopes, expiry). No secrets.
2. **Get a usable token:** `oauth_authorize({ action: "token", provider: "google-gmail" })` → returns `accessToken`. It auto-refreshes from the sealed refresh token when the old one expired, so you always get a live token. (Pass `provider` only if more than one account is connected.)
3. **Call the API** with it. Gmail send:
   `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, header `Authorization: Bearer <accessToken>`, body `{ "raw": "<base64url RFC-822 message>" }`.

Never `cat` the credential store, grep for the token, or hand-roll a refresh — `action:"token"` is the only retrieval path, and it keeps the refresh token + client secret sealed.

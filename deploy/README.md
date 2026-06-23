# deploy/cwviz-redirect

Cloudflare Worker that 301-redirects **viz.quel.computer → github.com/umgbhalla/cwviz**
(path + query preserved).

```bash
cd deploy/cwviz-redirect
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bunx wrangler deploy
```

The `viz.quel.computer` Workers Custom Domain auto-provisions the DNS record + TLS cert,
so no separate DNS edit is needed. (If your API token lacks zone *Workers Routes* perms,
attach the domain via the account `workers/domains` API instead — wrangler's default uses
the zone-route endpoint.)

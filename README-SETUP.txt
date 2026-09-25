NATEFLIX v1.2.0 — DEPLOYMENT SETUP

UPLOAD TO GITHUB
Upload the CONTENTS of this folder to the root of the existing nateflix repository so it contains:

index.html
api/watch.js
api/community.js

Vercel will deploy from the main branch as usual.

EXISTING STREAMING LINKS
Keep the WATCHMODE_API_KEY environment variable you already added. No Watchmode changes are needed.

ONE-TIME SETUP FOR SUGGESTIONS + COMMUNITY TAKES
The new public/private suggestion board, Nate replies, and per-title community takes need shared storage so posts are visible across devices.

1. In the Nateflix project in Vercel, open Storage / Marketplace and connect an Upstash Redis database to the project.
2. After connecting it, Vercel/Upstash should add either:
   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
   OR
   KV_REST_API_URL + KV_REST_API_TOKEN
3. In Vercel > Nateflix > Settings > Environment Variables, add:
   NATEFLIX_ADMIN_KEY = a private password/passphrase only you know
   Enable it for Production (Preview too if you want to test previews).
4. Redeploy Nateflix after those variables are present.

OWNER MODE
At the bottom of “The... Better?” tab there is an Owner mode button. Enter your NATEFLIX_ADMIN_KEY there to see private suggestions, reply to suggestions, and delete posts. The key is kept only in that browser tab/session; do not share it.

PRIVATE SUGGESTIONS
Private suggestion submitters receive an invisible browser token stored on their own device so they can see your reply later without creating an account. Clearing that browser’s site data removes their local receipt.

IF REDIS IS NOT SET UP YET
The Good, The Bad, search, posters, title cards, Nate’s Takes, IMDb links, and Watchmode streaming links still work. Only shared suggestions/community posts will show a storage-not-configured message.

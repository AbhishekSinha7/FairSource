# Firebase Hosting public folder

Intentionally empty. Firebase Hosting serves nothing static: `firebase.json` routes every request to Cloud Run.
`/v1/**` goes to `api`, `/mcp` to `mcp`, and everything else to `web`. This file is excluded from the deploy.

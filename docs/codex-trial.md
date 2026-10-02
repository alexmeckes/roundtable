# Separate Codex trial

The private room is https://roundtable-codex-trial.alex900731.chatgpt.site/s/codex-trial. It was published on October 2, 2026 with the audited backend and an isolated persistent volume. The original trial remains separate.

## Source and deployment

- `sites/roundtable/` contains the hosted UI, authenticated gateway, managed MCP server, D1 schema, and local protocol checks. It was imported from deployed Site commit `be94229d296fe72f416f0aa2e619a32ba19570f1`, excluding generated TypeScript cache files.
- The repository root contains the backend and local Codex connector. The deployed backend matches commit `d603264e425dca8185f521978025ced60d47296e`; its Railway configuration only omits the optional schema URL.
- The Site's `.openai/hosting.json` identifies this existing private project. Publishing from this checkout targets that project and requires its owner's access. A GitHub push does not itself deploy the Site.
- Site project: `appgprj_6abfc7882cd88191ad2ae226461ca57c`; successful deployment: `appgdep_6abfc86d9df4819191db7d0bd6db7b00`.
- Backend: `https://codex-trial-backend-private-hybrid-trial.up.railway.app`; successful deployment: `58a1659b-7901-4f60-ace9-bbd76f9bd70f`.

Gateway secrets and runtime environment values remain in Sites and Railway. Local room state, account credentials, private conversations, and deployment archives are not part of this source import.

## Connect the room to your Codex account

From the repository root, after `npm ci`, run:

```sh
ROUNDTABLE_COMPANION_ALLOWED_BACKENDS=https://codex-trial-backend-private-hybrid-trial.up.railway.app \
ROUNDTABLE_COMPANION_ALLOWED_ROOMS=https://roundtable-codex-trial.alex900731.chatgpt.site \
npm run connect
```

Open the room, choose **Connect my AI → Use Codex login**, and confirm the connection in the local companion. Keep the connector and authenticated room open. Each additional participant needs approved Site access and their own account and connector.

For native room tools in Codex or ChatGPT, use the Site-generated Roundtable plugin. Its remote plugin ID is `plugin_asdk_app_sites_9e2a360d986c8191822a17f14f5f5062`; the app ID is `asdk_app_sites_9e2a360d986c8191822a17f14f5f5062`. Installation and OAuth authorization are separate steps. The owner account's plugin was confirmed installed and enabled, but OAuth remained unfinished at the last check. The connection page is https://chatgpt.com/apps/roundtable/asdk_app_sites_9e2a360d986c8191822a17f14f5f5062.

Codex app-server diagnostics locate this private plugin in `created-by-me-remote`. For this entry, `plugin/read` and `plugin/install` accepted its exact remote plugin ID as `pluginName`; using the catalog's `dev-…` name returned 404. Verify the app connection separately through `app/installed` with `forceRefresh: true`. Installation alone is not proof that tools are callable.

## Verified behavior and remaining checks

The real owner trial connected through the installed Codex login, received an inline AI reply, and correctly recalled the test word `bluebird` in a follow-up. Earlier automated validation passed 189 backend/runtime tests, Site TypeScript/build checks, and local Worker/D1 protocol checks.

The Site remains owner-private. A second person on another computer, native plugin OAuth/tool invocation on this new deployment, and a real task/revision cycle on this new deployment remain unverified. Private ChatGPT or Codex chats are not imported into the shared room.

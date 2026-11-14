# Next.js example

A small Next.js app that stores Better Auth's users, accounts and sessions in
Elasticsearch through `better-auth-elasticsearch`. It offers email and password
sign-up, sign-in and sign-out, and shows the signed-in user and session.

The app installs the adapter from a tarball packed from this repository, so it
runs exactly the files the npm package ships.

## Run it

You need Node.js 22.18 or later (the scripts run TypeScript directly), pnpm
and Docker.

1. Start Elasticsearch from the repository root:

   ```bash
   docker compose up -d --wait
   ```

2. Install the packed adapter and the app's dependencies:

   ```bash
   cd examples/nextjs
   pnpm adapter:install
   ```

   This builds the adapter, packs it into `.adapter/` and installs the tarball.
   Run it again after changing the adapter.

3. Copy `.env.example` to `.env` and set `BETTER_AUTH_SECRET`
   (`openssl rand -base64 32`). `ELASTICSEARCH_URL` already points at the
   compose file's server.

4. Start the app and open <http://localhost:3000>:

   ```bash
   pnpm dev
   ```

On first use the adapter creates one alias per model under the prefix
`example`: `example_user`, `example_account`, `example_session` and
`example_verification`, each over a versioned index such as `example_user_v1`.

## Where to look

- [`src/lib/auth.ts`](src/lib/auth.ts): the Better Auth configuration with the
  adapter, including an additional `company` field on the user. The adapter
  maps it like any other field, and the sign-up form fills it in.
- [`scripts/migrate.mts`](scripts/migrate.mts) (`pnpm migrate`): moves models
  whose field types changed to a new index version. Try it by adding a
  number field under `user.additionalFields` in `auth.ts`, signing up, then
  changing the field's type to `string`.
- [`scripts/purge.mts`](scripts/purge.mts) (`pnpm purge`): deletes expired
  sessions and verification tokens. In a real app, run it on a schedule.

Both scripts run with plain Node, outside Next.js.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

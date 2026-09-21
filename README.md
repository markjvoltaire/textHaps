# imessage-agent

A [Spectrum](https://photon.codes/docs/spectrum-ts) project. Wired with: imessage.

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

From [Anthropic](https://console.anthropic.com):

- `ANTHROPIC_API_KEY`

From the [Supabase project](https://supabase.com/dashboard/project/kvjdiwfqskywehwjinzs/settings/api):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Run

```sh
npm install
npm run start
```

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Edit `src/index.ts` to replace the echo loop with real agent logic.
- Add more providers from `spectrum-ts/providers/*`.

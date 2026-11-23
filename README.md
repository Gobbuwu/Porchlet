# Porchlet

An open-source, self-hosted client portal for freelancers. You deploy your own copy on Vercel (or Netlify) with your own free Supabase project, invite clients into workspaces, and share files with them.

**Status: pre-alpha, milestone M0 (repo and pipeline).** Nothing user-facing works yet. Don't use it for real client data.

## Stack

Next.js (App Router, TypeScript) and Supabase (Postgres with Row Level Security, Auth with TOTP 2FA, Storage). See [docs/adr](docs/adr) for why.

## Local development

Needs Node 22 or later and Docker.

```sh
npm ci
npm run db:start              # local Supabase in Docker; prints local URLs and keys
cp .env.example .env.local    # then paste the local publishable key
npm run dev
```

Checks: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:db` (pgTAP, needs `db:start`) and `npm run test:e2e` (Playwright; run `npx playwright install` once). CI runs these and more on every PR; see [.github/workflows/ci.yml](.github/workflows/ci.yml) and [ADR 0012](docs/adr/0012-ci-pipeline.md).

## Docs

- Decisions: [docs/adr](docs/adr)
- Milestones: [docs/milestones](docs/milestones)
- Definition of done for 1.0: [docs/definition-of-done-1.0.md](docs/definition-of-done-1.0.md)

## Licence

MIT, see [LICENSE](LICENSE).

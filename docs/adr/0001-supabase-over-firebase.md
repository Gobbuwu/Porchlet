# 0001. Supabase over Firebase

- Status: Accepted (2026-11-23, by Gobbu)

## Context

Porchlet is a real product and also a test target for [SiegeKit](https://github.com/Gobbuwu/SiegeKit). It needs sign-up, email password reset, TOTP 2FA, a storage bucket and data shared between users, on a $0 budget.

## Options

1. **Supabase.** SiegeKit's live backend check reads Supabase tables. The whole stack runs locally with `supabase start`, which matters because most SiegeKit active checks run only on local targets. TOTP 2FA is free on every project.
2. **Firebase.** SiegeKit reads the Realtime Database but not Firestore or Cloud Storage live (SiegeKit ADR 0037: "Firestore and Cloud Storage are not read live"). TOTP 2FA needs the Identity Platform upgrade (unverified).

Source for both: the project research note `product-ideas.md` (2026-11-23), which quotes SiegeKit ADR 0037 and the Supabase pricing pages.

## Decision

Supabase: Postgres with Row Level Security, Supabase Auth and Supabase Storage.

## Consequences

- Security rests on SQL policies, which pgTAP can test in CI.
- `supabase start` was measured working in a cloud session on 2026-11-23 (see [M0](../milestones/M0.md)).
- Each operator needs their own Supabase project. The free plan pauses idle projects (handled in M5).

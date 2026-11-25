# 0006. Workspaces, memberships and invitations are created only through security definer functions

- Status: Accepted (2026-11-25, M2 PR 1)

## Context

M2 adds `workspaces`, `workspace_members`, `invitations` and `projects` (design doc section 3, [M2.md](../milestones/M2.md)). A row in the first three decides who can see what: a membership's `role` makes someone an owner, an invitation's token lets someone join. If the API could insert them, a user could pick their own role, add themselves to a workspace, or plant an invitation with a token they know (threats T2, T3 and T4 in M2.md).

## Options

| Option | What a direct API caller can do | Cost |
|---|---|---|
| A. Insert grants with RLS `with check` policies (for example, a membership insert allowed when a matching unaccepted invitation exists) | Whatever the policy forgets: the policy must re-derive the role, the inviter and the token rules from columns the caller chose, and it can't make a token or mark an invitation used in the same step | Policies hard to read and test, and an accept is still two writes (membership, `accepted_at`) that the client would have to make in order |
| **B. No insert grant on these three tables; `security definer` functions do the inserts** (chosen) | Only what each function allows: the function sets `role`, `invited_by`, the token and `accepted_at` itself | Four functions, each with pgTAP; the functions must check the caller themselves, because they bypass RLS |

`projects` keeps a direct insert grant (columns `workspace_id` and `name` only) under an owner-only `with check` policy, as the design has it: nothing in a project row grants access.

## Decision

Option B. `authenticated` has no insert or update grant on `workspaces`, `workspace_members` or `invitations`. These functions, all `security definer` with `search_path = ''` and executable by `authenticated` only, are the way in:

- `create_workspace(name)`: the caller must be `private.instance.admin_user_id`; inserts the workspace and the owner membership.
- `create_invitation(workspace, email)`: owner only; stores the sha256 of 32 random bytes and returns the raw token once, with the invitation id.
- `accept_invitation(token)`: the token's invitation must be unused and unexpired, and the caller's own `auth.users` row must have the invited email, confirmed; inserts a `client` membership and sets `accepted_at`.
- `list_workspace_members(workspace)`: owner only, members with their emails (decision D3).

Details decided while building it, each measured or tested:

1. **Policies use set-returning helpers.** Policies are written `workspace_id in (select private.member_workspace_ids())` (and `owner_workspace_ids()`, `co_member_ids()`), not the design's per-row `private.is_member(workspace_id)`. A `security definer` function is never inlined, so the per-row form runs one query per row; the set form runs once per statement and is hashed. Measured with `scripts/dev/policy-perf.sql` (local stack, Supabase CLI 3.2.0, Postgres 17.12; 10,000 users, 1,000 workspaces, 20,000 projects, a user who sees 100), five runs each:

   | Query | Per-row `is_member()` | Set-based (chosen) |
   |---|---|---|
   | All visible projects | 121.9 to 201.8 ms | 2.7 to 3.6 ms |
   | One workspace's projects | 0.20 to 0.28 ms | 0.08 to 0.22 ms |

   Same rows either way (100 and 20). The helpers return only the caller's own workspaces or co-members, so `authenticated` learns nothing by calling them.

2. **`(select auth.uid())` is kept.** Same script, own-profile policy on 10,000 profiles: with index scans on, both forms take about 0.008 ms (the planner uses the primary key either way); with index scans forced off, the bare `auth.uid()` took 6.3 to 9.7 ms and `(select auth.uid())` 0.49 to 0.67 ms. That confirms the design's wording, which was unverified.

3. **The hourly invitation cap is counted from `private.invitation_sends`, not from `invitations`.** The design counted `invitations.created_at`, but owners may delete invitations, so revoking and inviting again would get past the cap (planted case P20 in M2.md: the "21st invitation within the hour, even after revoking one" test fails on the design's version). `invitation_sends` keeps one row per invitation made, for an hour, with no grants and RLS on ([ADR 0017](0017-rls-on-private-tables.md)).

4. **Caps can't be raced.** `create_invitation` locks the workspace row and takes a per-owner advisory lock before counting, held until the caller's transaction ends, and refuses `repeatable read` and `serializable`, as `rate_limit_take` does ([ADR 0022](0022-atomic-rate-limit-take.md)). `accept_invitation` locks the invitation row before checking it. `scripts/ci/db-race-check.sh` runs both races with two sessions in CI.

5. **`token_hash` is not selectable.** `authenticated` gets a column-level select on `invitations` without it; nothing in the app needs it.

6. **The email and confirmation come from `auth.users`, not the JWT.** The function reads the caller's own row, which is current even if the JWT was issued before an email change.

7. **Errors.** Refusals the app shows use SQLSTATE `P0001` with a fixed message (`invitation_invalid`, `invitation_used`, `invitation_expired`, `invitation_wrong_account`, `email_not_confirmed`, `already_member`, `invitation_pending`, `invalid_email`, `workspace_invitation_limit`, `hourly_invitation_limit`). A caller who isn't entitled gets `42501 not_allowed`, the same for a workspace that doesn't exist, so the answer doesn't confirm one exists.

## Consequences

- `authenticated` now has usage on schema `private` and execute on exactly the three set-returning helpers; baseline test 5 lists them, so a new grant fails CI. Every private table still has no grants and RLS on.
- These functions bypass RLS, so their own checks are the only gate. Each check has a pgTAP test, and each test was shown failing on a planted bad case (M2.md).
- M4 adds `aal2()` to the owner checks in these functions and to the owner policies (decision D1), with tests using AAL1 and AAL2 claims.
- PR 3 (invites) calls `create_invitation` before sending the email and deletes the invitation if sending fails; it shows the `P0001` messages as text.
- An owner's `auth.users` row can't be deleted while a workspace they created exists (`workspaces.created_by` has no cascade; pgTAP test 83 in `040_workspaces`). Deleting a workspace is not in the MVP, so an owner account can't be deleted from the dashboard either. Recorded as a gap in M2.md.

# 0026. Owners can withdraw only invitations not yet accepted

- Status: Accepted (2026-11-25, M2 PR 3, after Gobbu's `/review-critical` on 874534d). Narrows the owners' delete policy from [ADR 0006](0006-inserts-through-security-definer-rpcs.md)'s PR 1 migration; withdrawal itself is in [ADR 0024](0024-invite-delivery.md) section 5.

## Context

Gobbu's `/review-critical` on 874534d found that withdrawing could delete an accepted invitation: the owners' delete policy on `invitations` checked only the workspace, and `revokeInvitation` filtered on id and workspace. A client accepting while the owner's page was open, or at the same moment (the delete waits on `accept_invitation`'s `for update` lock, then re-checks the row), lost the record of their join while staying a member, and the owner was told the invitation was withdrawn. No account was lost: the cleanup skips accepted rows.

## Decision

| Option | Coverage |
|---|---|
| **The delete policy also requires `accepted_at is null` (chosen; narrows a permission, OK'd by Gobbu 2026-11-25, 15:25 UTC), and the action filters the same way** | Every API caller, not only the action. A delete that waited on an accept re-checks the policy's condition on the accepted row and deletes nothing (race check 6, measured). A workspace's deletion still removes all its invitations: the foreign key's cascade doesn't go through the policy |
| Filter only in the action | A direct API call could still delete accepted rows |

When the delete removes nothing, `revokeInvitation` reads the row (owners can, `invitations_select_owner`) and, if it was accepted, answers "This invitation was already accepted, so it can't be withdrawn." instead of the general refusal.

## Consequences

- Migration `20261125050000_invitations_delete_unaccepted.sql`; `070_invite_cleanup.test.sql` tests 26 to 28; `scripts/ci/db-race-check.sh` check 6; the E2E test "an invitation accepted after the owner's page loaded can't be withdrawn". With the old policy and no filter in the action, all of them fail (M2.md section 10, planted W1 and W2).
- Accepted invitations stay until their workspace is deleted. They hold no pending slot.
- Hosted projects need the migration (rollout part 3 for `porchlet-test`).

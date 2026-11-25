-- M2 PR 3, after Gobbu's /review-critical on 874534d (ADR 0026). Checked by
-- supabase/tests/database/070_invite_cleanup.test.sql.
--
-- Owners may delete (withdraw) only invitations not yet accepted. The policy allowed any row of a
-- workspace they own, so withdrawing an invitation that was accepted while the owner's page was
-- open, or at the same moment (the delete waits on accept_invitation's row lock, then re-checks the
-- row), deleted the record of that join while the client stayed a member. The policy's condition
-- is re-checked on the new row version after such a wait, so an accept that commits first now
-- leaves the row in place. Deleting a workspace still removes all its invitations (the foreign
-- key's cascade doesn't go through this policy).
alter policy invitations_delete_owner on public.invitations
  using (workspace_id in (select private.owner_workspace_ids()) and accepted_at is null);

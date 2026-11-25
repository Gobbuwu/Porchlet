import { expect, test } from "./support/test";
import { alertIn } from "./support/users";
import { createWorkspace, logInAsAdmin, rpc, uniqueName } from "./support/workspaces";

// Threat T7: Supabase Auth puts no per-address limit on invite emails (M2.md D2), so Porchlet's
// cap of 20 invitations per owner per hour is the only one. This uses up the E2E admin's hour, so
// it runs in its own project after the other tests (playwright.config.ts, ADR 0024).

test("an owner's 21st invitation in an hour is refused", async ({ page, context }) => {
  await logInAsAdmin(page);
  // Two workspaces, so the per-workspace cap of 20 open invitations can't be what refuses.
  const first = await createWorkspace(page, uniqueName("Cap A"));
  const second = await createWorkspace(page, uniqueName("Cap B"));
  // The other tests already used some of this hour; send through the database until it refuses.
  let sent = 0;
  for (;;) {
    const ws = sent % 2 === 0 ? first : second;
    const res = await rpc(context, "create_invitation", { p_workspace_id: ws, p_email: `cap-${sent}-${uniqueName("x").slice(2)}@example.test` });
    if (res.status !== 200) {
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("hourly_invitation_limit");
      break;
    }
    sent += 1;
    expect(sent, "invitations accepted this hour").toBeLessThanOrEqual(20);
  }
  await page.goto(`/w/${first}`);
  await page.getByLabel("Client's email").fill(`cap-ui-${uniqueName("x").slice(2)}@example.test`);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(alertIn(page)).toHaveText("You have sent 20 invitations in the last hour. Try again later.");
});

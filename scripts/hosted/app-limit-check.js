// Hosted rate-limit check, part 2: through the app. Paste into the browser's DevTools console
// on the preview's /login page (signed out). It submits the login form with a made-up address
// and a wrong password until the page says "Too many attempts" (at most 40 tries), and records
// the Access-Control-Allow-Origin header on a few routes. Run only against a throwaway project.
(async () => {
  const out = { check: "porchlet hosted auth limits, part 2 (app)", page: location.origin, started: new Date().toISOString(), acao: {}, attempts: [] };
  for (const path of ["/", "/login", "/w", "/api/health"]) {
    const res = await fetch(path);
    out.acao[path] = `${res.status} ${new URL(res.url).pathname} ACAO=${res.headers.get("access-control-allow-origin")}`;
  }
  const email = `nobody-${Math.random().toString(36).slice(2, 12)}@example.invalid`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 1; i <= 40; i++) {
    const form = document.querySelector("main form");
    const button = form.querySelector('button[type="submit"]');
    form.querySelector('[name="email"]').value = email;
    form.querySelector('[name="password"]').value = "wrong-password-123";
    form.requestSubmit(button);
    // The button is disabled while the request runs; wait for it to turn off and on again.
    for (let t = 0; t < 20 && !button.disabled; t++) await sleep(100);
    for (let t = 0; t < 150 && button.disabled; t++) await sleep(100);
    const msg = button.disabled ? null : (document.querySelector('main [role="alert"]')?.textContent ?? "(no message)");
    out.attempts.push(msg ?? "(no message after 15 s)");
    if (msg && msg.startsWith("Too many")) break;
  }
  const first = out.attempts.findIndex((m) => m.startsWith("Too many"));
  out.firstTooMany = first === -1 ? null : first + 1;
  out.finished = new Date().toISOString();
  console.log(JSON.stringify(out, null, 2));
  return "done: copy the JSON printed above";
})();

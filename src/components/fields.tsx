export function EmailField({ defaultValue }: { defaultValue?: string }) {
  return (
    <label>
      Email
      <input name="email" type="email" autoComplete="email" required maxLength={254} defaultValue={defaultValue} />
    </label>
  );
}

// 10 is the minimum set in supabase/config.toml (design doc threat model row 11). Supabase Auth
// accepts at most 72 UTF-8 bytes (bcrypt). These attributes are hints only: browsers count them
// in UTF-16 units or graphemes, not bytes, so the server enforces both limits (ADR 0021).
export function PasswordField({ label, autoComplete }: { label: string; autoComplete: "current-password" | "new-password" }) {
  return (
    <label>
      {label}
      <input
        name="password"
        type="password"
        autoComplete={autoComplete}
        required
        minLength={autoComplete === "new-password" ? 10 : undefined}
        maxLength={72}
      />
    </label>
  );
}

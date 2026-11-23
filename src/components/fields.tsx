export function EmailField({ defaultValue }: { defaultValue?: string }) {
  return (
    <label>
      Email
      <input name="email" type="email" autoComplete="email" required maxLength={254} defaultValue={defaultValue} />
    </label>
  );
}

// 10 is the minimum set in supabase/config.toml (design doc threat model row 11). 72 is the most
// Supabase Auth accepts (bcrypt), above ASVS 5.0.0 6.2.9's 64.
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

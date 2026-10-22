import Link from "next/link";
import { signInAction } from "../actions";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="wrap">
      <div className="narrow">
        <h1>Sign in</h1>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <form action={signInAction} className="card">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          <button className="accent" type="submit">
            Sign in
          </button>
        </form>

        <p className="muted small">
          No account yet? <Link href="/signup">Start a free trial</Link>.
        </p>
      </div>
    </div>
  );
}

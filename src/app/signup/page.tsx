import Link from "next/link";
import { signUpAction } from "../actions";

const INDUSTRIES = [
  ["med-spa", "Med spa or aesthetics clinic"],
  ["salon", "Salon or wellness"],
  ["real-estate", "Real estate"],
  ["consulting", "Consulting or agency"],
  ["home-services", "Repair and home services"],
  ["retail", "Retail or e-commerce"],
];

const COUNTRIES = [
  ["+971", "United Arab Emirates"],
  ["+92", "Pakistan"],
  ["+966", "Saudi Arabia"],
  ["+974", "Qatar"],
  ["+973", "Bahrain"],
  ["+968", "Oman"],
  ["+965", "Kuwait"],
  ["+44", "United Kingdom"],
  ["+1", "United States or Canada"],
];

export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="wrap">
      <div className="narrow">
        <span className="eyebrow">14 days, no card</span>
        <h1>Create your workspace</h1>
        <p className="lede">
          One account creates your own private workspace. Nothing you put in it is visible to any
          other business on the platform.
        </p>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <form action={signUpAction} className="card">
          <div className="field">
            <label htmlFor="company">Business name</label>
            <input id="company" name="company" required maxLength={80} />
          </div>

          <div className="field">
            <label htmlFor="industry">Industry</label>
            <select id="industry" name="industry" defaultValue="med-spa">
              {INDUSTRIES.map(([value, labelText]) => (
                <option key={value} value={value}>
                  {labelText}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="country">Main market</label>
              <select id="country" name="country" defaultValue="+971">
                {COUNTRIES.map(([value, labelText]) => (
                  <option key={value} value={value}>
                    {labelText}
                  </option>
                ))}
              </select>
              <p className="muted small">
                Used to read a local mobile number as the same number written internationally.
              </p>
            </div>
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" name="name" autoComplete="name" maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
            />
            <p className="muted small">At least 10 characters. Stored as a scrypt hash, never in the clear.</p>
          </div>

          <button className="accent" type="submit">
            Create workspace
          </button>
        </form>

        <p className="muted small">
          Already have an account? <Link href="/login">Sign in</Link>.
        </p>
      </div>
    </div>
  );
}

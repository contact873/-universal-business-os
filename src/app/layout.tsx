import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { currentSession } from "@/lib/session-server";
import { signOutAction } from "./actions";

export const metadata: Metadata = {
  title: "Universal Business OS",
  description:
    "One platform for many businesses. Each workspace is private, and every record belongs to exactly one of them.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  const signedIn = session.ok;

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>

        <header className="site-header">
          <div className="wrap">
            <Link className="brand" href="/">
              <span className="mark" aria-hidden="true">
                U
              </span>
              <span>
                Universal Business OS
                <small>by Relco Digital</small>
              </span>
            </Link>

            <nav className="nav" aria-label="Primary">
              {signedIn ? (
                <>
                  <Link href="/app">Dashboard</Link>
                  <Link href="/app/contacts">Contacts</Link>
                  <Link href="/app/leads">Leads</Link>
                  <Link href="/app/bookings">Bookings</Link>
                  <Link href="/app/settings">Settings</Link>
                  {(session as { user: { is_platform_admin?: number } }).user.is_platform_admin ? (
                    <Link href="/admin">Platform</Link>
                  ) : null}
                  <form action={signOutAction}>
                    <button className="btn-ghost" type="submit">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/#plans">Pricing</Link>
                  <Link href="/login">Sign in</Link>
                  <Link className="btn btn-accent" href="/signup">
                    Start free trial
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="site-footer">
          <div className="wrap">
            <p>
              Universal Business OS. Workspaces are isolated, records belong to exactly one
              organisation, and every consequential action is recorded.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

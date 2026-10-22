import Link from "next/link";
import { getDb } from "@/lib/db.mjs";

type Plan = {
  id: string;
  name: string;
  price_minor: number;
  currency: string;
  exponent: number;
  limits_json: string | null;
};

function price(plan: Plan) {
  const amount = plan.price_minor / 100;
  return `$${amount.toLocaleString("en-US")}`;
}

export default function Home() {
  const plans = getDb()
    .prepare("select * from plans order by price_minor asc")
    .all() as Plan[];

  return (
    <>
      <section className="wrap" style={{ paddingBottom: "var(--s7)" }}>
        <div className="narrow">
          <span className="eyebrow">One platform, many businesses</span>
          <h1>Your customer list belongs to you, and to nobody else on the platform.</h1>
          <p className="lede">
            Universal Business OS gives each business its own private workspace: contacts,
            enquiries, a pipeline and a record of who did what. You run one platform, your
            customers never see each other, and every enquiry is stored before anything is sent.
          </p>
          <div className="btn-row">
            <Link className="btn btn-accent" href="/signup">
              Start a free 14 day trial
            </Link>
            <Link className="btn btn-ghost" href="/#plans">
              See the plans
            </Link>
          </div>
        </div>
      </section>

      <section className="wrap" style={{ paddingBottom: "var(--s7)" }}>
        <div className="grid">
          <div className="card">
            <h3>A workspace per business</h3>
            <p className="muted small">
              Contacts, leads and staff belong to one organisation. Two businesses may hold the
              same customer without ever sharing a record, and attempts to read across that
              boundary return nothing.
            </p>
          </div>
          <div className="card">
            <h3>Enquiries are stored, then sent</h3>
            <p className="muted small">
              A submission is written to the database first. If the mail provider is down, the
              lead is still there, with its source and the exact wording the customer used.
            </p>
          </div>
          <div className="card">
            <h3>Every action is accountable</h3>
            <p className="muted small">
              Stage changes, assignments, invitations and deletions are recorded against the
              person who made them, and credentials are stripped before anything is logged.
            </p>
          </div>
        </div>
      </section>

      <section className="wrap" id="plans" style={{ paddingBottom: "var(--s7)" }}>
        <h2>Plans</h2>
        <p className="muted">
          Prices are per workspace, per month, billed in USD. A limit is enforced on the server,
          not by hiding a button.
        </p>

        <div className="grid">
          {plans.map((plan) => {
            const limits = plan.limits_json ? JSON.parse(plan.limits_json) : {};
            return (
              <div className="card" key={plan.id}>
                <h3>{plan.name}</h3>
                <p className="price">
                  {price(plan)}
                  <span className="small muted"> /month</span>
                </p>
                <ul className="muted small">
                  {Object.entries(limits).map(([feature, value]) => (
                    <li key={feature}>
                      {feature}: {String(value)}
                    </li>
                  ))}
                </ul>
                <Link className="btn" href="/signup">
                  Start with {plan.name}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      <section className="wrap">
        <div className="card">
          <h2>What this build does not do yet</h2>
          <p className="muted small">
            Stated plainly rather than discovered later. There is no payment provider connected,
            so plans are recorded but nothing is charged. No messaging channel is connected: no
            WhatsApp, no Instagram, no voice. Email invitations are recorded but not yet sent. The
            AI assistant is not built. Those are the next milestones, and none of them are
            claimed anywhere on this page.
          </p>
        </div>
      </section>
    </>
  );
}

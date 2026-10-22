// One rule, in one place: is this subscription currently worth granting anything?
//
// It lives apart from billing.mjs because accounts.mjs needs it too, and billing.mjs already
// imports from accounts.mjs. A cycle would work here only by accident of call order.
//
// The interesting cases are the ones that decide whether a customer keeps working:
//   trialing  until the trial end
//   active    until the period end, then it lapses on its own if no payment arrives
//   past_due  still working, through the period they have already paid for. Cutting a clinic off
//             the moment a card expires loses the customer over a bank problem
//   canceled  still working until the end of the paid period, if that is when they asked to stop
//   incomplete  never grants: a checkout that was started and abandoned is not a customer

export function isPaying(subscription, now = Date.now()) {
  if (!subscription) return false;

  const trialEnd = subscription.trial_end ? Date.parse(subscription.trial_end) : null;
  const periodEnd = subscription.period_end ? Date.parse(subscription.period_end) : null;

  switch (subscription.status) {
    case "trialing":
      return trialEnd !== null && trialEnd > now;
    case "active":
      return periodEnd === null || periodEnd > now;
    case "past_due":
      return periodEnd !== null && periodEnd > now;
    case "canceled":
      return periodEnd !== null && periodEnd > now;
    default:
      return false;
  }
}

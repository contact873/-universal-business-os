// Roles and per-resource authorisation.
//
// api-and-auth/SKILL.md line 89 makes the point this file exists to satisfy: a route-level check
// that "the user is an admin" is not an answer to "may this admin see invoice 123". So permission
// is asked per action, and for records with an owner it is asked per record as well.

export const ROLES = ["owner", "admin", "manager", "staff", "viewer"];

const RANK = { owner: 4, admin: 3, manager: 2, staff: 1, viewer: 0 };

// The minimum role each action requires. Everything in the app asks through can().
const REQUIRED = {
  "org:read": "viewer",
  "org:update": "admin",
  "org:delete": "owner",
  "member:invite": "admin",
  "member:role": "admin",
  "member:remove": "admin",
  "billing:read": "admin",
  "billing:write": "owner",
  "audit:read": "admin",
  "contact:read": "viewer",
  "contact:write": "staff",
  "contact:delete": "manager",
  "contact:export": "manager",
  "lead:read": "viewer",
  "lead:write": "staff",
  "lead:assign": "manager",
  "lead:delete": "manager",
  "booking:read": "viewer",
  "booking:write": "staff",
  "booking:cancel": "staff",
  "service:write": "manager",
  "staff:write": "manager",
};

export function isRole(value) {
  return ROLES.includes(String(value));
}

export function rank(role) {
  const r = RANK[String(role)];
  return r === undefined ? -1 : r;
}

export function can(role, action) {
  const need = REQUIRED[action];
  if (!need) return false;
  const mine = rank(role);
  if (mine < 0) return false;
  return mine >= rank(need);
}

export function assertCan(role, action) {
  if (!can(role, action)) {
    const error = new Error(`Your role (${role}) cannot perform ${action}.`);
    error.code = "FORBIDDEN";
    error.status = 403;
    throw error;
  }
}

// Per-record authorisation. A staff member may work the leads assigned to them and no others;
// a manager may work any lead in their own organisation. This is the ownership pattern the
// skill recommends, applied to a record rather than a route.
export function canEditLead(role, lead, userId) {
  if (!can(role, "lead:write")) return false;
  if (rank(role) >= rank("manager")) return true;
  if (!lead) return false;
  return lead.owner_user_id === userId;
}

export function assertCanEditLead(role, lead, userId) {
  if (!canEditLead(role, lead, userId)) {
    const error = new Error("That lead is not assigned to you.");
    error.code = "FORBIDDEN";
    error.status = 403;
    throw error;
  }
}

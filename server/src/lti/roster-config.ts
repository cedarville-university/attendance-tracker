//
// Per-institution NRPS roster-filtering and identity-matching config (spec §18.2, §20, §52). Role
// matching is exact-fragment comparison on role URNs -- never substring. Institutional IDs are always
// trimmed strings, never coerced to numbers (leading zeroes are meaningful).

export interface NrpsRawMember {
  user_id: string;
  status: string;
  roles: string[];
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  lis_person_sourcedid?: string;
  [key: string]: unknown;
}

export interface InstitutionRosterConfig {
  canvasIdentityMatchField: string;
  identityMatchEmailEnabled: boolean;
  rosterLearnerRoles: string[];
}

export function resolveInstitutionRosterConfig(institution: {
  canvasIdentityMatchField: string;
  identityMatchEmailEnabled: boolean;
  rosterLearnerRoles: string[];
}): InstitutionRosterConfig {
  // Spec §18.2: the default candidate rule is `status = Active AND role contains Learner`. If the row
  // somehow carries an empty list (bad seed, manual edit, a future migration), fall back to ['Learner']
  // in code rather than silently disabling attendance for everyone.
  const learnerRoles =
    Array.isArray(institution.rosterLearnerRoles) && institution.rosterLearnerRoles.length > 0
      ? institution.rosterLearnerRoles
      : ['Learner'];
  return {
    canvasIdentityMatchField: institution.canvasIdentityMatchField || 'lis_person_sourcedid',
    identityMatchEmailEnabled: Boolean(institution.identityMatchEmailEnabled),
    rosterLearnerRoles: learnerRoles,
  };
}

export function resolveInstitutionalId(raw: NrpsRawMember, config: InstitutionRosterConfig): string | null {
  const field = config.canvasIdentityMatchField;
  if (field === 'email' && !config.identityMatchEmailEnabled) {
    return null;
  }
  const rawValue = field === 'email' ? raw.email : raw[field];
  if (typeof rawValue !== 'string') {
    return null;
  }
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function roleFragment(roleUri: string): string {
  const hashIndex = roleUri.lastIndexOf('#');
  return hashIndex === -1 ? roleUri : roleUri.slice(hashIndex + 1);
}

export function isEligibleForAttendance(status: string, roles: string[], learnerRoles: string[]): boolean {
  if (status !== 'Active') {
    return false;
  }
  return roles.some((role) => learnerRoles.includes(roleFragment(role)));
}

// admin.js
//
// DOM wiring for admin.html. All API work is delegated to admin-api.js; every server-sourced
// string is written with textContent. Standalone page -- not part of the scanner SPA.

import * as api from './admin-api.js';
import { bindInlineConfirm } from './confirm-inline.js';

const $ = (id) => document.getElementById(id);

const els = {
  accessStatus: $('access-status'),
  setupTokenForm: $('setup-token-form'),
  setupTokenInput: $('setup-token-input'),
  connectionsPanel: $('connections-panel'),
  registrationsTableBody: $('registrations-table-body'),
  registrationsEmpty: $('registrations-empty'),
  registrationForm: $('registration-form'),
  signingKeyPanel: $('signing-key-panel'),
  signingKeyKid: $('signing-key-kid'),
  signingKeyCreated: $('signing-key-created'),
  signingKeyPrevious: $('signing-key-previous'),
  signingKeyJwksUrl: $('signing-key-jwks-url'),
  rotateKeyBtn: $('btn-rotate-key'),
  messages: $('admin-messages'),
};

function showMessage(kind, text) {
  const div = document.createElement('div');
  div.className = `app-message app-message--${kind}`;
  div.textContent = text;
  els.messages.insertBefore(div, els.messages.firstChild);
  while (els.messages.children.length > 5) els.messages.removeChild(els.messages.lastChild);
}

function renderRegistrations(registrations) {
  const body = els.registrationsTableBody;
  while (body.firstChild) body.removeChild(body.firstChild);
  els.registrationsEmpty.hidden = registrations.length > 0;

  for (const reg of registrations) {
    const tr = document.createElement('tr');
    const cells = [
      `${reg.institution.displayName} (${reg.institution.slug})`,
      reg.issuer,
      reg.clientId,
      reg.deployments.map((d) => `${d.deploymentId}${d.enabled ? '' : ' (disabled)'}`).join(', ') ||
        '—',
      reg.enabled ? 'Yes' : 'No',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    const actions = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'secondary';
    toggle.textContent = reg.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      const result = await api.toggleRegistration(reg.id, !reg.enabled);
      if (!result.ok) {
        showMessage(
          'error',
          `Could not update the connection (HTTP ${result.error.status ?? '?'}).`,
        );
        toggle.disabled = false;
        return;
      }
      await refreshRegistrations();
    });
    actions.appendChild(toggle);
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

async function refreshRegistrations() {
  const result = await api.listRegistrations();
  if (!result.ok) {
    showMessage('error', `Could not load Canvas connections (HTTP ${result.error.status ?? '?'}).`);
    return;
  }
  renderRegistrations(result.body.registrations ?? []);
}

function renderSigningKey(view) {
  els.signingKeyKid.textContent = view.activeKid ?? '—';
  els.signingKeyCreated.textContent = view.createdAt
    ? new Date(view.createdAt).toLocaleString()
    : '—';
  els.signingKeyPrevious.textContent = (view.previousKids ?? []).join(', ') || 'none';
  els.signingKeyJwksUrl.textContent = view.jwksUrl ?? '—';
}

async function refreshSigningKey() {
  const result = await api.getSigningKey();
  if (!result.ok) {
    showMessage('error', `Could not load the signing key (HTTP ${result.error.status ?? '?'}).`);
    return;
  }
  renderSigningKey(result.body);
}

function showAuthorizedUi() {
  els.setupTokenForm.hidden = true;
  els.connectionsPanel.hidden = false;
  els.signingKeyPanel.hidden = false;
  els.accessStatus.textContent = 'You can manage setup.';
  refreshRegistrations();
  refreshSigningKey();
}

async function evaluateAccess() {
  const access = await api.checkAccess();
  if (access.state === 'ok') {
    showAuthorizedUi();
    return;
  }
  if (access.state === 'forbidden') {
    els.accessStatus.textContent = "Your Canvas role can't manage setup.";
    els.setupTokenForm.hidden = true;
    els.connectionsPanel.hidden = true;
    els.signingKeyPanel.hidden = true;
    return;
  }
  // 'token'
  els.accessStatus.textContent = 'Enter the setup token to continue.';
  els.setupTokenForm.hidden = false;
  els.connectionsPanel.hidden = true;
  els.signingKeyPanel.hidden = true;
}

els.setupTokenForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  api.setSetupToken(els.setupTokenInput.value);
  const probe = await api.listRegistrations();
  if (!probe.ok) {
    api.setSetupToken(null);
    showMessage('error', 'That setup token was not accepted.');
    return;
  }
  showAuthorizedUi();
});

els.registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(els.registrationForm);
  const body = {};
  for (const [key, value] of form.entries()) {
    const trimmed = String(value).trim();
    if (trimmed) body[key] = trimmed;
  }
  const result = await api.upsertRegistration(body);
  if (!result.ok) {
    showMessage('error', `Could not save the connection (HTTP ${result.error.status ?? '?'}).`);
    return;
  }
  showMessage('info', 'Canvas connection saved.');
  els.registrationForm.reset();
  await refreshRegistrations();
});

bindInlineConfirm(els.rotateKeyBtn, {
  armedLabel: 'Click again to rotate',
  onConfirm: async () => {
    els.rotateKeyBtn.disabled = true;
    try {
      const result = await api.rotateSigningKey();
      if (!result.ok) {
        showMessage('error', `Key rotation failed (HTTP ${result.error.status ?? '?'}).`);
        return;
      }
      renderSigningKey(result.body);
      showMessage(
        'info',
        'Signing key rotated. Re-fetch the JWKS URL in the Canvas Developer Key.',
      );
    } finally {
      els.rotateKeyBtn.disabled = false;
    }
  },
});

// On-blur validation for the registration form. Purely additive feedback: the
// form's own submit-time constraint validation is unchanged.
function messageForValidity(validity) {
  if (validity.valueMissing) return 'This field is required.';
  if (validity.typeMismatch) return 'Enter a full URL, including https://.';
  return 'Check this value.';
}

function wireFieldValidation() {
  const inputs = els.registrationForm.querySelectorAll('.field-row input');
  for (const input of inputs) {
    const row = input.closest('.field-row');
    if (!row) continue;
    const errorId = `${input.id}-error`;

    const describedByTokens = () =>
      (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);

    const clearError = () => {
      const existing = row.querySelector('.field-error');
      if (existing) existing.remove();
      const tokens = describedByTokens().filter((token) => token !== errorId);
      if (tokens.length) input.setAttribute('aria-describedby', tokens.join(' '));
      else input.removeAttribute('aria-describedby');
    };

    input.addEventListener('blur', () => {
      if (input.validity.valid) return;
      let error = row.querySelector('.field-error');
      if (!error) {
        error = document.createElement('small');
        error.className = 'field-error';
        error.id = errorId;
        row.appendChild(error);
      }
      error.textContent = messageForValidity(input.validity);
      const tokens = describedByTokens();
      if (!tokens.includes(errorId)) {
        tokens.push(errorId);
        input.setAttribute('aria-describedby', tokens.join(' '));
      }
    });

    input.addEventListener('input', () => {
      if (input.validity.valid) clearError();
    });
  }
}

wireFieldValidation();
evaluateAccess();

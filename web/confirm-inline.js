// confirm-inline.js
//
// Two-step inline confirmation for destructive buttons, in place of a blocking
// window.confirm() dialog. The first click "arms" the button (its label and
// styling change to state the consequence); a second click within `timeoutMs`
// runs the action. Moving focus away, pressing Escape, or the timeout all
// disarm it without running anything.

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * @param {HTMLButtonElement} button
 * @param {object} opts
 * @param {string} opts.armedLabel  Label shown once the button is armed.
 * @param {() => void} opts.onConfirm  Runs on the confirming (second) click.
 * @param {() => boolean} [opts.canArm]  If given and it returns false, the
 *   click is ignored and the button never arms.
 * @param {number} [opts.timeoutMs]
 */
export function bindInlineConfirm(
  button,
  { armedLabel, onConfirm, canArm, timeoutMs = DEFAULT_TIMEOUT_MS },
) {
  const idleLabel = button.textContent;
  let timer = null;

  function disarm() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    button.classList.remove('is-confirming');
    button.textContent = idleLabel;
    button.removeAttribute('aria-live');
  }

  function arm() {
    button.classList.add('is-confirming');
    button.textContent = armedLabel;
    // Assertive so a screen reader announces the changed consequence immediately.
    button.setAttribute('aria-live', 'assertive');
    timer = setTimeout(disarm, timeoutMs);
  }

  button.addEventListener('click', () => {
    if (button.classList.contains('is-confirming')) {
      disarm();
      onConfirm();
      return;
    }
    if (canArm && !canArm()) return;
    arm();
  });

  button.addEventListener('blur', disarm);
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') disarm();
  });
}

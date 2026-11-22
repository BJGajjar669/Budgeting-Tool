'use strict';

const $ = (s, el = document) => el.querySelector(s);

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { field: data.field });
  return data;
}

function showError(el, err, form) {
  el.textContent = err.message;
  el.hidden = false;
  form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  const field = err.field && form.elements[err.field];
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function busy(form, on, label) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

// Show/hide password buttons.
document.addEventListener('click', (e) => {
  const t = e.target.closest('.pw-toggle');
  if (!t) return;
  const input = t.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  t.textContent = show ? 'Hide' : 'Show';
  t.setAttribute('aria-pressed', String(show));
  t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

const goHome = () => location.replace('/');

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.email.value.trim() || !f.password.value) {
    return showError($('#loginError'), new Error('Enter your email and password.'), f);
  }
  busy(f, true, 'Signing in…');
  try {
    await post('/api/auth/login', { email: f.email.value, password: f.password.value, remember: f.remember.checked });
    goHome();
  } catch (err) {
    busy(f, false);
    f.password.value = '';
    showError($('#loginError'), err, f);
    f.password.focus();
  }
});

let minLen = 10;
function checkRules() {
  const f = $('#setupForm');
  const pw = f.password.value;
  const set = (rule, ok) => $(`[data-rule=${rule}]`).classList.toggle('ok', ok);
  set('length', pw.length >= minLen);
  set('match', pw.length > 0 && pw === f.confirm.value);
}
$('#setupForm').addEventListener('input', checkRules);
$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#setupError');
  if (f.password.value !== f.confirm.value) {
    return showError(err, Object.assign(new Error('The two passwords don’t match.'), { field: 'confirm' }), f);
  }
  busy(f, true, 'Creating account…');
  try {
    await post('/api/auth/setup', { name: f.name.value, email: f.email.value, password: f.password.value });
    goHome();
  } catch (ex) {
    busy(f, false);
    showError(err, ex, f);
  }
});

(async () => {
  try {
    const state = await (await fetch('/api/auth/state')).json();
    if (state.user) return goHome();
    minLen = state.minPassword || minLen;
    document.querySelectorAll('.min-len').forEach((s) => (s.textContent = minLen));
    const form = state.setupRequired ? $('#setupForm') : $('#loginForm');
    form.hidden = false;
    document.title = state.setupRequired ? 'Create your account · Budgify' : 'Sign in · Budgify';
  } catch {
    $('#loginForm').hidden = false;
    $('#loginError').textContent = 'Can’t reach Budgify. Is the app still running?';
    $('#loginError').hidden = false;
  }
  $('#card').hidden = false;
  $('#card form:not([hidden]) [autofocus]')?.focus();
})();

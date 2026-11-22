'use strict';

// Calendar helpers on plain 'YYYY-MM-DD' / 'YYYY-MM' strings (no timezone surprises).

const pad = (n) => String(n).padStart(2, '0');

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const monthOf = (dateStr) => dateStr.slice(0, 7);

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** Months from a to b inclusive, e.g. ('2026-01','2026-03') -> 3 entries. */
function monthRange(a, b) {
  const out = [];
  for (let m = a; m <= b; m = addMonths(m, 1)) out.push(m);
  return out;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Same day-of-month n whole months later, clamped to the month's last day. */
function shiftMonths(dateStr, n) {
  const month = addMonths(dateStr.slice(0, 7), n);
  const day = Math.min(Number(dateStr.slice(8, 10)), daysInMonth(month));
  return `${month}-${pad(day)}`;
}

/** Calendar-aware fractional months from a to b (Jan 1 -> next Jan 1 is exactly 12). */
function monthsBetween(a, b) {
  if (b < a) return -monthsBetween(b, a);
  let whole = (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  if (shiftMonths(a, whole) > b) whole -= 1;
  return whole + daysBetween(shiftMonths(a, whole), b) / 30.4375;
}

/** Inverse of monthsBetween: the date `months` (fractional) after dateStr. */
function addFractionalMonths(dateStr, months) {
  const whole = Math.floor(months);
  return addDays(shiftMonths(dateStr, whole), Math.round((months - whole) * 30.4375));
}

function addDays(dateStr, n) {
  const d = new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

module.exports = { todayStr, monthOf, addMonths, monthRange, daysBetween, monthsBetween, addFractionalMonths, shiftMonths, addDays, daysInMonth };

'use strict';

// Import bank-statement CSV exports (works for most banks and card issuers).

const crypto = require('node:crypto');

/** RFC-4180-ish parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

function parseDate(s) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); // US style MM/DD/YYYY
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function parseAmount(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

function findCol(headers, patterns) {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Turn CSV text into transactions with amount sign: negative = money out.
 * @param {string} text
 * @param {{ spendingIsPositive?: boolean }} opts  set when the file lists purchases as positive numbers (common for credit cards)
 */
function csvToTransactions(text, { spendingIsPositive = false } = {}) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one transaction.');
  const headers = rows[0].map((h) => h.toLowerCase());
  const dateCol = findCol(headers, [/^(transaction |trans\.? )?date$/, /posted|posting date/, /date/]);
  const descCol = findCol(headers, [/description/, /payee/, /merchant/, /^name$/, /details/, /memo/]);
  const amountCol = findCol(headers, [/^amount$/, /amount/]);
  const debitCol = findCol(headers, [/debit/, /withdraw/, /money out/]);
  const creditCol = findCol(headers, [/credit/, /deposit/, /money in/]);
  if (dateCol === -1) throw new Error('Could not find a date column in the CSV header.');
  if (descCol === -1) throw new Error('Could not find a description/payee column in the CSV header.');
  if (amountCol === -1 && debitCol === -1 && creditCol === -1) {
    throw new Error('Could not find an amount (or debit/credit) column in the CSV header.');
  }

  const out = [];
  const skipped = [];
  rows.slice(1).forEach((r, i) => {
    const date = parseDate(r[dateCol] || '');
    const name = r[descCol] || '';
    let amount;
    if (amountCol !== -1 && r[amountCol] !== '') {
      amount = parseAmount(r[amountCol]);
      if (amount != null && spendingIsPositive) amount = -amount;
    } else {
      const debit = parseAmount(r[debitCol]);
      const credit = parseAmount(r[creditCol]);
      amount = (credit ? Math.abs(credit) : 0) - (debit ? Math.abs(debit) : 0);
      if (debit == null && credit == null) amount = null;
    }
    if (!date || amount == null || !name) {
      skipped.push(i + 2);
      return;
    }
    out.push({ date, name, amount: Math.round(amount * 100) / 100 });
  });
  return { transactions: out, skippedRows: skipped };
}

/** Stable ids so re-importing the same file doesn't create duplicates. */
function assignIds(accountId, txs) {
  const seen = new Map();
  return txs.map((t) => {
    const key = `${accountId}|${t.date}|${t.amount}|${t.name.toLowerCase()}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const id = 'csv_' + crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 24);
    return { ...t, id };
  });
}

module.exports = { parseCsv, parseDate, parseAmount, csvToTransactions, assignIds };

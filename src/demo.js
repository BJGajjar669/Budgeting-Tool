'use strict';

// Realistic sample data so you can explore the tool before connecting a bank.

const { tx } = require('./db');
const { addMonths, monthOf, monthRange, addDays, daysInMonth } = require('./dates');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateDemo(today, months = 6) {
  const rand = rng(42);
  const between = (a, b) => Math.round((a + rand() * (b - a)) * 100) / 100;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const accounts = [
    { id: 'demo_checking', source: 'demo', institution_name: 'Demo Bank', name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '4821', current_balance: 3240.18, available_balance: 3240.18 },
    { id: 'demo_savings', source: 'demo', institution_name: 'Demo Bank', name: 'High-Yield Savings', type: 'depository', subtype: 'savings', mask: '9930', current_balance: 6150.0, available_balance: 6150.0 },
    { id: 'demo_card', source: 'demo', institution_name: 'Demo Card Co.', name: 'Rewards Visa', type: 'credit', subtype: 'credit card', mask: '1177', current_balance: 912.44, available_balance: 4087.56 },
  ];

  const txs = [];
  let seq = 0;
  const add = (date, name, amount, account = 'demo_checking', merchant = null) => {
    if (date > today) return;
    txs.push({ id: `demo_${++seq}`, account_id: account, source: 'demo', date, name, merchant, amount: Math.round(amount * 100) / 100 });
  };

  const start = addMonths(monthOf(today), -(months - 1));
  for (const month of monthRange(start, monthOf(today))) {
    const d = (day) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;

    // Income: paid on the 1st and 15th.
    add(d(1), 'ACME CORP PAYROLL DIRECT DEP', 2685.42);
    add(d(15), 'ACME CORP PAYROLL DIRECT DEP', 2685.42);

    // Fixed essentials.
    add(d(1), 'Maple Court Apartments Rent', -1725, 'demo_checking', 'Maple Court Apartments');
    add(d(6), 'City Power & Electric', -between(68, 124), 'demo_checking', 'City Power & Electric');
    add(d(9), 'Xfinity Internet', -79.99, 'demo_checking', 'Xfinity');
    add(d(12), 'Verizon Wireless', -65, 'demo_checking', 'Verizon');
    add(d(18), 'GEICO Auto Insurance', -132.5, 'demo_checking', 'GEICO');
    add(d(20), 'Nelnet Student Loan', -285, 'demo_checking', 'Nelnet');

    // Saving + paying the card.
    add(d(2), 'Transfer to High-Yield Savings', -400);
    add(d(2), 'Transfer from Everyday Checking', 400, 'demo_savings');
    add(d(25), 'Rewards Visa Autopay Payment', -1100);
    add(d(25), 'Payment Thank You', 1100, 'demo_card');
    add(d(28), 'Interest Paid', between(18, 24), 'demo_savings');

    // Subscriptions.
    add(d(4), 'Netflix.com', -15.49, 'demo_card', 'Netflix');
    add(d(11), 'Spotify USA', -11.99, 'demo_card', 'Spotify');
    add(d(14), 'Planet Fitness', -24.99, 'demo_card', 'Planet Fitness');
    add(d(22), 'Apple.com/bill iCloud', -2.99, 'demo_card', 'Apple');

    // Variable spending.
    for (const day of [3, 10, 17, 24, 30]) {
      add(d(day), pick(['Trader Joe\'s', 'Whole Foods Market', 'Safeway']), -between(62, 138), 'demo_card');
    }
    for (let i = 0; i < 11; i++) {
      add(d(1 + Math.floor(rand() * 28)), pick(['Chipotle', 'Starbucks', 'DoorDash Thai Basil', 'Blue Door Bistro', 'Uber Eats Sushi Go', 'Joe\'s Pizza']), -between(9, 58), 'demo_card');
    }
    for (let i = 0; i < 4; i++) {
      add(d(1 + Math.floor(rand() * 28)), pick(['Shell Gas Station', 'Chevron']), -between(38, 56), 'demo_card');
    }
    add(d(16), 'Metro Transit Card Reload', -40, 'demo_card');
    for (let i = 0; i < 4; i++) {
      add(d(1 + Math.floor(rand() * 28)), pick(['Amazon.com', 'Target', 'Etsy', 'Best Buy', 'Nordstrom']), -between(18, 145), 'demo_card');
    }
    add(d(8 + Math.floor(rand() * 15)), pick(['AMC Theatres', 'Ticketmaster', 'Steam Games', 'Lucky Strike Bowling']), -between(22, 95), 'demo_card');
    add(d(19), 'CVS Pharmacy', -between(12, 48), 'demo_card');
    add(d(21), 'Great Clips Barber', -28, 'demo_card');
  }

  // A few one-offs that make the trend interesting.
  const m3 = addMonths(monthOf(today), -4);
  add(`${m3}-14`, 'Delta Air Lines', -389.6, 'demo_card');
  add(`${m3}-15`, 'Airbnb', -512.0, 'demo_card');
  add(`${addMonths(monthOf(today), -1)}-05`, 'Red Cross Donation', -50, 'demo_checking');
  add(`${addMonths(monthOf(today), -2)}-27`, 'Amazon.com Refund', 42.99, 'demo_card');

  const goals = [
    { name: 'Emergency fund', target_amount: 12000, account_id: 'demo_savings', target_date: addDays(`${addMonths(monthOf(today), 12)}-01`, -1), priority: 0 },
    { name: 'Japan trip', target_amount: 4500, current_amount: 600, target_date: `${addMonths(monthOf(today), 9)}-15`, priority: 1 },
    { name: 'Car down payment', target_amount: 10000, current_amount: 0, target_date: `${addMonths(monthOf(today), 16)}-01`, priority: 2 },
  ];

  const budgets = {
    Groceries: 500,
    'Dining Out': 300,
    Shopping: 250,
    Entertainment: 75,
    Subscriptions: 60,
    Transportation: 260,
  };

  return { accounts, transactions: txs, goals, budgets };
}

function loadDemo(store, today) {
  const data = generateDemo(today);
  tx(store.db, () => {
    for (const a of data.accounts) store.upsertAccount(a);
  });
  store.upsertTransactions(data.transactions);
  const existingBudgets = store.budgets();
  if (!Object.keys(existingBudgets).length) {
    for (const [c, v] of Object.entries(data.budgets)) store.setBudget(c, v);
  }
  if (!store.goals().some((g) => g.demo)) {
    for (const g of data.goals) store.addGoal({ ...g, demo: true });
  }
}

module.exports = { generateDemo, loadDemo };

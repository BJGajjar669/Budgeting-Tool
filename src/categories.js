'use strict';

// Category model. `kind` drives the math:
//   income        - money coming in
//   transfer      - moving money between your own accounts (ignored for spending/income)
//   essential     - needs; the planner never suggests cutting these
//   discretionary - wants; the planner looks here first to free up money for goals
const CATEGORIES = [
  { name: 'Income', kind: 'income' },
  { name: 'Transfer', kind: 'transfer' },
  { name: 'Housing', kind: 'essential' },
  { name: 'Utilities', kind: 'essential' },
  { name: 'Groceries', kind: 'essential' },
  { name: 'Transportation', kind: 'essential' },
  { name: 'Insurance', kind: 'essential' },
  { name: 'Healthcare', kind: 'essential' },
  { name: 'Debt Payments', kind: 'essential' },
  { name: 'Childcare & Education', kind: 'essential' },
  { name: 'Dining Out', kind: 'discretionary' },
  { name: 'Shopping', kind: 'discretionary' },
  { name: 'Entertainment', kind: 'discretionary' },
  { name: 'Subscriptions', kind: 'discretionary' },
  { name: 'Travel', kind: 'discretionary' },
  { name: 'Personal Care', kind: 'discretionary' },
  { name: 'Gifts & Donations', kind: 'discretionary' },
  { name: 'Fees & Charges', kind: 'discretionary' },
  { name: 'Other', kind: 'discretionary' },
];

const KIND = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.kind]));
const isCategory = (name) => Object.hasOwn(KIND, name);
const kindOf = (name) => KIND[name] || 'discretionary';

// Plaid personal_finance_category -> our categories.
const PLAID_DETAILED = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  RENT_AND_UTILITIES_RENT: 'Housing',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Transfer',
  GENERAL_SERVICES_INSURANCE: 'Insurance',
  GENERAL_SERVICES_CHILDCARE: 'Childcare & Education',
  GENERAL_SERVICES_EDUCATION: 'Childcare & Education',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Gifts & Donations',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'Gifts & Donations',
  ENTERTAINMENT_TV_AND_MOVIES: 'Subscriptions',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'Subscriptions',
};
const PLAID_PRIMARY = {
  INCOME: 'Income',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  LOAN_PAYMENTS: 'Debt Payments',
  BANK_FEES: 'Fees & Charges',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Dining Out',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Housing',
  MEDICAL: 'Healthcare',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Other',
  GOVERNMENT_AND_NON_PROFIT: 'Other',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Utilities',
};

// Keyword rules, used for CSV imports and to refine bank categories.
// Checked in order; first match wins. Matched against "name merchant", lowercased.
const KEYWORD_RULES = [
  [/payroll|direct dep|salary|paycheck|\bdeposit from\b.*(inc|llc)|interest paid|dividend/, 'Income'],
  [/transfer|xfer|zelle to self|to savings|from savings|credit card payment|autopay payment|payment thank you|card payment/, 'Transfer'],
  [/netflix|spotify|hulu|disney\+|disney plus|hbo|max\.com|youtube premium|apple\.com\/bill|icloud|amazon prime|audible|patreon|peacock|paramount\+|adobe|dropbox|chatgpt|openai|claude\.ai/, 'Subscriptions'],
  [/\brent\b|mortgage|property mgmt|apartments|hoa\b/, 'Housing'],
  [/electric|power co|energy|water|sewer|gas co|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet|utility/, 'Utilities'],
  [/whole foods|trader joe|safeway|kroger|aldi|costco|publix|wegmans|grocery|market|h-e-b|heb\b|food lion|sprouts/, 'Groceries'],
  [/uber(?! eats)|lyft|shell|chevron|exxon|bp\b|mobil|gas station|fuel|parking|transit|metro|toll|dmv/, 'Transportation'],
  [/geico|state farm|progressive|allstate|insurance|lemonade/, 'Insurance'],
  [/pharmacy|cvs|walgreens|doctor|dental|clinic|hospital|medical|optometr/, 'Healthcare'],
  [/student loan|navient|nelnet|sallie mae|loan pmt|auto loan/, 'Debt Payments'],
  [/doordash|uber eats|grubhub|restaurant|cafe|coffee|starbucks|chipotle|mcdonald|pizza|bar & grill|taco|sushi|diner|bistro/, 'Dining Out'],
  [/amazon|target|walmart|best buy|etsy|ebay|ikea|home depot|lowe'?s|nordstrom|macy/, 'Shopping'],
  [/cinema|amc|movie|theater|ticketmaster|steam|playstation|xbox|nintendo|concert|bowling/, 'Entertainment'],
  [/airline|delta air|united air|american air|southwest|airbnb|hotel|marriott|hilton|expedia|booking\.com/, 'Travel'],
  [/salon|barber|spa\b|gym|fitness|planet fitness/, 'Personal Care'],
  [/charity|donation|gofundme|red cross/, 'Gifts & Donations'],
  [/\bfees?\b|overdraft|\batm\b|interest charge/, 'Fees & Charges'],
];

function matchKeywords(text) {
  const t = text.toLowerCase();
  for (const [re, cat] of KEYWORD_RULES) if (re.test(t)) return cat;
  return null;
}

/**
 * Pick a category for a transaction.
 * Priority: user rules > keyword rules for subscriptions/transfers > Plaid category > keyword rules > sign.
 * @param {{name:string, merchant?:string, amount:number, plaid?:{primary?:string, detailed?:string}}} t
 * @param {{pattern:string, category:string}[]} userRules
 */
function categorize(t, userRules = []) {
  const text = `${t.name || ''} ${t.merchant || ''}`.toLowerCase();
  for (const r of userRules) {
    if (r.pattern && text.includes(r.pattern.toLowerCase())) return r.category;
  }
  const kw = matchKeywords(text);
  // Subscriptions are rarely labelled as such by banks, so the keyword wins there.
  if (kw === 'Subscriptions') return kw;
  if (t.plaid) {
    const fromPlaid = PLAID_DETAILED[t.plaid.detailed] || PLAID_PRIMARY[t.plaid.primary];
    if (fromPlaid && !(fromPlaid === 'Other' && kw)) return fromPlaid;
  }
  if (kw) {
    // A keyword that says "income" on an outflow (or vice-versa) is probably wrong.
    if (kw === 'Income' && t.amount < 0) return 'Other';
    return kw;
  }
  return t.amount > 0 ? 'Income' : 'Other';
}

module.exports = { CATEGORIES, KIND, isCategory, kindOf, categorize };

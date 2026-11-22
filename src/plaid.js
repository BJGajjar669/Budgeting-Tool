'use strict';

// Bank connections through Plaid (https://plaid.com) — supports 12,000+ US/CA/UK/EU institutions.
// Flow: link token -> user logs in with Plaid Link in the browser -> public token -> access token
// (stored encrypted) -> /transactions/sync pulls new, changed and removed transactions incrementally.

const { Configuration, PlaidApi, PlaidEnvironments, Products } = require('plaid/legacy');

function createPlaid({ clientId, secret, env = 'sandbox', countryCodes = ['US'], redirectUri, store, cipher, client: injected }) {
  if (!injected && (!clientId || !secret)) return null;
  if (!PlaidEnvironments[env]) throw new Error(`PLAID_ENV must be one of: ${Object.keys(PlaidEnvironments).join(', ')}`);

  const client = injected || new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret, 'Plaid-Version': '2020-09-14' } },
    }),
  );

  const token = (item) => cipher.decrypt(item.access_token_enc);

  async function createLinkToken({ itemId } = {}) {
    const req = {
      user: { client_user_id: 'budgify-local-user' },
      client_name: 'Budgify',
      country_codes: countryCodes,
      language: 'en',
    };
    if (itemId) {
      // "Update mode": re-authenticate an existing connection (e.g. after a password change).
      req.access_token = token(store.item(itemId));
    } else {
      req.products = [Products.Transactions];
      req.transactions = { days_requested: 730 };
    }
    if (redirectUri) req.redirect_uri = redirectUri;
    const { data } = await client.linkTokenCreate(req);
    return data.link_token;
  }

  async function exchange(publicToken, institution) {
    const { data } = await client.itemPublicTokenExchange({ public_token: publicToken });
    store.upsertItem({
      id: data.item_id,
      access_token_enc: cipher.encrypt(data.access_token),
      institution_id: institution?.institution_id,
      institution_name: institution?.name,
    });
    await syncItem(data.item_id);
    return data.item_id;
  }

  async function refreshAccounts(item, accessToken) {
    const { data } = await client.accountsGet({ access_token: accessToken });
    for (const a of data.accounts) {
      store.upsertAccount({
        id: a.account_id,
        item_id: item.id,
        source: 'plaid',
        institution_name: item.institution_name,
        name: a.name,
        official_name: a.official_name,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask,
        current_balance: a.balances.current,
        available_balance: a.balances.available,
        currency: a.balances.iso_currency_code || a.balances.unofficial_currency_code || 'USD',
      });
    }
  }

  const toRow = (t) => ({
    id: t.transaction_id,
    account_id: t.account_id,
    source: 'plaid',
    date: t.authorized_date && t.pending ? t.authorized_date : t.date,
    name: t.name,
    merchant: t.merchant_name,
    amount: -t.amount, // Plaid: positive = money out. Ours: negative = money out.
    pending: t.pending,
    plaid: t.personal_finance_category ? { primary: t.personal_finance_category.primary, detailed: t.personal_finance_category.detailed } : undefined,
  });

  async function syncItem(itemId) {
    const item = store.item(itemId);
    if (!item) throw new Error('Unknown connection');
    const accessToken = token(item);
    try {
      await refreshAccounts(item, accessToken);
      const startCursor = item.cursor || undefined;
      let attempt = 0;
      for (;;) {
        let cursor = startCursor;
        const added = [];
        const modified = [];
        const removed = [];
        try {
          let hasMore = true;
          while (hasMore) {
            const { data } = await client.transactionsSync({ access_token: accessToken, cursor, count: 500 });
            added.push(...data.added);
            modified.push(...data.modified);
            removed.push(...data.removed);
            hasMore = data.has_more;
            cursor = data.next_cursor;
          }
        } catch (err) {
          // Data changed mid-pagination: Plaid says restart from the original cursor.
          if (plaidErrorCode(err) === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt++ < 3) continue;
          throw err;
        }
        store.upsertTransactions([...added, ...modified].map(toRow));
        store.deleteTransactions(removed.map((r) => r.transaction_id));
        store.updateItemSync(itemId, { cursor, error: null });
        return { added: added.length, modified: modified.length, removed: removed.length };
      }
    } catch (err) {
      const code = plaidErrorCode(err);
      store.updateItemSync(itemId, { error: code || err.message });
      throw err;
    }
  }

  async function syncAll() {
    const results = [];
    for (const item of store.items()) {
      try {
        results.push({ item: item.id, institution: item.institution_name, ...(await syncItem(item.id)) });
      } catch (err) {
        results.push({ item: item.id, institution: item.institution_name, error: describePlaidError(err) });
      }
    }
    return results;
  }

  async function removeItem(itemId) {
    const item = store.item(itemId);
    if (!item) return;
    try {
      await client.itemRemove({ access_token: token(item) });
    } catch (err) {
      // Still forget it locally even if Plaid already dropped it.
      if (plaidErrorCode(err) !== 'ITEM_NOT_FOUND' && plaidErrorCode(err) !== 'INVALID_ACCESS_TOKEN') throw err;
    }
    store.deleteItem(itemId); // cascades to accounts -> transactions
  }

  /** Sandbox only: create a test connection without opening Plaid Link. */
  async function sandboxConnect(institutionId = 'ins_109508') {
    const { data } = await client.sandboxPublicTokenCreate({
      institution_id: institutionId,
      initial_products: [Products.Transactions],
    });
    return exchange(data.public_token, { institution_id: institutionId, name: 'Plaid Sandbox Bank' });
  }

  return { env, createLinkToken, exchange, syncItem, syncAll, removeItem, sandboxConnect };
}

function plaidErrorCode(err) {
  return err?.response?.data?.error_code;
}

function describePlaidError(err) {
  const d = err?.response?.data;
  if (d?.error_code) return `${d.error_code}: ${d.display_message || d.error_message}`;
  return err?.message || String(err);
}

module.exports = { createPlaid, describePlaidError, plaidErrorCode };

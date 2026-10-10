const KEY = 'texora_customer_order_draft_v1';

export function readCart() {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function writeCart(items) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export function clearCart() {
  try { sessionStorage.removeItem(KEY); return true; } catch { return false; }
}

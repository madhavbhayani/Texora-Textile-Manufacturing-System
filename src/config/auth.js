// The backend currently exposes no authentication routes. Wire these handlers to
// the approved customer auth API when its request/response contract is available.
const unavailable = () => Promise.reject(new Error('Authentication is not connected yet. Please contact your Texora administrator.'));
export const signIn = unavailable;
export const registerCustomer = unavailable;

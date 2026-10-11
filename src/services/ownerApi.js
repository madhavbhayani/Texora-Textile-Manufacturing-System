import { authenticatedRequest } from '../config/auth';

export const ownerApi = {
  get: (path) => authenticatedRequest(`/owner${path}`),
  send: (path, method = 'POST', body = {}) => authenticatedRequest(`/owner${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
};

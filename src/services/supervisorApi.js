import { authenticatedRequest } from '../config/auth';

export const supervisorApi = {
  get: (path) => authenticatedRequest(`/supervisor${path}`),
  send: (path, method, body) => authenticatedRequest(`/supervisor${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
};

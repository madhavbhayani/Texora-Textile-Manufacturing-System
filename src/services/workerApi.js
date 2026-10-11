import { authenticatedRequest } from '../config/auth';

export const workerApi = {
  get: (path) => authenticatedRequest(`/worker${path}`),
  send: (path, method='POST', body={}) => authenticatedRequest(`/worker${path}`, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
};

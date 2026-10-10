export const colors = {
  primary: '#5347CE', secondary: '#887CFD', info: '#4896FE', success: '#16C8C7', text: '#020617',
  background: '#F8FAFC', surface: '#FFFFFF', subtle: '#F1F5F9', border: '#E2E8F0',
  muted: '#64748B', secondaryText: '#334155', error: '#B42318', errorSurface: '#FEF3F2',
  warning: '#B54708', disabled: '#CBD5E1', placeholder: '#94A3B8', successText: '#0F766E',
  successSurface: 'rgba(22, 200, 199, .12)', successBorder: 'rgba(22, 200, 199, .32)',
  secondaryTint: 'rgba(136, 124, 253, .10)', secondarySelection: 'rgba(136, 124, 253, .25)', errorBorder: 'rgba(180, 35, 24, .16)',
  primaryHover: '#4438B5', focus: 'rgba(83, 71, 206, .22)',
};
export const colorVariables = Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--color-${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`, value]));

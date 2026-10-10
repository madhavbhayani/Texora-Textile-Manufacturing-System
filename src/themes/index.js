export { colors, colorVariables } from './colors';
export { typography } from './typography';
export { dimensions } from './dimensions';
export { shadows } from './shadows';
import { colorVariables } from './colors';
import { typography } from './typography';
import { dimensions } from './dimensions';
import { shadows } from './shadows';

export const themeVariables = {
  ...colorVariables,
  '--font-sans': typography.fontFamily,
  '--space-1': dimensions.space[1], '--space-2': dimensions.space[2], '--space-3': dimensions.space[3],
  '--space-4': dimensions.space[4], '--space-5': dimensions.space[5], '--space-6': dimensions.space[6], '--space-8': dimensions.space[8],
  '--input-height': dimensions.inputHeight, '--button-height': dimensions.buttonHeight,
  '--radius': dimensions.radius, '--radius-small': dimensions.radiusSmall, '--content-width': dimensions.contentWidth,
  '--shadow-card': shadows.card,
};

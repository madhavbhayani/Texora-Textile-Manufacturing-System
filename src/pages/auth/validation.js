const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateLogin(values) {
  const errors = {};
  const identifier = values.email.trim();
  if (!identifier) errors.email = 'Enter your email address or phone number.';
  else if (identifier.includes('@') ? !emailPattern.test(identifier) : !/^\+?[0-9]{10,15}$/.test(identifier.replace(/[\s().-]/g, ''))) errors.email = 'Enter a valid email address or phone number.';
  if (!values.password) errors.password = 'Enter your password.';
  return errors;
}
export function validateSignup(values) {
  const errors = {};
  if (!values.company.trim()) errors.company = 'Enter your business name.';
  if (!values.fullName.trim()) errors.fullName = 'Enter your full name.';
  if (!values.email.trim()) errors.email = 'Enter your business email.';
  else if (!emailPattern.test(values.email.trim())) errors.email = 'Enter a valid email address.';
  const phone = values.phone.replace(/[\s().+-]/g, '');
  if (!values.phone.trim()) errors.phone = 'Enter your contact phone number.';
  else if (!/^\d{7,15}$/.test(phone)) errors.phone = 'Enter a valid phone number (7–15 digits).';
  if (!values.password) errors.password = 'Create a password.';
  else if (values.password.length < 8) errors.password = 'Use at least 8 characters.';
  if (!values.confirmPassword) errors.confirmPassword = 'Confirm your password.';
  else if (values.password !== values.confirmPassword) errors.confirmPassword = 'Passwords do not match.';
  if (!values.agreed) errors.agreed = 'Please accept the terms and privacy policy.';
  return errors;
}

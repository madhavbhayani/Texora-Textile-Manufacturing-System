import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import Brand from '../../components/auth/Brand';
import Field from '../../components/auth/Field';
import { registerCustomer } from '../../config/auth';
import { validateSignup } from './validation';

const initialValues = { company: '', fullName: '', email: '', phone: '', password: '', confirmPassword: '', agreed: false };
function PasswordField({ id, label, value, onChange, error, autoComplete }) {
  const [visible, setVisible] = useState(false);
  return <Field id={id} label={label} error={error}><div className="password-wrap"><input id={id} name={id} type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={onChange} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
    <button className="visibility-toggle" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></Field>;
}
export default function Signup() {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const update = (event) => setValues({ ...values, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value });
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = validateSignup(values);
    setErrors(nextErrors); setFormError(''); setSuccess('');
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    try {
      await registerCustomer({ company: values.company.trim(), fullName: values.fullName.trim(), email: values.email.trim(), phone: values.phone.trim(), password: values.password, confirmPassword: values.confirmPassword });
      setSuccess('Your Texora customer account is ready.'); setValues(initialValues);
    } catch (error) { setFormError(error.message || 'We could not create your account. Please try again.'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page auth-page-signup"><section className="auth-card signup-card" aria-labelledby="signup-title">
    <Brand /><header className="auth-intro"><h1 id="signup-title">Create your Texora account</h1><p>Register your business as a Texora customer.</p></header>
    <form className="auth-form signup-form" onSubmit={submit} noValidate>
      <Field id="company" label="Company or business name" error={errors.company}><input id="company" name="company" autoComplete="organization" placeholder="Your business name" value={values.company} onChange={update} aria-invalid={Boolean(errors.company)} aria-describedby={errors.company ? 'company-error' : undefined} /></Field>
      <Field id="fullName" label="Contact person's full name" error={errors.fullName}><input id="fullName" name="fullName" autoComplete="name" placeholder="Full name" value={values.fullName} onChange={update} aria-invalid={Boolean(errors.fullName)} aria-describedby={errors.fullName ? 'fullName-error' : undefined} /></Field>
      <Field id="email" label="Business email" error={errors.email}><input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" value={values.email} onChange={update} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : undefined} /></Field>
      <Field id="phone" label="Contact phone number" error={errors.phone}><input id="phone" name="phone" type="tel" autoComplete="tel" placeholder="e.g. +91 98765 43210" value={values.phone} onChange={update} aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'phone-error' : undefined} /></Field>
      <PasswordField id="password" label="Password" value={values.password} onChange={update} error={errors.password} autoComplete="new-password" />
      <PasswordField id="confirmPassword" label="Confirm password" value={values.confirmPassword} onChange={update} error={errors.confirmPassword} autoComplete="new-password" />
      <div className="agreement-wrap"><label className="check-label agreement"><input type="checkbox" name="agreed" checked={values.agreed} onChange={update} aria-invalid={Boolean(errors.agreed)} aria-describedby={errors.agreed ? 'agreed-error' : undefined} /><span>I agree to Texora's Terms of Service and Privacy Policy.</span></label>{errors.agreed && <p className="field-error" id="agreed-error" role="alert">{errors.agreed}</p>}</div>
      {formError && <div className="form-alert" role="alert">{formError}</div>}{success && <div className="form-success" role="status">{success}</div>}
      <button className="primary-button" type="submit" disabled={busy}>{busy && <LoaderCircle className="spinner" size={18} aria-hidden="true" />}{busy ? 'Creating account…' : 'Create Account'}</button>
    </form>
    <p className="auth-footer">Already have an account? <Link to="/login">Sign in</Link></p>
  </section><p className="auth-caption">Texora customer registration is for buyer accounts. Staff accounts are provisioned by your administrator.</p></main>;
}

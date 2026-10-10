import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import Brand from '../../components/auth/Brand';
import Field from '../../components/auth/Field';
import { signIn } from '../../config/auth';
import { validateLogin } from './validation';

export default function Login() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ email: '', password: '', remember: false });
  const [errors, setErrors] = useState({});
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const update = (event) => setValues({ ...values, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value });
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = validateLogin(values);
    setErrors(nextErrors); setFormError('');
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    try { const result = await signIn({ email: values.email.trim(), password: values.password, remember: values.remember }); const role = result.user?.role; navigate(result.user?.mustChangePassword ? '/change-password' : role === 'BUYER' ? '/customer' : role === 'OWNER' ? '/owner' : role === 'STORE_MANAGER' ? '/store-manager' : role === 'SUPERVISOR' ? '/supervisor' : role === 'WORKER' ? '/worker' : role === 'DISPATCH_OFFICER' ? '/dispatch' : '/login'); }
    catch (error) { setFormError(error.message || 'We could not sign you in. Please try again.'); }
    finally { setBusy(false); }
  };

  return <main className="auth-page">
    <section className="auth-card" aria-labelledby="login-title">
      <Brand />
      <header className="auth-intro"><h1 id="login-title">Welcome back</h1><p>Sign in to continue to your Texora workspace.</p></header>
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field id="email" label="Email or phone number" error={errors.email}>
          <input id="email" name="email" type="text" autoComplete="username" placeholder="you@company.com or +91 98765 43210" value={values.email} onChange={update} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : undefined} />
        </Field>
        <Field id="password" label="Password" error={errors.password}>
          <div className="password-wrap"><input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={values.password} onChange={update} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? 'password-error' : undefined} /><button className="visibility-toggle" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
        </Field>
        <div className="form-options"><label className="check-label"><input type="checkbox" name="remember" checked={values.remember} onChange={update} />Remember me</label><button type="button" className="text-action" onClick={() => setFormError('Password recovery is not available yet. Please contact your Texora administrator.')}>Forgot password?</button></div>
        {formError && <div className="form-alert" role="alert">{formError}</div>}
        <button className="primary-button" type="submit" disabled={busy}>{busy && <LoaderCircle className="spinner" size={18} aria-hidden="true" />}{busy ? 'Signing in…' : 'Sign In'}</button>
      </form>
      <p className="auth-footer">New to Texora? <Link to="/signup">Create a customer account</Link></p>
    </section>
    <p className="auth-caption">One workspace for every step of your textile operations.</p>
  </main>;
}

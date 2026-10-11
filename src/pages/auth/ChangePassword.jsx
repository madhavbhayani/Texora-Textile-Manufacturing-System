import { useState } from 'react';
import { Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Brand from '../../components/auth/Brand';
import { authenticatedRequest } from '../../config/auth';
import './auth.css';

export default function ChangePassword({ user }) {
  const navigate = useNavigate();
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [visible, setVisible] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const update = (event) => setValues((state) => ({ ...state, [event.target.name]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (values.newPassword.length < 12) return setError('Choose a password with at least 12 characters.');
    if (values.newPassword.length > 72) return setError('Password must be 72 characters or fewer.');
    if (values.newPassword !== values.confirmPassword) return setError('The new passwords do not match.');
    if (values.newPassword === values.currentPassword) return setError('Your new password must be different from your current password.');
    setBusy(true);
    try {
      await authenticatedRequest('/auth/change-password', { method: 'POST', body: JSON.stringify({ ...(user?.mustChangePassword ? {} : { currentPassword: values.currentPassword }), newPassword: values.newPassword, confirmPassword: values.confirmPassword }), headers: { 'Content-Type': 'application/json' } });
      setSuccess(true);
      navigate('/login', { replace: true });
    } catch (e) { setError(e.message || 'Password could not be updated.'); }
    finally { setBusy(false); }
  };
  const field = (name, label, autocomplete, hint, required = true) => <label className="field password-change-field" key={name}><span>{label}</span><div className="password-wrap"><input id={name} name={name} type={visible[name] ? 'text' : 'password'} autoComplete={autocomplete} required={required} value={values[name]} onChange={update} aria-describedby={hint ? `${name}-hint` : undefined} minLength={name === 'newPassword' ? 12 : undefined} maxLength={name === 'newPassword' ? 72 : undefined}/><button className="visibility-toggle" type="button" aria-label={`${visible[name] ? 'Hide' : 'Show'} ${label.toLowerCase()}`} onClick={() => setVisible((state) => ({ ...state, [name]: !state[name] }))}>{visible[name] ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div>{hint && <small id={`${name}-hint`}>{hint}</small>}</label>;
  return <main className="auth-page"><section className="auth-card password-change-card"><Brand/><div className="password-change-badge"><LockKeyhole size={17}/><span>Account security</span></div><header className="auth-intro"><h1>{user?.mustChangePassword ? 'Set your password' : 'Update your password'}</h1><p>{user?.mustChangePassword ? 'Create a personal password to secure your account before entering the workspace.' : 'Choose a new password to secure your Texora account and continue to your workspace.'}</p></header><form className="auth-form" onSubmit={submit} noValidate>
    {!user?.mustChangePassword && field('currentPassword', 'Current password', 'current-password')}
    {field('newPassword', 'New password', 'new-password', 'Use 12–72 characters. A longer passphrase is easier to remember and harder to guess.')}
    {field('confirmPassword', 'Confirm new password', 'new-password')}
    {error && <div className="form-alert" role="alert">{error}</div>}{success && <div className="form-success" role="status"><ShieldCheck size={16}/> Password updated successfully.</div>}
    <button className="primary-button" disabled={busy}>{busy ? 'Updating password…' : 'Update password'}</button>
  </form><p className="password-change-note"><LockKeyhole size={14}/> Your password is sent securely to Texora and is never shown in error messages.</p></section></main>;
}

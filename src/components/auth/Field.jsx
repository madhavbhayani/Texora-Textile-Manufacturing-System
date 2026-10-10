export default function Field({ id, label, error, children, className = '' }) {
  const errorId = `${id}-error`;
  return <div className={`field ${className}`}>
    <label htmlFor={id}>{label}</label>
    {children}
    {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
  </div>;
}

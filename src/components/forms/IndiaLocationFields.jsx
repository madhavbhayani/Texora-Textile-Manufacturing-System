import { citiesByState, states } from '../../assets/citiesData';

export default function IndiaLocationFields({ state, city, onStateChange, onCityChange, className = 'location-fields-row' }) {
  const cities = state ? (citiesByState[state] || []) : [];
  return <div className={className}>
    <label>State / union territory
      <select name="state" autoComplete="address-level1" value={state} onChange={(event) => { onStateChange(event.target.value); onCityChange(''); }} required>
        <option value="">Select state or union territory</option>
        {states.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    <label>City
      <select name="city" autoComplete="address-level2" value={city} onChange={(event) => onCityChange(event.target.value)} required disabled={!state}>
        <option value="">{state ? 'Select city' : 'Select state first'}</option>
        {cities.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
  </div>;
}

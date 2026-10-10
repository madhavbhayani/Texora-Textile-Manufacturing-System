import { Boxes } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Brand() {
  return <Link className="brand" to="/" aria-label="Texora home"><span className="brand-mark"><Boxes size={20} strokeWidth={2.4} /></span><span>texora</span></Link>;
}

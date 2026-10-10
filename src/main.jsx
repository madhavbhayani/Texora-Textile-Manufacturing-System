import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { themeVariables } from './themes/index.js'

Object.entries(themeVariables).forEach(([name, value]) => {
  document.documentElement.style.setProperty(name, value)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

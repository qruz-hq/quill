import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './scratchpad.css'
import Scratchpad from './Scratchpad'

createRoot(document.getElementById('root')!).render(
  <StrictMode><Scratchpad /></StrictMode>
)
